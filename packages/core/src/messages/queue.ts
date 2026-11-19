// The outbound queue: where every message waits, encrypted, until the rules
// in policy.ts say it may go. Sending itself (Telegram, the in-app thread)
// arrives with the intake step; this file decides and records.

import { encryptField, type DataKey } from "../crypto/envelope";
import type { UserDb } from "../db/user-context";
import {
  decide, localClock, toMinutes,
  type BatchSlot, type BreakoutReason, type Candidate, type DayCounts, type Decision, type Delivery, type MessagePrefs,
} from "./policy";

export interface NewMessage {
  delivery: Delivery;
  breakoutReason?: BreakoutReason;
  lane?: "capture" | "reminder" | "digest";
  /** A fixed word naming the kind of message, for example "start_cue". Not content. */
  messageType: string;
  body: string;
}

export interface Enqueued {
  id: string;
  decision: Decision;
}

const BATCH_JOB: Record<string, BatchSlot> = {
  batch_morning: "morning", batch_afternoon: "afternoon", batch_evening: "evening",
};

/** Reads the person's caps, quiet hours and batch times. */
export async function loadPrefs(db: UserDb): Promise<{ prefs: MessagePrefs; timeZone: string }> {
  const p = (await db.query(
    `select m.soft_cap, m.hard_cap, m.breakout_cap, m.quiet_start::text, m.quiet_end::text, m.one_batch_a_day, pr.timezone
     from message_prefs m join profiles pr on pr.user_id = m.user_id where m.user_id = $1`, [db.userId])).rows[0];
  if (!p) throw new Error("this person has no message preferences");
  const times = await db.query(
    "select job_type, local_time::text from job_schedules where user_id = $1 and job_type = any($2)",
    [db.userId, Object.keys(BATCH_JOB)],
  );
  const batchTimes = { morning: toMinutes("07:30"), afternoon: toMinutes("15:00"), evening: toMinutes("20:30") };
  for (const t of times.rows) batchTimes[BATCH_JOB[t.job_type as string]!] = toMinutes(t.local_time);
  return {
    timeZone: p.timezone,
    prefs: {
      softCap: p.soft_cap, hardCap: p.hard_cap, breakoutCap: p.breakout_cap,
      quietStart: toMinutes(p.quiet_start), quietEnd: toMinutes(p.quiet_end),
      oneBatchADay: p.one_batch_a_day, batchTimes,
    },
  };
}

/** Counted messages sent so far on the person's own calendar day. */
export async function countsToday(db: UserDb, timeZone: string, now: Date): Promise<DayCounts> {
  const r = await db.query(
    `select count(*)::int as sent, count(*) filter (where delivery = 'breakout')::int as breakouts
     from outbound_messages
     where user_id = $1 and status = 'sent' and counted
       and (sent_at at time zone $2)::date = ($3::timestamptz at time zone $2)::date`,
    [db.userId, timeZone, now],
  );
  return { sent: r.rows[0].sent, breakouts: r.rows[0].breakouts };
}

/**
 * Puts a message in the queue and records what the rules decided. A message
 * that may go now is returned for the caller to send and then confirm with
 * markSent. A held message waits for its batch.
 */
export async function enqueue(db: UserDb, key: DataKey, message: NewMessage, now: Date): Promise<Enqueued> {
  const { prefs, timeZone } = await loadPrefs(db);
  const counts = await countsToday(db, timeZone, now);
  const candidate: Candidate = { delivery: message.delivery, breakoutReason: message.breakoutReason };
  const decision = decide(candidate, prefs, counts, localClock(now, timeZone).minutes);

  const id = (await db.query("select gen_random_uuid() as id")).rows[0].id as string;
  const body = await encryptField(key, { userId: db.userId, table: "outbound_messages", column: "body_enc", rowId: id }, message.body);
  await db.query(
    `insert into outbound_messages
       (id, user_id, delivery, breakout_reason, lane, message_type, body_enc, batch_slot, counted, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, db.userId, message.delivery, message.breakoutReason ?? null, message.lane ?? "reminder", message.messageType,
     body, decision.action === "hold" ? decision.until.slot : null, message.delivery !== "reply", now],
  );
  return { id, decision };
}

/** Records that a message went out, on which channel. Only then does it count toward the caps. */
export async function markSent(db: UserDb, id: string, channel: "telegram" | "in_app" | "web_push", now: Date): Promise<void> {
  const r = await db.query(
    "update outbound_messages set status = 'sent', channel = $2, sent_at = $3 where id = $1 and status = 'queued'",
    [id, channel, now],
  );
  if (r.rowCount !== 1) throw new Error("that message is not waiting to be sent");
}

/** The ids of everything waiting for a batch, oldest first. Earlier unsent slots roll into this one. */
export async function queuedForBatch(db: UserDb): Promise<string[]> {
  const r = await db.query(
    "select id from outbound_messages where user_id = $1 and status = 'queued' and batch_slot is not null order by created_at",
    [db.userId],
  );
  return r.rows.map((x) => x.id as string);
}
