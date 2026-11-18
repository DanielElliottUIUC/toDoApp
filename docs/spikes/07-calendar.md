# Spike 7: Calendar

Date: 2026-11-17. Method: read Apple's and Google's published documentation. No feed was published and no phone was used.

## Question

How often does Apple Calendar refresh a subscribed feed? What scope class and token lifetime does Google give an unverified app?

## What was tried

Read Apple's iPhone and Mac Calendar guides and support pages and the Apple developer forums; Google's Calendar help, OAuth scope lists, verification requirements, unverified-app and token-expiry pages. The research file's two conflicting sources on Google token expiry were compared against Google's own pages.

## Result

**Apple Calendar and subscribed feeds**

- **Apple publishes no refresh interval.** The iPhone guide describes a "Fetch New Data" schedule for calendar accounts without push and says the automatic setting downloads only on power and Wi-Fi. It does not list the intervals or say the setting governs subscribed calendars.
- On a Mac each subscription has an auto-refresh menu; Apple lists no values.
- A subscription added to iCloud appears on all of a person's devices. Apple does not say whether its servers or each device fetch the feed, or how often.
- No Apple statement and no measured test shows whether the iPhone honours the refresh hints a feed can carry, or conditional requests.
- The only data point is one unanswered developer forum post reporting a 15-minute choice when adding a subscription on the phone, and fetches at that interval.
- Google Calendar's "add by URL" is slower still. Google gives no figure; vendors consistently report 12 to 24 hours with no way to force it.

**Conclusion on the feed:** the documentation does not support promising that a change made today reaches a person's calendar today. The published feed is dependable for **tomorrow's blocks**, not for same-day changes.

**Google Calendar sign-in for an unverified app**

- **No Calendar scope is restricted.** Google's restricted list covers Gmail, Drive, Fit and Chat. So no paid security assessment applies to calendar access; Google heads that requirement as being for restricted scopes only.
- Google does not publish the class of each Calendar scope; the Cloud Console shows it when the scope is added. Whether the narrow `calendar.app.created` scope counts as sensitive is still unknown.
- An app set to "In production" but unverified can be authorised by any Google account, shows a warning screen for unapproved sensitive scopes, and is capped at **100 new users for the life of the project**.
- **Token lifetime:** in production, refresh tokens have no time-based expiry. They end when the person revokes, after six months unused, or when more than 100 are live for one account. The seven-day expiry applies **only to "Testing" status**. This settles the conflict in the research file: Google's pages are right and the secondary guide was wrong.
- Verification for sensitive scopes, if ever wanted, needs a public homepage and privacy policy on an owned domain, domain verification, a justification per scope and a demo video. It is not needed for personal use under 100 users.

## Decision

1. Publish the private, revocable feed as planned, and design around it being a **next-day** channel. Same-day changes reach the person through the app's own surfaces: the Day River on the phone and the message queue's breakout for an imminent change. Nothing in the app assumes the person's calendar is current within the day.
2. The feed carries refresh hints at a short interval and supports conditional requests, in case a client honours them. It records the time and client of each fetch (no content), so the settings page can show each person when their calendar last picked it up. That turns the unknown into something each person can see, and gives the measurement Apple does not publish.
3. Reading other calendars by link is unaffected: the app fetches those itself on its own schedule.
4. For the later Google Calendar step (build step 11): publish the Google project as "In production" and unverified, never leave it in "Testing", request the narrowest scope that can write app-owned blocks, and stay well under the 100-user cap. No verification and no assessment is needed for this group.

## Needs the owner (hands-on, at the task-core step when the feed exists)

1. Subscribe to a test feed on the iPhone twice, once under "On My iPhone" and once under iCloud, and note what refresh choices the add screen offers.
2. Leave both for two days. The feed's log then shows the real intervals on power and Wi-Fi, on battery and mobile data, and in Low Power Mode.
3. Change an event at a known time and note when it shows up without opening Calendar.

If the phone turns out to fetch every 15 to 60 minutes away from power, the app can say so for Apple Calendar. Until then it promises next-day only.

## Still open

- The class of `calendar.app.created` and `calendar.events.owned`. A two-minute check in the Google Cloud Console at step 11.
- iCloud access by app-specific password (step 11) was not part of this spike.
