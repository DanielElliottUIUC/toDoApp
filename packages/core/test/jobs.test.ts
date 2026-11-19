import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { LocalKeyService } from "../src/crypto/key-service";
import { withUser } from "../src/db/user-context";
import { JobRejectedError, runTick, type DueRun, type JobStarter } from "../src/jobs/dispatcher";
import { JobFailure, runJob } from "../src/jobs/run";
import { createPerson, createTestDb, expectPgError, type TestDb } from "./helpers/db";

const keys = new LocalKeyService(crypto.randomBytes(32), { NODE_ENV: "test" });
let db: TestDb;
beforeAll(async () => { db = await createTestDb(); });
afterAll(async () => db.close());

/** A job runner that accepts everything and remembers what it was asked to start. */
function recorder(): JobStarter & { started: DueRun[] } {
  const started: DueRun[] = [];
  return { started, async start(run) { started.push(run); return { externalRunId: "run_" + started.length }; } };
}

/** Removes the default batch schedules so each test controls exactly what is due. */
async function personWithJob(jobType: string, nextRun: string, opts: { local?: string; lateness?: string } = {}) {
  const id = await createPerson(db);
  await db.admin.query("delete from job_schedules where user_id = $1", [id]);
  await db.admin.query(
    `insert into job_schedules (user_id, job_type, local_time, next_run_at, max_lateness)
     values ($1, $2, $3, $4, $5::interval)`,
    [id, jobType, opts.local ?? "07:30", nextRun, opts.lateness ?? "3 hours"]);
  return id;
}
const runsFor = async (id: string) =>
  (await db.admin.query("select status, attempts, last_error_code, external_run_id from job_runs where user_id = $1 order by scheduled_for", [id])).rows;
const nextRun = async (id: string) =>
  ((await db.admin.query("select next_run_at from job_schedules where user_id = $1", [id])).rows[0].next_run_at as Date).toISOString();

beforeEach(async () => {
  await db.admin.query("delete from job_runs");
  await db.admin.query("delete from job_schedules");
});

