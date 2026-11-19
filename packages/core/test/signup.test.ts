import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { withUser } from "../src/db/user-context";
import { createPerson, createTestDb, expectPgError, invite, signUp, type TestDb } from "./helpers/db";

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); });
afterAll(async () => db.close());

const email = (label: string) => `${label}-${crypto.randomBytes(4).toString("hex")}@people.example`;

describe("invite-only sign-up", () => {
  it("refuses an address with no invitation", async () => {
    await expect(signUp(db, email("stranger"))).rejects.toThrow("invite-only");
  });

  it("refuses a request with no address at all", async () => {
    const r = await db.admin.query("select public.hook_before_user_created('{}'::jsonb) as v");
    expect(r.rows[0].v.error.http_code).toBe(403);
  });

  it("accepts an invited address, whatever its capitalisation", async () => {
    const e = email("invited");
    await invite(db, e);
    await expect(signUp(db, e.toUpperCase())).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it("uses an invitation once", async () => {
    const e = email("once");
    await invite(db, e);
    const id = await signUp(db, e);
    const inv = (await db.admin.query("select accepted_by, accepted_at from invites where email = $1", [e])).rows[0];
    expect(inv.accepted_by).toBe(id);
    expect(inv.accepted_at).not.toBeNull();
    const again = await db.admin.query("select public.hook_before_user_created($1::jsonb) as v", [JSON.stringify({ user: { email: e } })]);
    expect(again.rows[0].v.error.http_code).toBe(403);
  });

  it("refuses an expired invitation", async () => {
    const e = email("late");
    await db.admin.query("insert into invites (email, token_hash, expires_at) values ($1, $2, now() - interval '1 minute')", [e, crypto.randomBytes(32)]);
    await expect(signUp(db, e)).rejects.toThrow("invite-only");
  });

  it("refuses a revoked invitation", async () => {
    const e = email("revoked");
    await invite(db, e);
    await db.admin.query("update invites set revoked_at = now() where email = $1", [e]);
    await expect(signUp(db, e)).rejects.toThrow("invite-only");
  });

  it("allows only one open invitation per address", async () => {
    const e = email("twice");
    await invite(db, e);
    const err = await expectPgError(() => invite(db, e));
    expect(err.code).toBe("23505");
  });
});

describe("a new person", () => {
  it("starts with a profile, message preferences, three batch schedules and one audit entry", async () => {
    const id = await createPerson(db);
    const seen = await withUser(db.worker, id, async (c) => ({
      profile: (await c.query("select timezone, is_operator, agent_paused from profiles")).rows,
      prefs: (await c.query("select soft_cap, hard_cap, breakout_cap, one_batch_a_day from message_prefs")).rows,
      jobs: (await c.query("select job_type, local_time::text, enabled, next_run_at > now() as future from job_schedules order by local_time")).rows,
      audit: (await c.query("select actor, action from audit_log")).rows,
    }));
    expect(seen.profile).toEqual([{ timezone: "America/Chicago", is_operator: false, agent_paused: false }]);
    expect(seen.prefs).toEqual([{ soft_cap: 5, hard_cap: 10, breakout_cap: 2, one_batch_a_day: false }]);
    expect(seen.jobs).toEqual([
      { job_type: "batch_morning", local_time: "07:30:00", enabled: true, future: true },
      { job_type: "batch_afternoon", local_time: "15:00:00", enabled: true, future: true },
      { job_type: "batch_evening", local_time: "20:30:00", enabled: true, future: true },
    ]);
    expect(seen.audit).toEqual([{ actor: "system", action: "account.created" }]);
  });
});

describe("inviting", () => {
  it("is refused for an ordinary person", async () => {
    const id = await createPerson(db);
    const err = await expectPgError(() => withUser(db.worker, id, (c) =>
      c.query("select create_invite($1, $2)", [email("friend"), crypto.randomBytes(32)])));
    expect(err.code).toBe("42501");
    expect((await db.admin.query("select count(*)::int as n from invites where created_by = $1", [id])).rows[0].n).toBe(0);
  });

  it("works for an operator, stores only the token's hash, and is written to the operator's audit log", async () => {
    const op = await createPerson(db, "op");
    await db.admin.query("update profiles set is_operator = true where user_id = $1", [op]);
    const token = crypto.randomBytes(32);
    const hash = crypto.createHash("sha256").update(token).digest();
    const friend = email("Friend");
    const inviteId = await withUser(db.worker, op, async (c) =>
      (await c.query("select create_invite($1, $2) as id", [friend, hash])).rows[0].id as string);

    const stored = (await db.admin.query("select email, token_hash, created_by from invites where id = $1", [inviteId])).rows[0];
    expect(stored.email).toBe(friend.toLowerCase());
    expect((stored.token_hash as Buffer).equals(hash)).toBe(true);
    expect((stored.token_hash as Buffer).equals(token)).toBe(false);
    expect(stored.created_by).toBe(op);

    const log = await withUser(db.worker, op, (c) =>
      c.query("select actor, action, target_id, meta from audit_log where action = 'invite.created'"));
    expect(log.rows).toEqual([{ actor: "operator", action: "invite.created", target_id: inviteId, meta: {} }]);

    await expect(signUp(db, friend)).resolves.toBeTruthy();
  });

  it("lets the server find an open invitation by the token's hash, and nothing once it is used", async () => {
    const e = email("lookup");
    const hash = crypto.randomBytes(32);
    await db.admin.query("insert into invites (email, token_hash) values ($1, $2)", [e, hash]);
    const found = await db.admin.query("select * from invite_for_token($1)", [hash]);
    expect(found.rows.map((r) => r.email)).toEqual([e]);
    await signUp(db, e);
    expect((await db.admin.query("select * from invite_for_token($1)", [hash])).rowCount).toBe(0);
    expect((await db.admin.query("select * from invite_for_token($1)", [crypto.randomBytes(32)])).rowCount).toBe(0);
  });
});
