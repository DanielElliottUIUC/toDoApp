# Spike 5: Telegram on iPhone

Date: 2026-11-17. Method: read Telegram's Bot API reference, changelog, FAQ, feature pages, developer terms and server source. **No bot was run and no iPhone was used**; the bot token in `.env` is still empty. The phone checklist at the end is what remains.

## Question

Do topics inside a private chat work, do buttons work, and is it true that a bot cannot message a person before they press Start?

## What was tried

Read `core.telegram.org` (Bot API reference, changelog through version 10.4 of 9 November 2026, FAQ, features, webhooks, Mini Apps), the bot developer terms, and the source of Telegram's bot server for exact error text. The topic entries and the fee clause were re-read by a second reader.

## Result

**Topics inside a private chat: yes, in the API.**

- Bot API 9.3 (31 December 2025) added topic mode for a bot's private chats. Bot API 9.4 (9 February 2026) let the bot create the topics itself and added a setting that stops people creating or deleting topics.
- It is switched on per bot in BotFather ("Threaded mode"). The bot then sends each message to a chosen topic, so separate Capture, Reminders and Digest lanes in one chat are possible.
- If people cannot create topics, a message typed without choosing a lane lands in "General".
- No Telegram Premium is needed. While the mode is on, Telegram keeps 15 percent of any Telegram Stars purchases made in the bot. This bot sells nothing, so the cost is zero.
- How it looks on an iPhone was not seen. Telegram's bug tracker lists several iOS bugs for threaded bot chats, all marked fixed. In May 2026 sends to private topics failed for some hours.

**Buttons: yes.**

- Inline buttons sit under a message; a tap sends nothing into the chat and reaches the bot as a callback. The data a button carries is limited to 64 bytes.
- Buttons can be coloured (red, green, blue) since Bot API 9.4, and a button can copy text or open a Mini App.
- The bot can edit or remove a message's buttons after a tap, with no time limit on its own messages.
- A tap must be acknowledged quickly. The window is not documented; one developer measured about 15 seconds.

**A bot cannot message first: confirmed.** Telegram's documentation says: "Bots can't start conversations with users." A send to someone who has not started the bot fails with `403` and "bot can't initiate conversation with a user".

- A link of the form `t.me/<bot>?start=<payload>` opens the bot with a Start button and delivers the payload, up to 64 characters. Telegram names account linking as a use. A 256-bit random token fits.
- If a person blocks the bot, sends fail with `403` and the bot is told by an update when it is blocked or unblocked.

**Limits and privacy**

- About one message a second per chat and 30 a second overall; 4,096 characters per message. Far above anything this app sends.
- Bot chats are ordinary cloud chats: encrypted between the phone and Telegram and stored on Telegram's servers, not end-to-end encrypted. Telegram says only Secret Chats are end-to-end, and bots cannot use those. No single sentence says "bot chats are cloud chats" in those words.

**Links and newer features**

- Links from the bot open in Telegram's own browser by default. The Bot API has no option to force Safari. A Mini App button can open Safari in one tap (see spike 4).
- Confirmed in the changelog: streaming draft replies (9.3, opened to all bots in 9.5), ephemeral messages (10.2, for groups), and HTML widgets (10.4, 9 November 2026).

**Hosting**

A webhook needs an HTTPS address on port 443, 80, 88 or 8443, and Telegram sends a secret header of the app's choosing on every request. Updates are held for at most 24 hours if the webhook is down.

## Decision

1. Telegram stands as the messenger. Nothing found contradicts the brief.
2. **Linking is started by the person, from the app.** The app shows a "connect Telegram" link carrying a single-use token that expires in minutes. Pressing Start in Telegram delivers the token and binds that Telegram account to that app account. Until then the in-app thread is the only channel, and the app never assumes it can reach someone on Telegram.
3. A blocked or unlinked bot switches that person back to the in-app thread at once and says so in the app.
4. Buttons carry only a short opaque id, looked up on the server. The bot acknowledges every tap immediately and does the work afterwards, then removes or updates the buttons so a second tap cannot repeat the action. Every button also has a typed equivalent, as the research file requires.
5. The webhook checks Telegram's secret header, stores the update in the durable queue and returns. Processing happens in the job runner. If the webhook was down, Telegram redelivers for 24 hours.
6. Diary and other sensitive text stay out of Telegram, as the brief says; this spike confirms why.
7. The bot launches as one thread, which is the owner's choice (below). The code still keeps a "lane" on every outgoing message, so lanes can be switched on later without rework.

## Needs the owner

**Answered by the owner on 2026-11-18: one thread.** The question was one single chat thread, or three lanes inside it (Capture, Reminders, Digest). One thread means a relative who types a thought does not have to pick a lane first, and "calm and sparse" is easier to keep in one place. Lanes can be switched on later.

**Hands-on, at the intake step, once a bot token exists:**

1. Create the bot in BotFather and put its token in `.env`.
2. Open the connect link from a fresh Telegram account and confirm only a Start button is shown and the link completes.
3. Tap a button on a test message; confirm the buttons vanish and the reply arrives.
4. Tap a link from the bot and note which browser opens.

## Still open

How threaded mode looks and behaves on an iPhone, and whether notifications name the lane. Only matters if lanes are switched on later.
