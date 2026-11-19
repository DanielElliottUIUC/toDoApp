// The rules for when a message may go out. Pure functions: no database, no
// clock of their own, so every rule can be tested by itself.
//
// From the brief:
//   * Three scheduled batches a day at times the person sets.
//   * A soft cap of 5 and a hard cap of 10 messages a day.
//   * At most two messages a day may break out of a batch, and only for a
//     start cue the person set or an imminent calendar change.
//   * The afternoon batch stays silent when it has nothing to say.
//   * The quiet mode is one batch a day, not zero.
//
// How the caps are read here (recorded in docs/decisions.md):
//   * Caps count messages the app starts. A reply to something the person
//     just said is not counted and is never held.
//   * At the soft cap, breakouts stop and wait for the next batch.
//   * At the hard cap, nothing the app starts goes out until tomorrow's first batch.
//   * Quiet hours hold everything the app starts, except a start cue: the
//     person chose that time themselves.

export type Delivery = "reply" | "breakout" | "batch";
export type BreakoutReason = "start_cue" | "calendar_change";
export type BatchSlot = "morning" | "afternoon" | "evening";

/** Minutes after local midnight, 0 to 1439. */
export type LocalMinutes = number;

export interface MessagePrefs {
  softCap: number;
  hardCap: number;
  breakoutCap: number;
  quietStart: LocalMinutes;
  quietEnd: LocalMinutes;
  oneBatchADay: boolean;
  batchTimes: Record<BatchSlot, LocalMinutes>;
}

export interface DayCounts {
  /** Counted messages already sent today (batches and breakouts; never replies). */
  sent: number;
  /** Breakouts already sent today. */
  breakouts: number;
}

export interface Candidate {
  delivery: Delivery;
  breakoutReason?: BreakoutReason;
}

export type Decision =
  | { action: "send_now"; counted: boolean }
  | { action: "hold"; until: { slot: BatchSlot; day: "today" | "tomorrow" }; reason: HoldReason };

export type HoldReason = "batch_item" | "hard_cap" | "soft_cap" | "breakout_cap" | "quiet_hours";

const SLOTS: BatchSlot[] = ["morning", "afternoon", "evening"];

/** The batches this person actually gets: all three, or only the morning one in quiet mode. */
export function activeSlots(prefs: MessagePrefs): BatchSlot[] {
  return prefs.oneBatchADay ? ["morning"] : SLOTS;
}

export function inQuietHours(prefs: MessagePrefs, now: LocalMinutes): boolean {
  const { quietStart: s, quietEnd: e } = prefs;
  if (s === e) return false;
  return s < e ? now >= s && now < e : now >= s || now < e; // the second form spans midnight
}

/** The next batch at or after `now`, falling through to tomorrow's first. */
export function nextBatch(prefs: MessagePrefs, now: LocalMinutes): { slot: BatchSlot; day: "today" | "tomorrow" } {
  const slots = activeSlots(prefs).slice().sort((a, b) => prefs.batchTimes[a] - prefs.batchTimes[b]);
  const today = slots.find((s) => prefs.batchTimes[s] > now);
  return today ? { slot: today, day: "today" } : { slot: slots[0]!, day: "tomorrow" };
}

const firstBatchTomorrow = (prefs: MessagePrefs) => {
  const slots = activeSlots(prefs).slice().sort((a, b) => prefs.batchTimes[a] - prefs.batchTimes[b]);
  return { slot: slots[0]!, day: "tomorrow" as const };
};

/** What to do with one message that something wants to send right now. */
export function decide(candidate: Candidate, prefs: MessagePrefs, counts: DayCounts, now: LocalMinutes): Decision {
  if (candidate.delivery === "reply") return { action: "send_now", counted: false };

  if (counts.sent >= prefs.hardCap) {
    return { action: "hold", until: firstBatchTomorrow(prefs), reason: "hard_cap" };
  }
  if (candidate.delivery === "batch") {
    return { action: "hold", until: nextBatch(prefs, now), reason: "batch_item" };
  }

  // A breakout.
  if (counts.breakouts >= prefs.breakoutCap) {
    return { action: "hold", until: nextBatch(prefs, now), reason: "breakout_cap" };
  }
  if (counts.sent >= prefs.softCap) {
    return { action: "hold", until: nextBatch(prefs, now), reason: "soft_cap" };
  }
  if (inQuietHours(prefs, now) && candidate.breakoutReason !== "start_cue") {
    return { action: "hold", until: nextBatch(prefs, now), reason: "quiet_hours" };
  }
  return { action: "send_now", counted: true };
}

export type BatchDecision =
  | { send: true }
  | { send: false; reason: "not_active" | "empty" | "hard_cap" };

/**
 * Whether a batch goes out when its time comes. The morning and evening
 * messages carry the plan and the close, so they go even with nothing queued.
 * The afternoon slot exists only to carry queued items and is silent without them.
 */
export function shouldSendBatch(slot: BatchSlot, queuedItems: number, prefs: MessagePrefs, counts: DayCounts): BatchDecision {
  if (!activeSlots(prefs).includes(slot)) return { send: false, reason: "not_active" };
  if (counts.sent >= prefs.hardCap) return { send: false, reason: "hard_cap" };
  if (slot === "afternoon" && queuedItems === 0) return { send: false, reason: "empty" };
  return { send: true };
}

/** Wall-clock minutes after midnight in a time zone, and that zone's calendar date. */
export function localClock(at: Date, timeZone: string): { minutes: LocalMinutes; date: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
    date: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

export const toMinutes = (hhmm: string): LocalMinutes => {
  const m = /^(\d{2}):(\d{2})/.exec(hhmm);
  if (!m) throw new Error(`not a time: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
};
