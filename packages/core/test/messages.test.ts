import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { decryptField } from "../src/crypto/envelope";
import { LocalKeyService } from "../src/crypto/key-service";
import { withUser } from "../src/db/user-context";
import { loadUserKey } from "../src/db/user-keys";
import {
  activeSlots, decide, inQuietHours, localClock, nextBatch, shouldSendBatch, toMinutes,
  type DayCounts, type MessagePrefs,
} from "../src/messages/policy";
import { countsToday, enqueue, loadPrefs, markSent, queuedForBatch } from "../src/messages/queue";
import { createPerson, createTestDb, type TestDb } from "./helpers/db";

const prefs = (over: Partial<MessagePrefs> = {}): MessagePrefs => ({
  softCap: 5, hardCap: 10, breakoutCap: 2,
  quietStart: toMinutes("22:00"), quietEnd: toMinutes("07:00"),
  oneBatchADay: false,
  batchTimes: { morning: toMinutes("07:30"), afternoon: toMinutes("15:00"), evening: toMinutes("20:30") },
  ...over,
});
const none: DayCounts = { sent: 0, breakouts: 0 };
const at = toMinutes;

describe("message rules", () => {
  describe("replies", () => {
    it("always go at once and are never counted, even at the hard cap and in quiet hours", () => {
      expect(decide({ delivery: "reply" }, prefs(), { sent: 10, breakouts: 2 }, at("23:30")))
        .toEqual({ action: "send_now", counted: false });
    });
  });

  describe("batch items", () => {
    it.each([
      ["06:00", "morning", "today"],
      ["07:30", "afternoon", "today"],
      ["12:00", "afternoon", "today"],
      ["16:00", "evening", "today"],
      ["21:00", "morning", "tomorrow"],
    ])("queued at %s wait for the %s batch %s", (time, slot, day) => {
      expect(decide({ delivery: "batch" }, prefs(), none, at(time)))
        .toEqual({ action: "hold", until: { slot, day }, reason: "batch_item" });
    });

    it("in quiet mode all wait for the single morning batch", () => {
      const p = prefs({ oneBatchADay: true });
      expect(activeSlots(p)).toEqual(["morning"]);
      expect(nextBatch(p, at("06:00"))).toEqual({ slot: "morning", day: "today" });
      expect(nextBatch(p, at("09:00"))).toEqual({ slot: "morning", day: "tomorrow" });
    });

    it("follow the person's own batch times, in whatever order they set them", () => {
      const p = prefs({ batchTimes: { morning: at("10:00"), afternoon: at("13:00"), evening: at("18:00") } });
      expect(nextBatch(p, at("09:00")).slot).toBe("morning");
      expect(nextBatch(p, at("12:59")).slot).toBe("afternoon");
      expect(nextBatch(p, at("18:00"))).toEqual({ slot: "morning", day: "tomorrow" });
    });
  });

  describe("breakouts", () => {
    it("go at once when under every cap and outside quiet hours", () => {
      expect(decide({ delivery: "breakout", breakoutReason: "calendar_change" }, prefs(), { sent: 1, breakouts: 0 }, at("11:00")))
        .toEqual({ action: "send_now", counted: true });
    });

    it("stop at two a day and fall into the next batch", () => {
      expect(decide({ delivery: "breakout", breakoutReason: "start_cue" }, prefs(), { sent: 3, breakouts: 2 }, at("11:00")))
        .toEqual({ action: "hold", until: { slot: "afternoon", day: "today" }, reason: "breakout_cap" });
    });

    it("stop at the soft cap of five messages", () => {
      expect(decide({ delivery: "breakout", breakoutReason: "start_cue" }, prefs(), { sent: 5, breakouts: 1 }, at("19:00")))
        .toEqual({ action: "hold", until: { slot: "evening", day: "today" }, reason: "soft_cap" });
    });

    it("for a calendar change are held through quiet hours", () => {
      expect(decide({ delivery: "breakout", breakoutReason: "calendar_change" }, prefs(), none, at("23:00")))
        .toEqual({ action: "hold", until: { slot: "morning", day: "tomorrow" }, reason: "quiet_hours" });
      expect(decide({ delivery: "breakout", breakoutReason: "calendar_change" }, prefs(), none, at("06:00")))
        .toEqual({ action: "hold", until: { slot: "morning", day: "today" }, reason: "quiet_hours" });
    });

    it("for a start cue the person set still fire in quiet hours", () => {
      expect(decide({ delivery: "breakout", breakoutReason: "start_cue" }, prefs(), none, at("06:15")))
        .toEqual({ action: "send_now", counted: true });
    });
  });

  describe("the hard cap", () => {
    it("holds everything the app starts until tomorrow's first batch", () => {
      const full: DayCounts = { sent: 10, breakouts: 0 };
      for (const c of [
        { delivery: "batch" as const },
        { delivery: "breakout" as const, breakoutReason: "start_cue" as const },
      ]) {
        expect(decide(c, prefs(), full, at("11:00")))
          .toEqual({ action: "hold", until: { slot: "morning", day: "tomorrow" }, reason: "hard_cap" });
      }
    });

    it("stops a batch from going out", () => {
      expect(shouldSendBatch("evening", 4, prefs(), { sent: 10, breakouts: 0 })).toEqual({ send: false, reason: "hard_cap" });
    });
  });

  describe("batches", () => {
    it("the afternoon slot stays silent when it has nothing to say", () => {
      expect(shouldSendBatch("afternoon", 0, prefs(), none)).toEqual({ send: false, reason: "empty" });
      expect(shouldSendBatch("afternoon", 1, prefs(), none)).toEqual({ send: true });
    });

    it("the morning and evening messages go even with nothing queued", () => {
      expect(shouldSendBatch("morning", 0, prefs(), none)).toEqual({ send: true });
      expect(shouldSendBatch("evening", 0, prefs(), none)).toEqual({ send: true });
    });

    it("quiet mode sends the morning batch only", () => {
      const p = prefs({ oneBatchADay: true });
      expect(shouldSendBatch("morning", 0, p, none)).toEqual({ send: true });
      expect(shouldSendBatch("afternoon", 3, p, none)).toEqual({ send: false, reason: "not_active" });
      expect(shouldSendBatch("evening", 3, p, none)).toEqual({ send: false, reason: "not_active" });
    });

    it("three batches and two breakouts exactly reach the soft cap", () => {
      let counts: DayCounts = { sent: 0, breakouts: 0 };
      for (const slot of ["morning", "afternoon", "evening"] as const) {
        expect(shouldSendBatch(slot, 1, prefs(), counts).send).toBe(true);
        counts = { ...counts, sent: counts.sent + 1 };
      }
      for (let i = 0; i < 2; i++) {
        expect(decide({ delivery: "breakout", breakoutReason: "start_cue" }, prefs(), counts, at("21:00")).action).toBe("send_now");
        counts = { sent: counts.sent + 1, breakouts: counts.breakouts + 1 };
      }
      expect(counts.sent).toBe(prefs().softCap);
      expect(decide({ delivery: "breakout", breakoutReason: "start_cue" }, prefs(), counts, at("21:30")).action).toBe("hold");
    });
  });

  describe("quiet hours", () => {
    it("span midnight", () => {
      const p = prefs();
      expect(["22:00", "23:59", "00:00", "06:59"].map((t) => inQuietHours(p, at(t)))).toEqual([true, true, true, true]);
      expect(["07:00", "12:00", "21:59"].map((t) => inQuietHours(p, at(t)))).toEqual([false, false, false]);
    });
    it("can sit inside one day, or be switched off by making start and end equal", () => {
      const nap = prefs({ quietStart: at("13:00"), quietEnd: at("14:00") });
      expect([inQuietHours(nap, at("13:30")), inQuietHours(nap, at("14:00"))]).toEqual([true, false]);
      expect(inQuietHours(prefs({ quietStart: at("00:00"), quietEnd: at("00:00") }), at("03:00"))).toBe(false);
    });
  });

  describe("local time", () => {
    it("reads the wall clock and date in the person's zone", () => {
      const t = new Date("2026-11-19T03:15:00Z");
      expect(localClock(t, "America/Chicago")).toEqual({ minutes: 21 * 60 + 15, date: "2026-11-18" });
      expect(localClock(t, "Asia/Tokyo")).toEqual({ minutes: 12 * 60 + 15, date: "2026-11-19" });
    });
    it("reads midnight as zero", () => {
      expect(localClock(new Date("2026-11-18T06:00:00Z"), "America/Chicago").minutes).toBe(0);
    });
  });
});

