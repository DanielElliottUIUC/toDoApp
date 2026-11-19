import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { audit } from "../src/audit";
import {
  UnknownModelPriceError, computeCostUsd, priceFor, recordSpend, spendByDay, type ModelPrice,
} from "../src/billing/cost";
import { InvalidApiKeyError, describeApiKey, removeApiKey, saveApiKey, useApiKey } from "../src/billing/credentials";
import { LocalKeyService } from "../src/crypto/key-service";
import { withUser } from "../src/db/user-context";
import { loadUserKey } from "../src/db/user-keys";
import { createPerson, createTestDb, type TestDb } from "./helpers/db";

const keys = new LocalKeyService(crypto.randomBytes(32), { NODE_ENV: "test" });
// Synthetic. Shaped like a key so the shape check passes; it has never been issued by anyone.
const FAKE_KEY = "sk-ant-test-" + "0123456789abcdef".repeat(3) + "WXYZ";

const haiku: ModelPrice = {
  model: "claude-haiku-5-5", effectiveFrom: "2026-11-17",
  input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01,
  longPromptThreshold: 100_000,
  long: { input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05 },
  batchMultiplier: 0.5,
};
const sonnet: ModelPrice = {
  model: "claude-sonnet-5-5", effectiveFrom: "2026-11-17",
  input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1,
  longPromptThreshold: null, long: null, batchMultiplier: 0.5,
};

describe("cost arithmetic", () => {
  it("multiplies reported tokens by the price per million", () => {
    expect(computeCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, sonnet)).toBe(12);
    expect(computeCostUsd({ inputTokens: 1717, outputTokens: 269 }, haiku)).toBe(0.000306);
  });

  it("matches the per-email cost measured in the extraction spike", () => {
    // 109,840 input and 17,196 output tokens over 64 calls cost $0.0196.
    expect(computeCostUsd({ inputTokens: 109_840, outputTokens: 17_196 }, { ...haiku, longPromptThreshold: null, long: null }))
      .toBeCloseTo(0.0196, 4);
  });

  it("prices cache writes and cache reads separately", () => {
    expect(computeCostUsd({ inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 1_000_000 }, sonnet)).toBe(2.5);
    expect(computeCostUsd({ inputTokens: 0, outputTokens: 0, cacheWrite1hTokens: 1_000_000 }, sonnet)).toBe(4);
    expect(computeCostUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }, sonnet)).toBe(0.1);
  });

  it("halves the cost of a batch call", () => {
    expect(computeCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000, batch: true }, sonnet)).toBe(6);
  });

  it("uses the higher price once the whole prompt, cached or not, passes the threshold", () => {
    expect(computeCostUsd({ inputTokens: 100_000, outputTokens: 0 }, haiku)).toBe(0.01);
    expect(computeCostUsd({ inputTokens: 100_001, outputTokens: 0 }, haiku)).toBeCloseTo(0.050001, 6);
    // 60k fresh + 50k cached is 110k of prompt: long prices apply to all of it.
    expect(computeCostUsd({ inputTokens: 60_000, outputTokens: 1000, cacheReadTokens: 50_000 }, haiku))
      .toBeCloseTo((60_000 * 0.5 + 1000 * 2.5 + 50_000 * 0.05) / 1e6, 6);
  });

  it("costs nothing for no tokens and refuses nonsense counts", () => {
    expect(computeCostUsd({ inputTokens: 0, outputTokens: 0 }, sonnet)).toBe(0);
    expect(() => computeCostUsd({ inputTokens: -1, outputTokens: 0 }, sonnet)).toThrow();
    expect(() => computeCostUsd({ inputTokens: 1.5, outputTokens: 0 }, sonnet)).toThrow();
  });
});