describe("the tick", () => {
  // 13:30 UTC on 18 November 2026 is 07:30 in Chicago.
  const due = "2026-11-18T13:30:00Z";
  const now = new Date("2026-11-18T13:31:00Z");

  it("starts one run for each person who is due and moves their schedule to tomorrow", async () => {
    const a = await personWithJob("batch_morning", due);
    const b = await personWithJob("batch_morning", due);
    const notYet = await personWithJob("batch_morning", "2026-11-18T14:00:00Z");
    const starter = recorder();

    expect(await runTick(db.dispatcher, starter, now)).toEqual({ due: 2, started: 2, rejected: 0 });
    expect(starter.started.map((r) => r.userId).sort()).toEqual([a, b].sort());
    expect(starter.started[0]).toMatchObject({ jobType: "batch_morning", scheduledFor: new Date(due) });
    expect(await runsFor(a)).toMatchObject([{ status: "triggered", attempts: 0 }]);
    expect(await runsFor(notYet)).toEqual([]);
    expect(await nextRun(a)).toBe("2026-11-19T13:30:00.000Z");
  });

  it("gives each run an idempotency key of person, job and scheduled time", async () => {
    const a = await personWithJob("batch_morning", due);
    const starter = recorder();
    await runTick(db.dispatcher, starter, now);
    expect(starter.started[0]!.idempotencyKey).toBe(`${a}:batch_morning:2026-11-18T13:30:00Z`);
  });

  it("does not start the same run twice when ticks repeat", async () => {
    await personWithJob("batch_morning", due);
    const starter = recorder();
    await runTick(db.dispatcher, starter, now);
    expect(await runTick(db.dispatcher, starter, new Date("2026-11-18T13:32:00Z"))).toEqual({ due: 0, started: 0, rejected: 0 });
    expect(starter.started).toHaveLength(1);
  });

  it("does not start the same run twice when two ticks overlap", async () => {
    const a = await personWithJob("batch_morning", due);
    const starter = recorder();
    await Promise.all([runTick(db.dispatcher, starter, now), runTick(db.dispatcher, starter, now)]);
    // Both ticks may hand the run to the job runner, but with the same key, so the runner starts it once;
    // the database records one run, triggered once.
    expect(new Set(starter.started.map((r) => r.idempotencyKey)).size).toBe(1);
    expect(await runsFor(a)).toHaveLength(1);
    expect(await nextRun(a)).toBe("2026-11-19T13:30:00.000Z");
  });

  it("catches up a run that an earlier tick missed", async () => {
    const a = await personWithJob("batch_morning", due);
    const starter = recorder();
    // No tick ran for forty minutes.
    await runTick(db.dispatcher, starter, new Date("2026-11-18T14:10:00Z"));
    expect(starter.started.map((r) => r.userId)).toEqual([a]);
    expect(await nextRun(a)).toBe("2026-11-19T13:30:00.000Z");
  });

  it("keeps a refused run waiting, does not move the schedule, and retries on the next tick", async () => {
    const a = await personWithJob("batch_morning", due);
    const refusing: JobStarter = { async start() { throw new JobRejectedError("out_of_credit"); } };
    expect(await runTick(db.dispatcher, refusing, now)).toEqual({ due: 1, started: 0, rejected: 1 });
    expect(await runsFor(a)).toMatchObject([{ status: "pending", attempts: 1, last_error_code: "out_of_credit" }]);
    expect(await nextRun(a)).toBe(new Date(due).toISOString());

    const starter = recorder();
    expect(await runTick(db.dispatcher, starter, new Date("2026-11-18T13:33:00Z"))).toMatchObject({ started: 1 });
    expect(await runsFor(a)).toMatchObject([{ status: "triggered", attempts: 1, external_run_id: "run_1" }]);
  });

  it("records an unexpected failure to start without recording its message", async () => {
    const a = await personWithJob("batch_morning", due);
    const broken: JobStarter = { async start() { throw new Error("socket hang up: secret detail"); } };
    await runTick(db.dispatcher, broken, now);
    expect(await runsFor(a)).toMatchObject([{ status: "pending", attempts: 1, last_error_code: "start_failed" }]);
  });

  it("expires a run that is too late to be worth sending, and moves the schedule on", async () => {
    const a = await personWithJob("batch_morning", due, { lateness: "3 hours" });
    const starter = recorder();
    // Nothing ran until 5pm Chicago.
    expect(await runTick(db.dispatcher, starter, new Date("2026-11-18T23:00:00Z"))).toEqual({ due: 0, started: 0, rejected: 0 });
    expect(await runsFor(a)).toMatchObject([{ status: "expired" }]);
    expect(await nextRun(a)).toBe("2026-11-19T13:30:00.000Z");
  });

  it("skips a person who has paused the agent, and picks them up when they resume", async () => {
    const a = await personWithJob("batch_morning", due);
    await db.admin.query("update profiles set agent_paused = true where user_id = $1", [a]);
    const starter = recorder();
    expect(await runTick(db.dispatcher, starter, now)).toMatchObject({ due: 0 });
    expect(await runsFor(a)).toEqual([]);
    await db.admin.query("update profiles set agent_paused = false where user_id = $1", [a]);
    expect(await runTick(db.dispatcher, starter, new Date("2026-11-18T13:35:00Z"))).toMatchObject({ started: 1 });
  });

  it("skips a schedule that is switched off", async () => {
    const a = await personWithJob("batch_morning", due);
    await db.admin.query("update job_schedules set enabled = false where user_id = $1", [a]);
    expect(await runTick(db.dispatcher, recorder(), now)).toMatchObject({ due: 0 });
  });

  it("honours the weekdays a schedule runs on", async () => {
    // 18 November 2026 is a Wednesday. A Sunday-only job next runs on the 22nd.
    const a = await personWithJob("weekly_review", due, { local: "07:30" });
    await db.admin.query("update job_schedules set days = '{7}' where user_id = $1", [a]);
    await runTick(db.dispatcher, recorder(), now);
    expect(await nextRun(a)).toBe("2026-11-22T13:30:00.000Z");
  });

  it("keeps the wall-clock time across a daylight-saving change", async () => {
    // Clocks in Chicago go forward on 14 March 2027: 07:30 moves from 13:30 UTC to 12:30 UTC.
    const a = await personWithJob("batch_morning", "2027-03-13T13:30:00Z");
    await runTick(db.dispatcher, recorder(), new Date("2027-03-13T13:31:00Z"));
    expect(await nextRun(a)).toBe("2027-03-14T12:30:00.000Z");
  });

  it("uses each person's own time zone", async () => {
    const a = await personWithJob("batch_morning", due);
    await db.admin.query("update profiles set timezone = 'America/Los_Angeles' where user_id = $1", [a]);
    await runTick(db.dispatcher, recorder(), now);
    expect(await nextRun(a)).toBe("2026-11-18T15:30:00.000Z"); // 07:30 Pacific, later the same day
  });

  it("hands over no more than the limit and leaves the rest for the next tick", async () => {
    for (let i = 0; i < 3; i++) await personWithJob("batch_morning", due);
    const starter = recorder();
    expect(await runTick(db.dispatcher, starter, now, { limit: 2 })).toMatchObject({ due: 2, started: 2 });
    expect(await runTick(db.dispatcher, starter, now, { limit: 2 })).toMatchObject({ due: 1, started: 1 });
  });
});

