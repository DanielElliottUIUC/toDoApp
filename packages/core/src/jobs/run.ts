// What the job runner does with one run it has been handed.
//
// The payload it receives is ids only. Everything else is fetched here, as
// that one person, inside one transaction. The start and the outcome are
// written to that person's audit log, and the person's "pause the agent"
// switch is honoured before any work begins.

import type { Pool } from "pg";
import { audit } from "../audit";
import type { DataKey } from "../crypto/envelope";
import type { KeyService } from "../crypto/key-service";
import { withUser, type UserDb } from "../db/user-context";
import { loadUserKey } from "../db/user-keys";

export interface JobPayload {
  runId: string;
  userId: string;
}

export interface JobContext {
  db: UserDb;
  runId: string;
  jobType: string;
  scheduledFor: Date;
  /** Unwraps the person's data key on first use. Jobs that read no content never touch the key service. */
  dataKey(): Promise<DataKey>;
}

export type JobOutcome = "succeeded" | "failed" | "skipped_paused" | "skipped_not_found";

/**
 * Errors a handler may throw to record why it failed. The code goes into the
 * database and the audit log, so it must be a short fixed word, never a
 * message that could contain content.
 */
export class JobFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "JobFailure";
  }
}

export async function runJob(
  pool: Pool,
  keys: KeyService,
  payload: JobPayload,
  handler: (ctx: JobContext) => Promise<void>,
): Promise<JobOutcome> {
  // Step 1: claim the run. A run that is not waiting (already done, or not this person's) is left alone.
  const claimed = await withUser(pool, payload.userId, async (db) => {
    const paused = (await db.query("select agent_paused from profiles where user_id = $1", [db.userId])).rows[0];
    const r = await db.query(
      `update job_runs set status = 'running', started_at = now()
       where id = $1 and status in ('pending', 'triggered') returning job_type, scheduled_for`,
      [payload.runId],
    );
    if (r.rowCount !== 1) return { outcome: "skipped_not_found" as const };
    if (!paused || paused.agent_paused) {
      await db.query("update job_runs set status = 'failed', finished_at = now(), last_error_code = 'agent_paused' where id = $1", [payload.runId]);
      await audit(db, { actor: "system", action: "job.skipped_paused", target: "job_runs", targetId: payload.runId });
      return { outcome: "skipped_paused" as const };
    }
    await audit(db, {
      actor: "agent", action: "job.started", target: "job_runs", targetId: payload.runId,
      meta: { job_type: r.rows[0].job_type },
    });
    return { outcome: "run" as const, jobType: r.rows[0].job_type as string, scheduledFor: r.rows[0].scheduled_for as Date };
  });
  if (claimed.outcome !== "run") return claimed.outcome;

  // Step 2: the work, in its own transaction so a failure rolls the work back but not the record of it.
  let failure: string | null = null;
  try {
    await withUser(pool, payload.userId, async (db) => {
      let key: Promise<DataKey> | undefined;
      await handler({
        db, runId: payload.runId, jobType: claimed.jobType, scheduledFor: claimed.scheduledFor,
        dataKey: () => (key ??= loadUserKey(db, keys)),
      });
    });
  } catch (e) {
    failure = e instanceof JobFailure ? e.code.slice(0, 64) : "unexpected_error";
  }

  // Step 3: the outcome.
  await withUser(pool, payload.userId, async (db) => {
    await db.query(
      "update job_runs set status = $2, finished_at = now(), last_error_code = $3 where id = $1",
      [payload.runId, failure ? "failed" : "succeeded", failure],
    );
    await audit(db, {
      actor: "agent", action: failure ? "job.failed" : "job.finished", target: "job_runs", targetId: payload.runId,
      meta: failure ? { job_type: claimed.jobType, error_code: failure } : { job_type: claimed.jobType },
    });
  });
  return failure ? "failed" : "succeeded";
}
