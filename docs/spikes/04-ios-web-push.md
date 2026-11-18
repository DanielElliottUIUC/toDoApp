# Spike 4: iOS web push

Date: 2026-11-17. Method: read WebKit's and Apple's documentation, the WebKit bug tracker, browser compatibility data and Telegram's iOS source. **No iPhone was used**, so delivery reliability is not measured. The phone checklist at the end is what remains.

## Question

How reliable is web push on an iPhone Home Screen web app, do action buttons work, and what happens to the install and permission flow when a link opens inside another app's browser?

## What was tried

Read the WebKit blog posts for web push, Declarative Web Push and each Safari release through 27.2; Apple's web push documentation; the open and fixed WebKit bugs on push and notifications; the compatibility data MDN publishes; and the browser code in Telegram's open-source iOS app.

One correction to the research file: the current system is **iOS 27** (27.2 shipped on 26 October 2026), not iOS 26. The Safari 27 release notes list no changes to web push or Home Screen web apps, so the findings carry over, but the phone test should be on 27.

## Result

**Requirements**

- Push works only inside a web app the person has added to the Home Screen. Since iOS 26 any site added there opens as a web app by default.
- Permission must be asked from a tap, inside the installed app.
- **Declarative Web Push** (iOS 18.4 and later) needs no service worker: the server sends a small JSON notification and the system shows it. It is not subject to the silent-push penalty and survives the browser's storage clean-up. The same payload works on older systems through a service worker.

**Action buttons: no.** Notification action buttons are not supported on iOS. The only interaction is a tap, which opens the app.

**Other limits**

- **A tap does not reliably land on the right screen.** An open WebKit bug, reproduced on iOS 27.2.1 four days ago, has the tap bringing the app forward without telling the page which notification was tapped.
- Replacing an earlier notification with a newer one of the same tag does not work (open bug since 2023).
- Silent pushes are not allowed; a push that shows nothing can get the subscription revoked.
- The app icon badge works and can be set by the push itself.
- Payload limit 4 KB. The push service answers `410` when a subscription is dead.

**Delivery reliability: unknown, with warning signs.** No credible measured delivery rate for iOS exists. Four WebKit bugs about subscriptions silently becoming invalid or pushes accepted but never delivered are open, one from July 2026. WebKit does not notify the app when a subscription changes. Several older delivery bugs are fixed. Focus modes apply per web app; nothing is documented about Scheduled Summary.

**Not opened for days.** A Home Screen web app has its own usage counter, separate from Safari, and WebKit does not expect its data to be cleared. Declarative push does not depend on that data surviving.

**Install and permission from inside another app**

- A Home Screen web app does **not share storage with Safari**. Cookies are copied once, at the moment of adding to the Home Screen; nothing else is copied and nothing is shared afterwards.
- Links never open in the installed app. A link tapped in Mail or a chat opens in Safari or that app's own browser.
- Apple's standard in-app browser sheet (used by many apps) can add to the Home Screen and has an "open in Safari" button.
- **Telegram's in-app browser is its own web view**, is the default for links, and nothing shows it can add to the Home Screen. It disguises itself as Safari but can be detected from the page. It has an "Open in Safari" button. A bot cannot force a link to open in Safari, but a Telegram Mini App button can, in one tap.
- No primary source says whether passkeys work inside an installed web app.

## Decision

1. **Web push is a best-effort nudge that opens the app. It is not the reminder channel.** Telegram stays the dependable channel, as the research file already suspected. Nothing that must be seen is sent by web push alone.
2. **Anything that needs a tap to answer goes to Telegram or is answered inside the app.** Check-in buttons and reminder replies cannot be push actions on an iPhone.
3. Use Declarative Web Push with a service-worker fallback.
4. Do not depend on the tap carrying a destination. When the app opens, the server already knows what it last nudged about and the app shows that first.
5. Never rely on one notification replacing another, and never send a push that shows nothing.
6. On every app open, check the subscription and quietly renew it if it has gone. Delete a subscription on `410`. The settings page shows whether push is working, with a "send me a test" button.
7. **Sessions are kept in cookies, not in browser storage,** so that signing in on the Safari page and then adding to the Home Screen arrives signed in. Sign-in inside the installed app uses a typed code (spike 9), never a link.
8. Install flow: the invite page detects where it has been opened. In Safari it shows the add-to-Home-Screen steps. In Telegram's browser or another in-app browser it shows one instruction, "open in Safari", first. The bot sends the install link as a Mini App button that opens Safari directly. Once installed, the app asks for notification permission from a button, after the person has seen what the notifications are for.

## Needs the owner (hands-on, at the phone step, on iOS 27)

The phone app is build step 6, so none of this blocks earlier steps. With a test page deployed:

1. Add to the Home Screen from Safari, allow notifications, and receive a test push with the app open, in the background, closed, and with the phone locked.
2. Tap each notification and note whether the app opens on the right screen.
3. Leave the app unopened and receive one push a day for two weeks. Note which arrive.
4. Open the invite link from a Telegram bot message, from Gmail and from Messages. Note whether "Add to Home Screen" is offered and how easy "open in Safari" is to find.
5. Sign in on the Safari page, then add to the Home Screen, and note whether the installed app is signed in.
6. Inside the installed app, add a passkey and sign in with it; then try a passkey made in Safari.
7. Turn on a Focus and a Scheduled Summary and note what happens to a push.

## Still open

Everything in the checklist above. The delivery rate in particular decides how much the phone app may lean on push; until measured, the answer is "not at all".
