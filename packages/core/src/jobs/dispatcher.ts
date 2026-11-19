// The every-minute tick.
//
// "Who is due?" is a question for the database (job_schedules.next_run_at),
// so a tick that is missed, late or repeated heals itself: the next one sees
// everything still waiting. Each run carries an idempotency key made of the
// person, the job and the scheduled time, so the job runner will not start
// the same run twice even if two ticks overlap.
//
// The tick sees ids and job names. It never sees content.

import type { Pool } from "pg";

export interface DueRun {
  runId: string;
  userId: string;
  jobType: string;
  scheduledFor: Date;
  idempotencyKey: string;
}

/** Starts one run in the job runner. Throws if the runner will not accept it. */
export interface JobStarter {
  start(run: DueRun): Promise<{ externalRunId: string }>;
}

/** Thrown by a JobStarter to say why the runner refused. The code is logged; it must hold no content. */
export class JobRejectedError extends Error {
  constructor(readonly code: string) {
    super(`job runner refused the run: ${code}`);
    this.name = "JobRejectedError";
  }
}

export interface TickResult {
  due: number;
  started: number;
  rejected: number;
}

export interface TickOptions {
  /** Most runs to hand to the job runner in one tick. The rest wait for the next. */
  limit?: number;
  /** Runs started at once. */
  concurrency?: number;
}

/**
 * One tick. `pool` must be logged in as the dispatcher role, which can call
 * the three dispatcher functions and touch nothing else.
 */
export async function runTick(pool: Pool, starter: JobStarter, now: Date, options: TickOptions = {}): Promise<TickResult> {
  const { limit = 200, concurrency = 8 } = options;
  const claimed = await pool.query("select * from claim_due_jobs($1, $2)", [now, limit]);
  const due: DueRun[] = claimed.rows.map((r) => ({
    runId: r.run_id, userId: r.user_id, jobType: r.job_type,
    scheduledFor: r.scheduled_for, idempotencyKey: r.idempotency_key,
  }));

  const result: TickResult = { due: due.length, started: 0, rejected: 0 };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, async () => {
    while (next < due.length) {
      const run = due[next++]!;
      try {
        const { externalRunId } = await starter.start(run);
        // Only an accepted run moves the schedule on.
        await pool.query("select mark_job_triggered($1, $2, $3)", [run.runId, externalRunId, now]);
        result.started++;
      } catch (e) {
        const code = e instanceof JobRejectedError ? e.code : "start_failed";
        await pool.query("select mark_job_rejected($1, $2)", [run.runId, code]);
        result.rejected++;
      }
    }
  }));
  return result;
}
