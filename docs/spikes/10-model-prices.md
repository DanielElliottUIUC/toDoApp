# Spike 10: Model prices

Date: 2026-11-17. Method: read the official pricing page; one measured run from spike 8.

## Question

What is the current Claude API price table? The spend meter must not be built on the figures in the research file, where two researchers recorded different prices for the top model.

## What was tried

Read `https://platform.claude.com/docs/en/about-claude/pricing` in full, cross-checked the current models against `https://claude.com/pricing` and the model deprecations page, and re-read the rows for the four models this app routes to a second time.

## Result

US dollars per million tokens.

| Model | API id | Input | Output | Cache write 5 min | Cache write 1 h | Cache read | Batch in / out |
|---|---|---|---|---|---|---|---|
| Claude Haiku 5.5, prompt up to 100K tokens | `claude-haiku-5-5` | 0.10 | 0.50 | 0.125 | 0.20 | 0.01 | 0.05 / 0.25 |
| Claude Haiku 5.5, prompt over 100K tokens | same | 0.50 | 2.50 | 0.625 | 1.00 | 0.05 | 0.25 / 1.25 |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | 2 | 10 | 2.50 | 4 | 0.10 | 1 / 5 |
| Claude Opus 5.5 | `claude-opus-5-5` | 4 | 20 | 5 | 8 | 0.20 | 2 / 10 |
| Claude Fable 5.2 | `claude-fable-5-2` | 8 | 40 | 10 | 16 | 0.20 | 4 / 20 |

Older models still served (Opus 5, 4.8, 4.7, 4.6 at 5 / 25; Sonnet 5 at 2 / 10; Sonnet 4.6 at 3 / 15; Haiku 4.5 at 1 / 5; Fable 5.1 and 5 at 10 / 50) are not used by this app. Sonnet 4.5 retires on 30 November 2026.

**The disagreement, settled.** The top model, Claude Fable 5.2, is 8 / 40. The other figure, 10 / 50, is the row for Fable 5.1 and Fable 5. Fable 5.2 launched on 9 November 2026, so the two researchers most likely read different versions.

**Rules the spend meter has to implement**

- Cache writes cost 1.25 times input for 5 minutes and 2 times for 1 hour. Cache reads cost a fraction of input that differs by model (see the table); do not assume one multiplier.
- Haiku 5.5 has two price levels chosen per request by prompt length. All input, including cached input, counts toward the 100,000-token threshold.
- The Batch API is half price on input and output and stacks with caching.
- Asking for US-only inference multiplies every token price by 1.1. The default routing is standard price.
- Web search is $10 per 1,000 searches plus tokens. Web fetch has no extra charge.
- Current models count about 30 percent more tokens for the same text than models before Claude 4.7, so token estimates from old figures run low.
- Fable-class models require 30-day retention at Anthropic. That is a privacy difference, not a price one, and belongs beside the model picker.

**Measured.** In spike 8, one extraction call on Haiku 5.5 with a fixed output format cost $0.00026 at low effort and $0.00031 at medium effort per email (about 1,700 input and 180 to 270 output tokens). The research file's estimate of "well under a tenth of a cent" holds with room to spare.

## Decision

- Default routing: Haiku 5.5 for extraction and nightly consolidation, Sonnet 5.5 for planning and chat, Opus 5.5 for the weekly review. Fable 5.2 is offered as an option, not a default. Each person can change any of these.
- Prices live in one table in the database with an effective date, not in code. The spend meter multiplies each response's reported token counts (input, output, cache write, cache read) by that table. It never estimates from text length and never reads the Console.
- A scheduled check compares the stored table with the pricing page and tells the operator when they differ. It does not update prices by itself.
- Nightly consolidation uses the Batch API, since each person pays with their own key and the half price is available to them.

## Still open

Nothing blocks the build. Prices change; the effective-dated table is the answer to that.
