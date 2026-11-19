# Spikes

One file per spike from `../build-brief.md`, named after the spike. Each records the question, what was tried, the result and the decision it leads to.

Run on 2026-11-17 and 2026-11-18, in the order the brief lists them.

| # | Spike | How it was run | Outcome in one line |
|---|---|---|---|
| 1 | [Linked billing](01-linked-billing.md) | Documentation | Not the launch route: capped at 10 people without an Anthropic review. Launch on each person's own key. |
| 2 | [Job runner](02-job-runner.md) | Documentation | The free plan rejects schedules faster than hourly. Keep the free plan and drive the tick from outside Trigger.dev. |
| 3 | [Encryption with row-level security](03-encryption-with-row-level-security.md) | Working prototype, 25 of 25 checks | Design proven. Top key in a key service, one data key per person, worker scoped to one person per transaction. |
| 4 | [iOS web push](04-ios-web-push.md) | Documentation, phone test outstanding | No action buttons on iPhone and no measured delivery rate. Push is a best-effort nudge; Telegram stays the reminder channel. |
| 5 | [Telegram on iPhone](05-telegram-on-iphone.md) | Documentation, phone test outstanding | Holds up as specified: buttons work, a bot cannot message first, lanes inside a private chat exist. |
| 6 | [Email chain](06-email-chain.md) | Documentation, mailbox test outstanding | Workable. Cloudflare drops some automatically forwarded mail before the app sees it. |
| 7 | [Calendar](07-calendar.md) | Documentation, phone test outstanding | The published feed is a next-day channel. Google Calendar needs no paid assessment. |
| 8 | [Extraction quality](08-extraction-quality.md) | 128 live model calls on synthetic mail | No hostile email altered a record. The model's own confidence is useless as a threshold. Real-mail tuning not done. |
| 9 | [Passkeys](09-passkeys.md) | Documentation | Supported but experimental. Passkey for daily sign-in, emailed six-digit code as the fallback. |
| 10 | [Model prices](10-model-prices.md) | Documentation | Table confirmed. The top model is $8 / $40 per million tokens. |
| 11 | [Poetry source](11-poetry-source.md) | Documentation and live requests | PoetryDB, imported once, with credit. Standard Ebooks as the fallback. |
| 12 | [News source](12-news-source.md) | Documentation and live requests | Publisher RSS carries launch at no cost. Most publishers' terms are personal-use and unclear for a shared app; the outlet list is the owner's call. |
| 13 | [Paper sources](13-paper-sources.md) | Documentation and live requests | arXiv first, then bioRxiv and medRxiv, then OpenAlex. Semantic Scholar on hold. |

The two prototypes live in `../../spikes/`. They are throwaway code with synthetic data and are not part of the app.

## What the spikes change in the brief

Agreed by the owner on 2026-11-18 and applied to `build-brief.md`.

| Brief said | Spike result | Brief now says |
|---|---|---|
| Try Anthropic linked billing first; fallback is each person's API key | Linked billing is capped at 10 people without a review (spike 1) | Each person's API key is the launch route; linked billing is a later option |
| Trigger.dev free tier; one dispatcher per job type fires every few minutes | The free plan rejects schedules faster than hourly (spike 2) | The tick comes from a Cloudflare Worker cron trigger; Trigger.dev runs each person's job |
| Passkeys, with an emailed magic link as fallback | A link opens in Safari, not the Home Screen app (spikes 4, 9) | Passkeys, with an emailed six-digit code as fallback |
| Web push on the phone | No action buttons, delivery unmeasured (spike 4) | Web push is a best-effort nudge; Telegram and the in-app thread carry anything that must be seen or answered |
| Each paper is shown with the source's own abstract | About 1 in 15 bioRxiv and medRxiv preprints has no reuse licence (spike 13) | Add: where the source's terms allow |
| Running cost about $25 a month plus a domain | A key service is about $1.21 a month (spike 3) | About $26 a month plus a domain |
| Research file: iOS 26 | The current system is iOS 27 (spike 4) | No change to the brief; phone tests run on iOS 27 |

## Waiting on the owner

| What | Why | Needed by |
|---|---|---|
| An AWS account, one key and one unwrap-only credential | The approved key service (spike 3) | Foundation step |
| The production domain name | Passkeys are tied to it permanently (spike 9) | Before anyone adds a passkey |
| The two Supabase values in `.env` moved under the right names | The secret key is currently in the entry named for the anon key (spike 3) | Foundation step |
| Hands-on tests with a phone and real mailboxes | Listed at the end of spikes 4, 5, 6, 7 and 9 | As each step comes up |

## Answered by the owner

| Date | Question | Answer |
|---|---|---|
| 2026-11-18 | One thread or three lanes in Telegram (spike 5) | One thread |
| 2026-11-18 | Whether anyone invited is under 18 (spike 1) | No |
| 2026-11-18 | AWS KMS at about $1.21 a month (spike 3) | Yes |
| 2026-11-18 | Tune extraction on his own forwarded mail (spike 8) | Yes, his own mail only |
| 2026-11-18 | Narrow or wide outlet list for news (spike 12) | Wide, without the New York Times and Nature |
| 2026-11-18 | Tick from a Cloudflare Worker or pay for Trigger.dev's Hobby plan (spike 2) | Cloudflare Worker for now |
| 2026-11-18 | The changes to the brief listed above | Agreed; applied to `build-brief.md` |