describe("the outbound queue", () => {
  const keys = new LocalKeyService(crypto.randomBytes(32), { NODE_ENV: "test" });
  let db: TestDb;
  beforeAll(async () => { db = await createTestDb(); });
  afterAll(async () => db.close());

  // 17:00 UTC on 18 November 2026 is 11:00 in Chicago.
  const eleven = new Date("2026-11-18T17:00:00Z");

  it("reads the person's caps, quiet hours and batch times", async () => {
    const id = await createPerson(db);
    await db.admin.query("update job_schedules set local_time = '08:15' where user_id = $1 and job_type = 'batch_morning'", [id]);
    const { prefs: p, timeZone } = await withUser(db.worker, id, loadPrefs);
    expect(timeZone).toBe("America/Chicago");
    expect(p).toEqual(prefs({ batchTimes: { morning: at("08:15"), afternoon: at("15:00"), evening: at("20:30") } }));
  });

  it("stores the body encrypted and holds a batch item for its slot", async () => {
    const id = await createPerson(db);
    const body = "Dentist moved to Thursday at 2:30";
    const out = await withUser(db.worker, id, async (c) =>
      enqueue(c, await loadUserKey(c, keys), { delivery: "batch", messageType: "intake_note", body }, eleven));
    expect(out.decision).toEqual({ action: "hold", until: { slot: "afternoon", day: "today" }, reason: "batch_item" });

    const row = (await db.admin.query("select * from outbound_messages where id = $1", [out.id])).rows[0];
    expect(row).toMatchObject({ status: "queued", batch_slot: "afternoon", counted: true, delivery: "batch", lane: "reminder" });
    expect((row.body_enc as Buffer).toString("latin1")).not.toContain("Dentist");
    const back = await withUser(db.worker, id, async (c) => decryptField(await loadUserKey(c, keys),
      { userId: id, table: "outbound_messages", column: "body_enc", rowId: out.id }, new Uint8Array(row.body_enc)));
    expect(back).toBe(body);
    expect(await withUser(db.worker, id, queuedForBatch)).toEqual([out.id]);
  });

  it("counts a message only once it has been sent, and never counts replies", async () => {
    const id = await createPerson(db);
    const send = (delivery: "reply" | "breakout", when: Date) => withUser(db.worker, id, async (c) => {
      const out = await enqueue(c, await loadUserKey(c, keys),
        { delivery, breakoutReason: delivery === "breakout" ? "start_cue" : undefined, messageType: "t", body: "x" }, when);
      if (out.decision.action === "send_now") await markSent(c, out.id, "in_app", when);
      return out.decision;
    });
    expect((await send("breakout", eleven)).action).toBe("send_now");
    expect((await send("reply", eleven)).action).toBe("send_now");
    expect(await withUser(db.worker, id, (c) => countsToday(c, "America/Chicago", eleven))).toEqual({ sent: 1, breakouts: 1 });

    expect((await send("breakout", eleven)).action).toBe("send_now");
    // The third breakout of the day is held for the next batch.
    expect(await send("breakout", eleven)).toEqual({ action: "hold", until: { slot: "afternoon", day: "today" }, reason: "breakout_cap" });
  });

  it("starts the count again on the person's next calendar day, not at midnight UTC", async () => {
    const id = await createPerson(db);
    await withUser(db.worker, id, async (c) => {
      const key = await loadUserKey(c, keys);
      const lateEvening = new Date("2026-11-19T03:30:00Z"); // 21:30 on the 18th in Chicago
      const out = await enqueue(c, key, { delivery: "breakout", breakoutReason: "start_cue", messageType: "t", body: "x" }, lateEvening);
      await markSent(c, out.id, "in_app", lateEvening);
      // 01:00 UTC on the 19th is still the 18th in Chicago; 14:00 UTC is the 19th.
      expect(await countsToday(c, "America/Chicago", new Date("2026-11-19T05:00:00Z"))).toEqual({ sent: 1, breakouts: 1 });
      expect(await countsToday(c, "America/Chicago", new Date("2026-11-19T14:00:00Z"))).toEqual({ sent: 0, breakouts: 0 });
    });
  });

  it("will not mark a message sent twice", async () => {
    const id = await createPerson(db);
    await withUser(db.worker, id, async (c) => {
      const out = await enqueue(c, await loadUserKey(c, keys), { delivery: "reply", messageType: "t", body: "x" }, eleven);
      await markSent(c, out.id, "telegram", eleven);
      await expect(markSent(c, out.id, "telegram", eleven)).rejects.toThrow("not waiting");
    });
  });
});
