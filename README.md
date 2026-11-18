# toDoApp

A personal life-ops app for a small invite-only group of family and friends. Each person gets one AI agent with a chief-of-staff character that plans their tasks, prepares work, reminds them and pushes back when they overcommit.

**Status:** specification complete, nothing built yet. The first work is the technical spikes listed in the build brief.

## What it does

- **Tasks and goals:** long-term goals feed weekly objectives and daily tasks, with calendar blocks for the day's few must-do items.
- **Daily rhythm:** three message batches a day, a short check-in, and a weekly review the agent prepares.
- **Life modules:** gym tracking, food logging, saved links, and a digest of research papers, news headlines and poetry.
- **Built for missed weeks:** no streak counters or overdue piles; the app pauses itself after silence and makes coming back one step.

## Three surfaces, one agent

| Surface | Job |
|---|---|
| Desktop web app | Setup, long-horizon planning, weekly review |
| Telegram thread | Quick capture and reminders |
| Phone web app | Seeing and rearranging the day |

## Documents

- [`docs/build-brief.md`](docs/build-brief.md): the specification. Read this first.
- [`docs/design-research.md`](docs/design-research.md): the evidence and sources behind each decision.
- [`docs/decisions.md`](docs/decisions.md): technical decisions made during the build.
- [`CLAUDE.md`](CLAUDE.md): working rules and hard constraints for coding agents.

## Stack

Postgres on Supabase with row-level security, Trigger.dev for scheduled jobs, Cloudflare Email Routing for mail intake, a Telegram bot, and the Claude API. Each person pays for their own model usage.

## Setup

Not yet written. Secrets are read from environment variables and are never committed. Copy `.env.example` to `.env` and fill in the values as each service is set up.

## Licence

MIT. See [`LICENSE`](LICENSE).