describe("with the database", () => {
  let db: TestDb;
  beforeAll(async () => { db = await createTestDb(); });
  afterAll(async () => db.close());

  describe("the price table", () => {
    it("holds the four models the app routes to, at the confirmed prices", async () => {
      const id = await createPerson(db);
      const got = await withUser(db.worker, id, async (c) => ({
        haiku: await priceFor(c, "claude-haiku-5-5", new Date("2026-11-18")),
        sonnet: await priceFor(c, "claude-sonnet-5-5", new Date("2026-11-18")),
        opus: await priceFor(c, "claude-opus-5-5", new Date("2026-11-18")),
        fable: await priceFor(c, "claude-fable-5-2", new Date("2026-11-18")),
      }));
      expect(got.haiku).toEqual(haiku);
      expect(got.sonnet).toEqual(sonnet);
      expect(got.opus).toMatchObject({ input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 });
      expect(got.fable).toMatchObject({ input: 8, output: 40, cacheWrite5m: 10, cacheWrite1h: 16, cacheRead: 0.2 });
    });

    it("uses the price in force on the day of the call", async () => {
      const id = await createPerson(db);
      await db.admin.query(
        `insert into model_prices (model, effective_from, input_per_mtok, output_per_mtok, cache_write_5m_per_mtok, cache_write_1h_per_mtok, cache_read_per_mtok)
         values ('claude-sonnet-5-5', '2027-01-01', 1, 5, 1.25, 2, 0.05)`);
      const [before, after, tooEarly] = await withUser(db.worker, id, async (c) => [
        // The last second of the old price and the first second of the new one, in UTC.
        await priceFor(c, "claude-sonnet-5-5", new Date("2026-12-31T23:59:59Z")),
        await priceFor(c, "claude-sonnet-5-5", new Date("2027-01-01T00:00:00Z")),
        await priceFor(c, "claude-sonnet-5-5", new Date("2026-01-01T00:00:00Z")),
      ]);
      expect(before?.input).toBe(2);
      expect(after?.input).toBe(1);
      expect(tooEarly).toBeNull();
    });
  });

  describe("the spend meter", () => {
    it("records each call and totals by day and job type in the person's own time zone", async () => {
      const id = await createPerson(db);
      await withUser(db.worker, id, async (c) => {
        // 03:00 UTC on the 19th is the evening of the 18th in Chicago.
        await recordSpend(c, "intake", "claude-haiku-5-5", { inputTokens: 1717, outputTokens: 269 }, new Date("2026-11-18T18:00:00Z"));
        await recordSpend(c, "intake", "claude-haiku-5-5", { inputTokens: 1717, outputTokens: 269 }, new Date("2026-11-19T03:00:00Z"));
        await recordSpend(c, "planning", "claude-sonnet-5-5", { inputTokens: 10_000, outputTokens: 2_000 }, new Date("2026-11-18T18:00:00Z"));
        await recordSpend(c, "intake", "claude-haiku-5-5", { inputTokens: 1717, outputTokens: 269 }, new Date("2026-11-19T18:00:00Z"));
      });
      const meter = await withUser(db.worker, id, (c) => spendByDay(c, 100_000));
      expect(meter).toEqual([
        { day: "2026-11-19", jobType: "intake", calls: 1, costUsd: 0.000306 },
        { day: "2026-11-18", jobType: "intake", calls: 2, costUsd: 0.000612 },
        { day: "2026-11-18", jobType: "planning", calls: 1, costUsd: 0.04 },
      ]);
    });

    it("refuses to record a call for a model with no price, and does not record zero", async () => {
      const id = await createPerson(db);
      await expect(withUser(db.worker, id, (c) =>
        recordSpend(c, "intake", "some-future-model", { inputTokens: 10, outputTokens: 10 }, new Date())))
        .rejects.toBeInstanceOf(UnknownModelPriceError);
      expect((await db.admin.query("select 1 from spend_events where user_id = $1", [id])).rowCount).toBe(0);
    });
  });

  describe("a person's API key", () => {
    it("is stored encrypted, shown as its last four characters, and comes back intact for a call", async () => {
      const id = await createPerson(db);
      const saved = await withUser(db.worker, id, async (c) => saveApiKey(c, await loadUserKey(c, keys), "anthropic", `  ${FAKE_KEY}\n`));
      expect(saved).toEqual({ last4: "WXYZ" });

      const row = (await db.admin.query("select key_enc, key_last4 from provider_credentials where user_id = $1", [id])).rows[0];
      expect(row.key_last4).toBe("WXYZ");
      expect((row.key_enc as Buffer).toString("latin1")).not.toContain("sk-ant");

      expect(await withUser(db.worker, id, (c) => describeApiKey(c, "anthropic"))).toMatchObject({ last4: "WXYZ" });
      const used = await withUser(db.worker, id, async (c) => useApiKey(c, await loadUserKey(c, keys), "anthropic", "agent", "intake"));
      expect(used).toBe(FAKE_KEY);
    });

    it("writes saving, using and removing to the audit log, and never the key", async () => {
      const id = await createPerson(db);
      await withUser(db.worker, id, async (c) => {
        const k = await loadUserKey(c, keys);
        await saveApiKey(c, k, "anthropic", FAKE_KEY);
        await useApiKey(c, k, "anthropic", "agent", "morning_batch");
        expect(await removeApiKey(c, "anthropic")).toBe(true);
        expect(await removeApiKey(c, "anthropic")).toBe(false);
        expect(await useApiKey(c, k, "anthropic", "agent", "morning_batch")).toBeNull();
      });
      const log = (await db.admin.query(
        "select actor, action, meta from audit_log where user_id = $1 and action like 'credential.%' order by id", [id])).rows;
      expect(log).toEqual([
        { actor: "user", action: "credential.saved", meta: { provider: "anthropic" } },
        { actor: "agent", action: "credential.used", meta: { provider: "anthropic", purpose: "morning_batch" } },
        { actor: "user", action: "credential.removed", meta: { provider: "anthropic" } },
      ]);
      const everything = JSON.stringify((await db.admin.query("select * from audit_log where user_id = $1", [id])).rows);
      expect(everything).not.toContain("sk-ant");
      expect(everything).not.toContain("WXYZ");
    });

    it("replaces the old key when a new one is saved", async () => {
      const id = await createPerson(db);
      const second = FAKE_KEY.slice(0, -4) + "QRST";
      const used = await withUser(db.worker, id, async (c) => {
        const k = await loadUserKey(c, keys);
        await saveApiKey(c, k, "anthropic", FAKE_KEY);
        await saveApiKey(c, k, "anthropic", second);
        return useApiKey(c, k, "anthropic", "user", "test");
      });
      expect(used).toBe(second);
      expect((await db.admin.query("select count(*)::int as n from provider_credentials where user_id = $1", [id])).rows[0].n).toBe(1);
    });

    it("refuses something that is plainly not a key, without repeating it", async () => {
      const id = await createPerson(db);
      for (const bad of ["", "hello", "sk-ant-short", "my password is hunter2 and it is long enough", `${FAKE_KEY} extra`]) {
        const err = await withUser(db.worker, id, async (c) => saveApiKey(c, await loadUserKey(c, keys), "anthropic", bad))
          .then(() => new Error("was accepted"), (e: Error) => e);
        expect(err).toBeInstanceOf(InvalidApiKeyError);
        expect(err.message).toBe("that does not look like an API key");
      }
    });

    it("cannot be opened by another person even if the row is copied to them", async () => {
      const a = await createPerson(db);
      const b = await createPerson(db);
      await withUser(db.worker, a, async (c) => saveApiKey(c, await loadUserKey(c, keys), "anthropic", FAKE_KEY));
      await withUser(db.worker, b, (c) => loadUserKey(c, keys));
      await db.admin.query(
        `insert into provider_credentials (user_id, provider, key_enc, key_last4)
         select $1, provider, key_enc, key_last4 from provider_credentials where user_id = $2`, [b, a]);
      await expect(withUser(db.worker, b, async (c) => useApiKey(c, await loadUserKey(c, keys), "anthropic", "agent", "x")))
        .rejects.toThrow("could not decrypt");
    });
  });

  describe("the audit log", () => {
    it("refuses anything that could be content", async () => {
      const id = await createPerson(db);
      await withUser(db.worker, id, async (c) => {
        await expect(audit(c, { actor: "agent", action: "task.read", meta: { title: "x".repeat(65) } })).rejects.toThrow(/content/);
        await expect(audit(c, { actor: "agent", action: "task.read", meta: { nested: { a: 1 } as never } })).rejects.toThrow(/plain value/);
        expect(await audit(c, { actor: "agent", action: "task.read", target: "tasks", meta: { count: 3, field: "title" } })).toBeGreaterThan(0);
      });
    });

    it("links an undo to the entry it reverses", async () => {
      const id = await createPerson(db);
      const [first, undo] = await withUser(db.worker, id, async (c) => {
        const one = await audit(c, { actor: "agent", action: "block.moved", target: "blocks" });
        return [one, await audit(c, { actor: "user", action: "block.move_undone", target: "blocks", undoOf: one })];
      });
      const row = (await db.admin.query("select undo_of from audit_log where id = $1", [undo])).rows[0];
      expect(Number(row.undo_of)).toBe(first);
    });

    it("rejects an actor that is not one of the four kinds", async () => {
      const id = await createPerson(db);
      await expect(withUser(db.worker, id, (c) => audit(c, { actor: "robot" as never, action: "x" }))).rejects.toThrow();
    });
  });
});
