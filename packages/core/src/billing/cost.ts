// The spend meter's arithmetic. The model never does this, and nothing here
// estimates: a cost is the token counts the provider reported for one call,
// multiplied by the price table in force that day.

import type { UserDb } from "../db/user-context";

/** One row of model_prices. Dollars per million tokens. */
export interface ModelPrice {
  model: string;
  effectiveFrom: string;
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  /** Prompts longer than this many tokens are charged at the `long` prices. */
  longPromptThreshold: number | null;
  long: { input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number } | null;
  batchMultiplier: number;
}

/** Token counts exactly as the provider reports them for one call. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  cacheReadTokens?: number;
  /** True when the call went through the half-price batch interface. */
  batch?: boolean;
}

const PER_MILLION = 1_000_000;

export function computeCostUsd(usage: Usage, price: ModelPrice): number {
  const cw5 = usage.cacheWrite5mTokens ?? 0;
  const cw1h = usage.cacheWrite1hTokens ?? 0;
  const cr = usage.cacheReadTokens ?? 0;
  for (const n of [usage.inputTokens, usage.outputTokens, cw5, cw1h, cr]) {
    if (!Number.isInteger(n) || n < 0) throw new Error("token counts must be whole numbers, zero or more");
  }
  // Every kind of input counts toward the long-prompt threshold, cached or not.
  const promptTokens = usage.inputTokens + cw5 + cw1h + cr;
  const rates = price.longPromptThreshold !== null && price.long && promptTokens > price.longPromptThreshold
    ? price.long
    : price;
  const dollars =
    (usage.inputTokens * rates.input +
      usage.outputTokens * rates.output +
      cw5 * rates.cacheWrite5m +
      cw1h * rates.cacheWrite1h +
      cr * rates.cacheRead) / PER_MILLION;
  // Stored to six decimal places, the precision of the spend_events column.
  return Math.round(dollars * (usage.batch ? price.batchMultiplier : 1) * 1e6) / 1e6;
}

/**
 * The price in force for a model at a given moment, or null if the model is
 * not in the table. A price takes effect at midnight UTC on its date, so the
 * answer does not depend on where the server or the person happens to be.
 */
export async function priceFor(db: UserDb, model: string, on: Date): Promise<ModelPrice | null> {
  const r = await db.query(
    `select *, effective_from::text as effective_from_text from model_prices
     where model = $1 and effective_from <= ($2::timestamptz at time zone 'UTC')::date
     order by effective_from desc limit 1`,
    [model, on],
  );
  const p = r.rows[0];
  if (!p) return null;
  const num = (v: unknown) => Number(v);
  return {
    model: p.model,
    effectiveFrom: p.effective_from_text,
    input: num(p.input_per_mtok), output: num(p.output_per_mtok),
    cacheWrite5m: num(p.cache_write_5m_per_mtok), cacheWrite1h: num(p.cache_write_1h_per_mtok),
    cacheRead: num(p.cache_read_per_mtok),
    longPromptThreshold: p.long_prompt_threshold,
    long: p.long_prompt_threshold === null ? null : {
      input: num(p.long_input_per_mtok), output: num(p.long_output_per_mtok),
      cacheWrite5m: num(p.long_cache_write_5m_per_mtok), cacheWrite1h: num(p.long_cache_write_1h_per_mtok),
      cacheRead: num(p.long_cache_read_per_mtok),
    },
    batchMultiplier: num(p.batch_multiplier),
  };
}

export class UnknownModelPriceError extends Error {
  constructor(readonly model: string) {
    super(`no price on file for model ${model}`);
    this.name = "UnknownModelPriceError";
  }
}

/**
 * Records what one model call cost. A model with no price on file is an
 * error, not a zero: a meter that silently reads low is worse than none.
 */
export async function recordSpend(db: UserDb, jobType: string, model: string, usage: Usage, at: Date): Promise<number> {
  const price = await priceFor(db, model, at);
  if (!price) throw new UnknownModelPriceError(model);
  const cost = computeCostUsd(usage, price);
  await db.query(
    `insert into spend_events
       (user_id, at, job_type, model, input_tokens, output_tokens,
        cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens, batch, cost_usd)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [db.userId, at, jobType, model, usage.inputTokens, usage.outputTokens,
     usage.cacheWrite5mTokens ?? 0, usage.cacheWrite1hTokens ?? 0, usage.cacheReadTokens ?? 0, usage.batch ?? false, cost],
  );
  return cost;
}

export interface SpendDay {
  day: string;
  jobType: string;
  calls: number;
  costUsd: number;
}

/** The meter itself: cost by day and job type, most recent first. */
export async function spendByDay(db: UserDb, days = 30): Promise<SpendDay[]> {
  const r = await db.query(
    `select day::text, job_type, calls, cost_usd from spend_daily
     where user_id = $1 and day > (now() at time zone 'UTC')::date - $2::int order by day desc, job_type`,
    [db.userId, days],
  );
  return r.rows.map((x) => ({ day: x.day, jobType: x.job_type, calls: x.calls, costUsd: Number(x.cost_usd) }));
}
