# Spike 1: Linked billing

Date: 2026-11-17. Method: read Anthropic's published documentation. Nothing was registered in the Console.

## Question

Can a small private app register for Anthropic linked billing during the beta? What are the token lifetimes? Are people's prompts visible in the owner's Console?

## What was tried

Read in full: the announcement article, the linked billing guide, the app review page, the OAuth reference, the user profiles page, the workload identity federation page, the rate limits page, the data retention page, the Commercial Terms and the Usage Policy. Three headline claims (the 10-person test list, the $50 cap, the subscription exclusion) were re-checked against the page text by a second reader.

Sources, all under `https://platform.claude.com/docs/en/manage-claude/`: `oauth-apps/organization-billing-connections`, `oauth-apps/app-review`, `oauth-apps/oauth-reference`, `oauth-apps/overview`, `user-profiles`, `workload-identity-federation`. Announcement: `https://claude.com/resources/articles/linked-billing-on-claude-platform`.

## Result

**Registration**

- There is no waitlist. An admin of the owner's Console organisation creates an OAuth app in Console settings. No rule requires the owner to be a company.
- A new app starts in **testing**. In testing, only named people can link (matched by their Claude account email), the list holds **up to 10 people**, and every link must carry a monthly cap of **$50 or less**. Testing bills real money. No time limit on staying in testing is documented.
- Going past 10 people means **publishing**: the owner proves control of the app's own domain by a DNS record, then Anthropic reviews the app. The review criteria are not published, and a rejected app cannot be resubmitted by the owner.
- The documentation index labels these pages as early access, and one documented error is "Anthropic has not enabled this endpoint for your organization". Whether the option even appears for a new individual organisation is unknown until someone looks.
- The Commercial Terms, which govern the beta, say the services "are not for consumer use". How a reviewer would treat a family app is unknown.

**What each person needs**

- Their own Claude Console organisation, where they hold the Admin or Billing role, funded with purchased credits. A Claude subscription (Pro, Max, Team) does not work, and neither do the API credits bundled with those plans.
- One organisation links to one person. Two relatives sharing a Console organisation would share one bill.
- The owner cannot link the organisation that owns the app, so the owner needs a second funded organisation to use his own app.

**How it works**

- OAuth 2.0 authorisation code flow with PKCE. Anthropic issues no client secret; the app's back end proves its identity with a signed token from its own identity provider (workload identity federation). None of Supabase, Trigger.dev or Cloudflare Workers provides one, so the app would have to run a small issuer of its own (inference from the docs, not tested).
- Lifetimes: authorisation code 5 minutes; access token up to 1 hour; refresh token up to 1 year, not extended by use, rotated on every use.
- The app chooses who pays on each request, by naming the person's profile. The back end's credential can, by default, bill every linked person. So "the app holds no key" is true only of the person's API key; the app still holds a credential that can spend everyone's money.
- At the cap the request fails with `402 billing_error` (`linked_organization_spend_limit_reached`) and is never billed to the owner instead. The app cannot read a person's cap or how much of it is used.
- Unlinking sends no notice; the app finds out from a `403` or by polling.

**Limits that affect this design**

- Requests run in the **owner's** organisation: the owner's rate limits, model access and retention settings apply, not the person's.
- Only "requests the customer directs you to make" may be billed to them. Background intake and nightly consolidation are not obviously that.
- The Batch API cannot be billed to a linked person.
- The spend meter cannot come from the Console (figures refresh in hours). It has to be computed from each response's usage, which is true for stored keys too.

**Prompts in the owner's Console**

Not found. No page describes a Console view of request content for linked requests. User profiles "don't contain conversation content". The Console shows per-person request and token counts. This is the one part of the question the documentation does not settle. It matters less than it sounds, because the app's own back end composes every request and so handles the content either way.

## Decision

Linked billing is **not** the launch route. The app launches on the fallback the brief already specifies: each person's own API key, encrypted with their per-user data key.

Reasons, in order of weight:

1. The group is 5 to 30 people and testing stops at 10. Beyond that sits a review with unpublished criteria, under terms that exclude consumer use.
2. It does not remove the hard part for relatives. Both routes need each person to open and fund a Console organisation.
3. It adds a federation issuer the stack does not have, and a back-end credential that can bill everyone.
4. Background jobs and batch processing, which this design leans on, are the cases it handles worst.

The model boundary stays provider-agnostic and billing sits behind one interface (`who pays for this call`), so linked billing can be added later without touching callers. Revisit when it leaves beta, or if the group settles at ten or fewer.

## Still open

- Whether the OAuth apps option appears for a new individual organisation, and what the review asks for. Only an attempt in the owner's Console can show this. Not needed for launch.
- With stored keys, requests run in each person's own organisation, so that person's retention settings apply. The privacy promise's third sentence ("Anthropic keeps it up to 30 days") should be re-read against Anthropic's commercial retention policy when the onboarding copy is written. This spike did not find a contradiction; one research note suggested one and on checking it was a misreading of a sentence about feature-level storage.
- The Usage Policy defines a minor as under 18 and points products that serve minors to extra safeguards. **Answered by the owner on 2026-11-18: nobody invited is under 18.** If that changes, this needs revisiting before that person is invited.