describe("the dispatcher's login", () => {
  it("can call its three functions and read no table", async () => {
    for (const table of ["profiles", "job_schedules", "job_runs", "audit_log", "user_keys", "outbound_messages", "invites"]) {
      const err = await expectPgError(() => db.dispatcher.query(`select * from ${table}`));
      expect(err.code, table).toBe("42501");
    }
  });

  it("cannot become a person", async () => {
    const err = await expectPgError(() => db.dispatcher.query("set role authenticated"));
    expect(err.code).toBe("42501");
  });

  it("gets back ids and job names and nothing else", async () => {
    await personWithJob("batch_morning", "2026-11-18T13:30:00Z");
    const r = await db.dispatcher.query("select * from claim_due_jobs($1)", [new Date("2026-11-18T13:31:00Z")]);
    expect(r.fields.map((f) => f.name)).toEqual(["run_id", "user_id", "job_type", "scheduled_for", "idempotency_key"]);
  });
});

describe("running a job", () => {
  async function triggeredRun() {
    const id = await personWithJob("batch_morning", "2026-11-18T13:30:00Z");
    const starter = recorder();
    await runTick(db.dispatcher, starter, new Date("2026-11-18T13:31:00Z"));
    return { userId: id, runId: starter.started[0]!.runId };
  }
  const auditFor = async (id: string) =>
    (await db.admin.query("select actor, action, meta from audit_log where user_id = $1 and action like 'job.%' order by id", [id])).rows;

  it("runs the work as that person, and records the start and finish in their audit log", async () => {
    const { userId, runId } = await triggeredRun();
    let seen: string[] = [];
    const outcome = await runJob(db.worker, keys, { userId, runId }, async (ctx) => {
      seen = (await ctx.db.query("select user_id from profiles")).rows.map((r) => r.user_id);
      expect(ctx.jobType).toBe("batch_morning");
    });
    expect(outcome).toBe("succeeded");
    expect(seen).toEqual([userId]);
    expect(await runsFor(userId)).toMatchObject([{ status: "succeeded", last_error_code: null }]);
    expect(await auditFor(userId)).toEqual([
      { actor: "agent", action: "job.started", meta: { job_type: "batch_morning" } },
      { actor: "agent", action: "job.finished", meta: { job_type: "batch_morning" } },
    ]);
  });

  it("unwraps the person's data key only if the job asks for it", async () => {
    const { userId, runId } = await triggeredRun();
    await runJob(db.worker, keys, { userId, runId }, async () => {});
    expect((await db.admin.query("select 1 from user_keys where user_id = $1", [userId])).rowCount).toBe(0);

    const second = await triggeredRun();
    await runJob(db.worker, keys, second, async (ctx) => { expect((await ctx.dataKey()).type).toBe("secret"); });
    expect((await db.admin.query("select 1 from user_keys where user_id = $1", [second.userId])).rowCount).toBe(1);
  });

  it("rolls the work back on failure but keeps the record, with a code and no message", async () => {
    const { userId, runId } = await triggeredRun();
    const outcome = await runJob(db.worker, keys, { userId, runId }, async (ctx) => {
      await ctx.db.query("update profiles set timezone = 'Europe/London' where user_id = $1", [userId]);
      throw new Error("the meeting with Dr Okafor could not be parsed");
    });
    expect(outcome).toBe("failed");
    expect((await db.admin.query("select timezone from profiles where user_id = $1", [userId])).rows[0].timezone).toBe("America/Chicago");
    expect(await runsFor(userId)).toMatchObject([{ status: "failed", last_error_code: "unexpected_error" }]);
    const log = await auditFor(userId);
    expect(log.at(-1)).toEqual({ actor: "agent", action: "job.failed", meta: { job_type: "batch_morning", error_code: "unexpected_error" } });
    expect(JSON.stringify(log)).not.toContain("Okafor");
  });

  it("records the code a job chose to fail with", async () => {
    const { userId, runId } = await triggeredRun();
    await runJob(db.worker, keys, { userId, runId }, async () => { throw new JobFailure("no_api_key"); });
    expect(await runsFor(userId)).toMatchObject([{ status: "failed", last_error_code: "no_api_key" }]);
  });

  it("does nothing if the person paused the agent after the run was started", async () => {
    const { userId, runId } = await triggeredRun();
    await db.admin.query("update profiles set agent_paused = true where user_id = $1", [userId]);
    let ran = false;
    expect(await runJob(db.worker, keys, { userId, runId }, async () => { ran = true; })).toBe("skipped_paused");
    expect(ran).toBe(false);
    expect((await auditFor(userId)).map((a) => a.action)).toEqual(["job.skipped_paused"]);
  });

  it("will not run the same run twice", async () => {
    const { userId, runId } = await triggeredRun();
    let count = 0;
    await runJob(db.worker, keys, { userId, runId }, async () => { count++; });
    expect(await runJob(db.worker, keys, { userId, runId }, async () => { count++; })).toBe("skipped_not_found");
    expect(count).toBe(1);
  });

  it("will not run one person's run under another person's id", async () => {
    const { runId } = await triggeredRun();
    const other = await createPerson(db);
    let ran = false;
    expect(await runJob(db.worker, keys, { userId: other, runId }, async () => { ran = true; })).toBe("skipped_not_found");
    expect(ran).toBe(false);
  });

  it("shows a job nothing of any other person", async () => {
    const { userId, runId } = await triggeredRun();
    const other = await createPerson(db);
    await runJob(db.worker, keys, { userId, runId }, async (ctx) => {
      expect((await ctx.db.query("select 1 from profiles where user_id = $1", [other])).rowCount).toBe(0);
      expect((await ctx.db.query("select 1 from job_schedules where user_id = $1", [other])).rowCount).toBe(0);
    });
  });

  // The worker serves everyone, so its login is able to scope itself to any one person: that is its job.
  // What row-level security guarantees is that it never sees two people at once, and that code which
  // forgets to scope sees nothing. A leaked worker login could still read rows one person at a time,
  // which is why content is also encrypted with keys the database does not hold.
  it("sees one person at a time even if it changes person inside a transaction", async () => {
    const userId = await createPerson(db);
    const other = await createPerson(db);
    await withUser(db.worker, userId, async (c) => {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: other })]);
      const rows = (await c.query("select user_id from profiles")).rows.map((r) => r.user_id);
      expect(rows).toEqual([other]); // it sees the other person only, never both
    });
  });
});
