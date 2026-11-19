# Spike 2: Job runner

Date: 2026-11-17. Method: read Trigger.dev's pricing page, documentation, status page and source repository (current release v4.8.5). Nothing was deployed.

## Question

Does Trigger.dev's free compute credit cover the group's daily runs? What happens on a missed tick?

## What was tried

Read `trigger.dev/pricing`, `trigger.dev/docs` (limits, scheduled tasks, run usage, wait, concurrency, idempotency, triggering, max duration, environment variables), the incident reports, and the schedule engine source in `triggerdotdev/trigger.dev`. The free-plan schedule rule, the headline finding, was re-read on the scheduled-tasks page by a second reader. Cloudflare's Workers limits page and Supabase's Cron page were read for the alternative tick source.

## Result

**The free plan cannot run the dispatcher as the brief describes it.** Since v4.6.0 (September 2026), "schedules created while an organization is on a free plan run no more than once per hour", and a schedule that fires more often is rejected when it is created or deployed. The rule also applies in development. An every-few-minutes dispatcher needs the Hobby plan.

| | Free | Hobby |
|---|---|---|
| Price | $0 | $10 a month |
| Monthly compute credit | $5 | $10 |
| Schedules | 10, hourly at most | 100, down to one minute |
| Concurrent runs | 20 | 50 |
| Log retention | 1 day | 7 days |
| When the credit runs out | New runs are rejected and scheduled ticks are skipped until upgrade. Nothing queues. | Runs continue and the excess is billed, with an optional billing limit |

**Compute prices**

- Smallest machine (micro): $0.0000169 per second. Default machine (small 1x): $0.0000338 per second.
- $0.000025 per run that starts.
- Start-up time is not billed. A delayed run costs nothing until it starts. A `wait` longer than 5 seconds is not billed, and neither is a parent waiting on a child run.
- Time spent awaiting an ordinary outbound request, such as a model call, is not a wait in that sense. The billing pages read as charging for it; one use-case page says the opposite. Treat it as billed until measured.

**Does $5 cover the group?** Estimate, on assumptions that are mine and unmeasured: per person per day, 3 message batches at 30 seconds each, 20 intake runs at 3 seconds each (spike 8 measured about 2 seconds per extraction call), and one consolidation run at 60 seconds, all on the micro machine with model waiting billed. That is about 210 billed seconds and 24 runs, or roughly $0.13 per person per month. Thirty people come to about $4; chat replies routed through the runner could double that. So the credit covers a small group comfortably and is marginal at thirty. The dispatcher itself is the expensive part if it lives in Trigger.dev: 8 job types ticking every 5 minutes cost $1.73 a month in run fees alone, plus $1.17 for every billed second per run.

**Missed ticks**

- There is no backfill. After an outage the schedule engine fires one late catch-up and does not replay the ticks in between.
- If the previous dispatcher run is still going when the next tick is due, a second run starts anyway. Nothing skips it.
- If the concurrency limit is hit, the run queues and starts late.
- The payload carries the nominal `timestamp` and the actual previous `lastTimestamp`, so a dispatcher can see a gap.
- New schedules get a 60-minute spread window by default and fire at a fixed offset inside each interval unless `window: "0m"` is set.
- No reliability guarantee or jitter bound is published. The status history shows a 19-minute schedule outage in January 2026 and most of a day without new runs in two regions in June 2026.

**Delayed runs (start cues)**

No maximum delay. A delayed run can be cancelled or rescheduled while it is still delayed, uses no compute or concurrency while waiting, and runs on whichever version is deployed when it starts. Idempotency keys are kept 30 days.

**Other limits**

No maximum run duration. One run at a time per person is supported (`concurrencyKey` with a per-key limit of 1). Development runs are not charged.

**Privacy and security findings**

- Run payloads and outputs are stored (in AWS us-east-1) and shown in the dashboard. No setting turns that off. Outbound requests are traced automatically.
- On 1 November 2026 Trigger.dev disclosed that an attacker read environment variables for 0.66 percent of customers through stolen root API keys.

## Decision

1. **Stay on the free plan and move the tick out of Trigger.dev.** The every-minute tick comes from a Cloudflare Worker cron trigger (free plan: 5 cron triggers, which is enough because one tick serves every job type). The tick asks Postgres which person-and-job pairs are due and starts one Trigger.dev run for each. Trigger.dev does only what it is good at: running each person's job in isolation with retries. This keeps the dispatcher pattern in the brief and adds no cost. Supabase Cron is the alternative tick source if the Worker proves awkward.
2. **Missed ticks heal themselves.** "Due" is a database question (`next_run <= now`), so any later tick picks up everything an earlier one missed. Each run is started with an idempotency key built from person, job type and the scheduled time, so an overlapping or repeated tick cannot start the same job twice. `next_run` advances only when the run is accepted.
3. **Postgres holds the queue.** If Trigger.dev rejects a run (credit exhausted, outage), the row stays pending and the operator is alerted. Nothing is lost and nothing depends on Trigger.dev queuing it.
4. **Payloads carry ids only.** A run receives a person id and a job id, fetches and decrypts content inside the run, returns only a status, and logs no content. Automatic request tracing is checked at the foundation step to confirm it records no bodies.
5. **Treat the runner's environment as exposable.** It gets a database login that cannot bypass row-level security and a key-service credential that can only unwrap. See spike 3.
6. **Use the micro machine** for every job unless a job proves it needs more.

## Revisit

Move to Hobby ($10 a month, which is beyond the running costs in the brief and so needs the owner's yes) if measured compute passes about $3.50 in a month, if the one-day log retention makes a fault impossible to diagnose, or if the external tick proves less reliable than a native schedule. This updates the "Trigger.dev free tier" row under "Flagged to revisit" in the brief.

## Still open

- Whether model waiting time is billed. Measure with `usage.getCurrent()` in the first deployed task at the foundation step.
- What the dashboard shows for a real run (payload, output, traced requests).
- The actual length of a near-empty run.
