# Spike 9: Passkeys

Date: 2026-11-17. Method: read Supabase's documentation, changelog and auth server source. Nothing was configured in the Supabase project and no device was used.

## Question

Does the chosen sign-in provider, Supabase Auth, support passkeys, with an emailed fallback and closed, invite-only sign-up?

## What was tried

Read the Supabase Auth guides for passkeys, passwordless email, rate limits, custom SMTP, PKCE, sessions, auth hooks, third-party auth, signing keys and API keys; the passkey announcement and its discussion thread; and the `supabase/auth` source for the invite path and default limits. The experimental status was re-read on the passkeys page by a second reader.

## Result

**Passkeys exist as a first sign-in method, but are experimental.** Supabase shipped native passkeys on 28 May 2026. The guide still says: "Passkey support is experimental. The API may change without notice." No general-availability date has been announced.

- Needs `@supabase/supabase-js` 2.105.0 or later and an explicit opt-in when the client is created.
- `auth.registerPasskey()` and `auth.signInWithPasskey()` run the whole exchange. Sign-in uses discoverable credentials, so nobody types an email first.
- **A passkey can only be added by someone already signed in** ("requires an existing, confirmed, non-anonymous user"). The first sign-in on any account has to use another method.
- Passkeys are bound to one bare domain. "Changing the RP ID makes every existing passkey unusable for sign-in." Up to five origins are allowed under it.
- The auth server is still receiving passkey fixes (latest release 16 November 2026). The discussion thread has unanswered reports of verification failures on iOS and Windows and of one password manager failing to register.
- Nothing from Supabase or Apple says whether passkeys work inside an iPhone Home Screen web app.
- Using a passkey as a second factor on top of an emailed link is not available on hosted Supabase.

**Emailed fallback**

- A magic link and a six-digit code are the same mechanism with a different email template. Default expiry is one hour.
- A link must be opened in the same browser that asked for it, and mail scanners can use a link up before the person does. Supabase's own first remedy is to send a code instead.
- An iPhone Home Screen web app keeps its storage separate from Safari, and a link tapped in Mail opens in Safari. A link would therefore sign the person in to the wrong place. A typed code avoids this, because it is entered where the session is wanted (inferred from the documentation, not yet tried on a phone).
- Supabase's built-in email sends 2 messages an hour and only to project team members. A custom mail sender is required; with one, the default is 30 an hour and adjustable.

**Closed, invite-only sign-up**

- "Allow new users to sign up" can be turned off; then only existing accounts can sign in.
- Server-side invites exist (`inviteUserByEmail`, `generateLink`). Whether they still work with sign-up turned off is not stated in the documentation. The source shows no such check on the invite path, which suggests they do.
- A "before user created" hook can reject any new account. It is available on the Pro plan and runs as a database function.
- Session time limits, inactivity timeouts and single-session rules are Pro features. Access tokens last one hour by default.

**The project as it stands today**

A read of the project's public auth settings shows sign-up is currently **open** and passkeys are **off**. Both are set at the foundation step; nothing was changed in this spike.

**Alternatives looked at and set aside**

A separate passkey provider feeding tokens to Supabase works, but people's ids stop being the UUIDs that `auth.uid()` expects, so every policy would have to change, and it adds a second vendor (Clerk's passkeys are on a $25 a month plan; Hanko's free tier would do). Rolling our own with a WebAuthn library and self-signed tokens means owning session handling. Neither is worth it while the native route exists.

## Decision

1. **Native Supabase passkeys for day-to-day sign-in**, and an **emailed six-digit code, not a link**, for the first sign-in, for new devices and for recovery. This replaces "an emailed magic link as fallback" in the brief with the same mechanism in a form that works on a Home Screen web app and survives mail scanners.
2. Onboarding order: invite, code by email, signed in, then "add a passkey" as the next step.
3. Contain the experimental API: pin the client library version, keep every passkey call inside one small module, and keep the code path fully working so a breaking change degrades to codes and never to a lockout.
4. **Fix the production domain before anyone adds a passkey.** Changing it later invalidates all of them.
5. Sign-up off; accounts are created only by a server-side invite; a "before user created" hook checks the invite table as a second gate; the client never auto-creates an account.
6. A custom mail sender is required from the first day. A free tier of a transactional mail service covers this group's volume; chosen at the foundation step.

## Needs the owner

The production domain name, since passkeys are tied to it permanently. The brief already budgets for a domain; this spike only makes the choice urgent.

## Still open, all needing a phone or the live project

1. Passkey registration and sign-in inside an iPhone Home Screen web app, and whether a passkey made in Safari works in the installed app.
2. The six-digit code entered inside the Home Screen web app: that it creates a session there and the session survives relaunch.
3. An invite to a new address with sign-up turned off, and whether the hook fires for invites.
4. Passkeys on the Pro plan specifically (one report says the setting was ignored on a Free project).

Items 1 and 2 are on the hands-on checklist in spike 4. Items 3 and 4 are tested first thing at the foundation step.
