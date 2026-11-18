# Life-ops app: build brief

Date: 17 November 2026. Owner: Daniel Elliott.

This brief is the complete instruction set for building the app. Every decision in it is final unless it appears under "Flagged to revisit". The evidence and sources behind each decision are in the companion file `Life ops app design research.md`; where the two differ, this brief wins.

## How to work with the owner

- The owner answers **taste questions only**: how something should look, feel or behave for a person. Ask him those as short either/or choices with a recommendation.
- Make every technical decision yourself and record it in a decision log with a one-line reason.
- Do not give time or effort estimates.
- Stop and ask before anything that cannot be undone, that spends money beyond the running costs listed here, or that contradicts this brief.
- Ship something the owner can use daily as early as possible (see the build sequence), and prefer removing a feature to delaying that point.

## What it is

A personal life-management app for the owner and an invite-only group of 5 to 30 family members and friends. Everyone is in the US and uses an iPhone; some are not technical. Each person has one persistent AI agent with a chief-of-staff character that plans their tasks, prepares work, reminds them and pushes back when they overcommit. Every invited person gets the full agent.

**Design principle:** build around the weeks people miss. The app asks almost nothing on a bad day, never shows a pile of overdue items, pauses itself after silence, and makes coming back a single step.

## Three surfaces, one agent

| Surface | Job | Feel |
|---|---|---|
| Desktop web app | Setup, long-horizon planning, weekly review, intake triage, settings | Dense, fast, keyboard-first |
| Telegram thread | Quick capture, reminders, the three daily messages, check-in taps | Calm and sparse |
| Phone web app (added to the Home Screen) | Looking at and rearranging the day | Visual, direct manipulation |

All three talk to the same agent and the same data. An in-app chat thread mirrors Telegram and is the fallback. Diary and other sensitive text never goes through Telegram; the bot sends a link into the app.

## Modules

1. **Tasks and goals.** Long-term goals feed three to five weekly objectives, which feed daily tasks. The agent breaks tasks into subtasks. Only the day's one to three must-do items get a start cue and a first physical action ("after my 2pm lecture, I open the doc and write the first paragraph") and a calendar block.
2. **Load and pushback.** The app shows planned hours against available hours. Estimates are corrected by the person's own estimate-versus-actual history, per category, shown at the moment of estimating. That arithmetic is done in code; the model only chooses the words.
3. **Planning review.** The agent proposes every plan change as a reviewable list of changes with undo. Uncertain choices appear as judgement calls with options. Items with an explicit time never move, every block can be locked, and slack is left by default.
4. **Daily rhythm.** A morning message (plan, digest, check-in buttons), a mid-afternoon slot that stays silent when empty, and an evening close. A weekly review that the agent prepares, opens with what got done, asks three questions and blocks nothing if skipped.
5. **Check-in.** Inside the morning message: sleep quality 0 to 10, mood or energy on five points, soreness only the day after a logged workout.
6. **Gym.** The model proposes plan structure; fixed rules do progression and all load arithmetic. Log reps in reserve per working set. Readiness (sleep, mood or energy, soreness, last session's effort) nudges the day's session by one small step, is always overridable, and counts for little in the first weeks. Lighter weeks are triggered by stalled estimated max across two or more sessions plus several low-readiness days; they reduce volume and are never a full week off. Track weekly volume per muscle.
7. **Digest.** A scheduled task the person can see, retime, pause and switch off section by section. Sections: weather, calendar, today's tasks, research papers, news, poetry, and later forwarded newsletters.
   - **Research papers** come from several sources, arXiv among them (candidates: arXiv, OpenAlex, Semantic Scholar, bioRxiv and medRxiv, subject to each one's terms). Each paper is shown with its title, authors, link and the source's own abstract.
   - **News** is pulled programmatically, from publisher RSS feeds first and a news API where RSS falls short, by the topics the person chooses. Each item is shown as headline, outlet and link. The model does not summarise or rewrite news.
   - **Whitelisting is optional per person.** By default a person gets items from the full source set for their topics. They may turn on a whitelist of domains for papers, for news, or for both; when it is on, nothing from outside the list appears.
   - New items are fetched once nightly for everyone and ranked per person. Poetry uses public-domain poems unless a licensed source is confirmed.
8. **Saves.** Links and media saved from chat or a Shortcut. Unread items resurface on an expanding schedule to force a keep-or-drop decision; highlights resurface by weighted random sampling.
9. **Food.** Photo or one line of text. The model identifies items; the app suggests matches from the food database; the person confirms and edits the portion. Nutrients come from the database, never from the model. Numbers are hidden by default; no streaks, no "calories remaining", no comment at capture time. A weekly pattern review.
10. **Action reports.** Optional and one line by default; required only for must-do items and tasks that overran badly. The agent pre-fills estimate and actual. Each report is distilled into a lesson with a trigger condition ("when a task looks like X, do Y"), recording successes as well as failures. Lessons are retrieved when similar tasks are broken down, and the agent shows the lesson in use.
11. **Calendar and email intake.** See integrations.

## The agent

- **Bluntness dial, four levels, all of which still schedule the task.** Note (one line in the daily summary), Flag (says what is now at risk), Challenge (one question and a proposed trade), Argue (recommends against using the person's own history, needs "do it anyway", records the override). Default: Flag for invitees, Challenge for the owner. The agent never refuses to schedule. Evidence is always the person's own numbers, no sarcasm, one round at most, and the same objection is not repeated. The dial softens one level when the check-in shows poor sleep or low mood.
- **Autonomy presets, chosen at setup.** Cautious (asks before anything beyond intake and held drafts), Balanced (makes reversible in-app edits and tells you; researches and drafts quietly), Hands-off (also edits app-owned calendar blocks quietly). Default: Cautious for invitees, Balanced for the owner. Under every preset, anything addressed to another person, spending money or deleting needs approval. In the first version the agent's own work is limited to research, drafting and preparation.
- **Background intake always runs**, whatever the preset.
- **Memory.** A small profile loaded on every run, topical notes per module, the database as the source of truth, searchable raw transcripts, and a nightly consolidation pass on a cheap model. Every entry carries its origin and date. Nothing inferred or externally sourced enters the always-loaded profile without the person's confirmation. Each person can read and edit their memory. No knowledge graph.
- **Rebuild guard.** Structural settings (life areas, tags, views, agent persona) can be changed only during a recurring window. Ideas outside the window go to a list.
- **Accountability sharing.** Opt-in, off by default: a weekly summary of completed progress to one chosen person.

## Messages and re-entry

- Three scheduled batches a day at times each person sets, under a soft cap of 5 and a hard cap of 10 messages a day. At most two messages a day may break out of a batch: a start cue the person set, or an imminent calendar change.
- A message type ignored three times running halves its frequency. The quiet mode offered is one batch a day, not zero.
- No consecutive-day streak counters. Show rates such as "5 of the last 7", with a weekly reserve of two skips.
- After a miss, the next message is the smallest version of today's task, never a report of the gap.
- After 3 days of silence the system pauses itself: overdue flags hide and recurring items stop accumulating. After 7 days it offers a one-tap "park everything" that moves undated and overdue items to a parked list.
- A user-set status (sick, travelling, on a break) silences expectations in every module.

## Phone

- **Default view: Day River.** A full-height vertical timeline of today, blocks sized by duration and coloured by life area, a moving now-line, a load bar on top, a tray of unscheduled items to drag onto the day, and one "replan from now" button that proposes a list of changes.
- **The Deck** runs as the daily summary at the start and end of the day: one card at a time with four swipe directions (do, not now, hand to agent, drop), ending on a summary of the resulting day.
- Delivered as a Home Screen web app with web push. No native app. Apple Shortcuts are an optional capture add-on.
- The phone needs a connection. A quick capture made without signal is held locally and sent when signal returns; no other data lives only on the phone.

## Desktop

Reproduce the plan-review screen described under Modules 3. Add an intake queue, hidden by default, with four single-key actions: accept, decline, merge, snooze. Include a command palette and full keyboard navigation. Long-horizon views (week, quarter, year, with each task threaded to its goal) live here.

## Stack and integrations

- **Data and sign-in:** Postgres on Supabase Pro with row-level security on every table. Passkeys, with an emailed magic link as fallback; sign-up is closed and gated by invite token.
- **Jobs:** Trigger.dev, free tier. One dispatcher per job type fires every few minutes, asks the database which people are due, and starts one independent run per person. User-set start cues run as one-off delayed jobs.
- **Model:** the Claude Messages API with a hand-written tool loop. Route by job: cheapest model for extraction and consolidation, mid-tier for planning and chat, larger for weekly review. Each person can choose, since they pay. Show a spend meter by day and job type. Keep the model boundary provider-agnostic.
- **Billing and keys:** try Anthropic linked billing first (each person approves the app and sets a monthly cap; no key is held). Fallback: each person's API key, encrypted with a per-user data key wrapped by a key-management service, entered on desktop only, never logged. A small key funded by the owner pays for shared public content (papers, food database, weather).
- **Intake pipeline, six stages:** durable queue with the raw item kept encrypted; deterministic pre-processing; an extraction call with a fixed output format, no tools and no memory; validation in code; routing by consequence; a write that records its origin. Low-stakes records file themselves, medium ones file and appear in the next batch, and anything with an uncertain date, amount or person, or that would create a calendar block, waits in a staging inbox. Text found inside an email or web page is data and never an instruction.
- **Email:** each person gets a private, revocable intake address (Cloudflare Email Routing into a Worker). They forward mail to it by hand or by rule. The app never reads a mailbox and never sends email as the person. No Gmail sign-in.
- **Calendar:** read any calendar by ICS link. Publish a private, revocable ICS feed of task blocks that each person subscribes to once. Later: optional Google Calendar sign-in for writing blocks, and opt-in iCloud access. School Outlook stays read-only by ICS.
- **Privacy:** envelope encryption for all content. Opt-in diary lock that only the person's passphrase opens, with a recovery code. No operator page shows another person's content. An append-only log of every agent and human read or action, visible to each person as a "what your assistant did" timeline with undo. A one-tap "pause the agent". Onboarding shows a consent screen naming Anthropic as the model provider and uses the four-sentence privacy promise quoted in the research file.
- **Running cost:** about $25 a month plus a domain, excluding each person's own model usage.

## Build sequence

1. Run the spikes below and record the results.
2. Foundation: database with row-level security, invite-gated sign-in, encryption, the audit log, the job runner with the dispatcher pattern, billing or key handling, and the message queue with batches, caps and quiet hours.
3. Intake pipeline with the staging inbox, the Telegram bot, and the mirrored in-app thread.
4. Task core on desktop: goals and weekly objectives, breakdown, start cues, estimate calibration, the hours-based load figure, plan review with undo, the bluntness dial, ICS reading and the published ICS feed, and the profile and notes layers of memory.
5. Daily rhythm: morning message with check-in, evening close, weekly review, user status, automatic pause, re-entry.
6. Phone web app: Day River, the Deck, web push.
7. Gym: logging and rule-based progression, then readiness, then plan rewrites by the model.
8. Digest core: weather, calendar, tasks, research papers, news headlines with links, poetry, and the optional per-person whitelist.
9. Learning loop: nightly memory consolidation, action-report lessons, retrieval at breakdown time.
10. Saves.
11. Wider autonomy: the full permission presets, agent-started drafts, Google Calendar write, iCloud opt-in.
12. Food.
13. Forwarded-newsletter digest section.

Steps 2 to 5 form a product worth opening daily. Reach that point before starting step 6. Turn on at most two tracking modules for a new person.

## Spikes to run first

- **Linked billing:** can a small private app register during the beta; token lifetimes; whether prompts are visible in the owner's Console.
- **Job runner:** does Trigger.dev's free compute credit cover the group's daily runs; behaviour on a missed tick.
- **Encryption with row-level security:** where keys live and how the agent's worker decrypts per person.
- **iOS web push:** delivery reliability, action buttons, and the install and permission flow when a link opens inside another app's browser.
- **Telegram on iPhone:** topics inside a private chat, buttons, and that a bot cannot message before the person presses Start.
- **Email chain:** Gmail's forwarding confirmation, the school's external-forwarding setting, and what survives two forwards.
- **Calendar:** how often Apple Calendar refreshes a subscribed feed; Google's scope class and token lifetime for an unverified app.
- **Extraction quality:** thresholds tuned on real forwarded mail, and an adversarial test of the extraction call.
- **Passkeys** in the chosen sign-in provider.
- **Model prices:** confirm the current table before building the spend meter.
- **Poetry source:** confirm a public-domain or licensed source.
- **News source:** the owner's preference is publisher RSS feeds; use them wherever a publisher offers one, and add a news API only for topics or outlets RSS does not cover. Whatever is used, choose sources whose terms allow a private app to fetch and show headlines and links, supports filtering by topic and by domain, and fits the running-cost budget. Candidates to check: GDELT, NewsAPI, GNews, Event Registry, The Guardian and New York Times APIs, and plain RSS.
- **Paper sources:** confirm terms and rate limits for each source beyond arXiv; Semantic Scholar's default licence is non-commercial with link-back.

## Flagged to revisit

| Decision | Revisit if |
|---|---|
| One dispatcher per job type instead of one schedule per person | People need to-the-minute timing on many jobs, an outage silences everyone more than once, or ticks overlap as the group grows |
| No offline sync on the phone | People regularly log where there is no signal and the local capture queue is not enough |
| Web app, not native | People ask for Lock Screen widgets, Apple Health data or saving from the share sheet |
| Telegram as the only messenger | A specific person refuses to install it |
| Trigger.dev free tier | The compute credit does not cover daily runs |

## Not in scope

A public product, billing or an App Store listing; a native iPhone app; an iMessage or SMS channel; WhatsApp; Gmail or Outlook sign-in; wearable-gated training; calorie targets; sending anything as the user; model-written news summaries.
