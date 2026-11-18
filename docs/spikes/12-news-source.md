# Spike 12: News source

Date: 2026-11-17. Method: fetched publisher feeds live, read publishers' and API providers' terms. No account or key was created.

## Question

Which news sources allow a private app to fetch and show headlines and links, support filtering by topic and by domain, and fit the running-cost budget? The owner's preference is publisher RSS first, with a news API only where RSS falls short.

## What was tried

- Fetched 22 outlets' feeds with a plainly labelled user agent and recorded status, item count and fields. Six were fetched a second time, along with the two reported dead.
- Read each outlet's terms for what they say about feeds.
- Read the pricing and terms of eleven news APIs, and ran nine live queries against GDELT, the one that needs no key.

This is a reading of published terms, not legal advice.

## Result

**RSS can carry launch.** Twenty of 22 outlets have a working feed that gives headline, link and date. Nineteen have per-section or per-topic feeds. Eleven tag each item with categories.

| Works, with topic feeds | Works, one feed only | No feed |
|---|---|---|
| BBC, NPR, The Guardian, New York Times, Washington Post, Wall Street Journal, Bloomberg, Financial Times, The Economist, Politico, Ars Technica, The Verge, Wired, MIT Technology Review, STAT, ESPN | Al Jazeera, Nature, Science, Axios | AP (old address returns an error; its terms bar automated access), Reuters (feed host no longer exists) |

AP and Reuters stories still arrive through other outlets that carry them.

**What the publishers' terms say**

| Reading | Outlets |
|---|---|
| **Explicitly allow** showing headline and link on a site or app, with conditions | NPR (non-commercial, credit "NPR", headline and link unchanged, remove on request), ESPN (credit ESPN, unchanged, no ads), Financial Times (headline and link, credit FT, not a paid service, do not archive), STAT (headline and link, credited; another clause of its terms bans automated collection) |
| **Personal, non-commercial use; unclear for a shared app** | BBC, The Guardian, Wired, Ars Technica, The Verge, MIT Technology Review, Politico, Axios, Bloomberg, Al Jazeera |
| **Leans against** | New York Times: licenses headline-and-link display for personal use but expressly excludes supplying cached copies to another person. Nature: bars storing feed data in a database |
| **Terms could not be read** (pages block automated readers) | Washington Post, Wall Street Journal, The Economist, Science |

The NPR reading comes from one pass; a second fetch of its terms page timed out.

**The underlying uncertainty.** Nearly every publisher offers its feeds for personal, non-commercial use. This app is non-commercial. Whether one server fetching once a night for 5 to 30 invited people counts as "personal" is not answered by any of these texts, and only the New York Times addresses it, against. The practical consequence of getting it wrong is normally a request to stop. Titles and short phrases are generally not protected by US copyright, so the exposure is contractual, not copyright; that point was read second-hand.

**Where RSS falls short**

- Topics that no outlet has a section for.
- A topic a person types in can only be matched against headline words, which misses stories whose headline does not name it.
- Small feeds: NPR and MIT Technology Review return 10 items, which a busy day can outrun between nightly fetches.

**Filtering.** Topic maps to section feed, then category tags, then headline words. Domain whitelisting is trivial: every item links to the publisher's own address.

**News APIs**

| API | Free tier usable by this app? | Cheapest paid | Verdict |
|---|---|---|---|
| **GNews** | **Yes.** Terms cover non-commercial use. 100 requests a day, 10 articles each, 12-hour delay | €49.99 a month | **Best gap-filler.** No server-side domain filter; filter on the source address after fetching |
| Currents | Yes, with a visible credit to Currents. 250 requests a day | $69 a month | Alternative; has domain filtering |
| GDELT | Yes by its terms, free with a citation | Free | **Not dependable.** All nine live requests failed: five refused, four returned nothing |
| NewsAPI.org | **No.** The free plan "cannot be used in a staging or production environment (including internally)" | $449 a month | Ruled out |
| Event Registry | No. Evaluation only | $90 a month | Ruled out |
| TheNewsAPI, Mediastack, NewsData.io | Too small or too restricted to be useful | $19 to $200 a month | Ruled out |
| Guardian and New York Times APIs | Single publisher; heavier conditions than their own feeds (the Guardian requires its logo and deletion within 24 hours) | n/a | Add nothing over the feeds |
| Google News search feeds | No. Its own notice restricts it to a personal feed reader, and links go through Google | n/a | Ruled out |

Every usable option is free, so news adds nothing to running costs.

## Decision

1. **RSS only at launch.** One nightly fetch of the chosen section feeds, using conditional requests where the publisher supports them and de-duplicating by item id and link everywhere.
2. **Store headline, link, outlet, date, section and category tags. Discard everything else at the door**, including the article text and images that several feeds carry.
3. **Display rules, set by the strictest explicit terms:** the headline exactly as supplied, the link exactly as supplied and opening the publisher directly, the outlet's name beside it, no advertising. The model never rewrites or summarises a headline, as the brief already requires.
4. **Short retention.** News items age out after seven days and are never kept as an archive.
5. **A per-source off switch** for the operator, so one outlet can be removed the day it asks.
6. Topics map to section feeds first, category tags second, headline words last.
7. A person's optional whitelist filters on the link's domain, after ranking.
8. **A news API is added only when a person picks a topic no feed covers**, and it is GNews's free tier. It needs a key, which the owner would create at that point.
9. GDELT, NewsAPI.org, Event Registry and Google News feeds are not used.

## Needs the owner

**Which outlets to include.** This is a judgement about risk, not a technical one, so it is the owner's:

- **Narrow:** only the four whose terms clearly allow it (NPR, ESPN, Financial Times, STAT). Safe and thin: no general world news beyond NPR, little technology.
- **Wide (recommended):** those four plus the outlets whose terms are personal-use and unclear (BBC, The Guardian, Washington Post, Wall Street Journal, Bloomberg, The Economist, Politico, Ars Technica, The Verge, Wired, MIT Technology Review, Al Jazeera, Science), under the display rules above. **Leave out the New York Times and Nature**, whose terms lean against it.

The recommendation is the wide set: the app shows exactly what a feed reader shows, to a handful of invited people, with no ads, no archive and an off switch per outlet.

Not needed until the digest is built (step 8).

## Still open

- The feed terms of the Washington Post, the Wall Street Journal and The Economist need reading in an ordinary browser; their pages refuse automated readers.
- A GNews key, only if a gap topic comes up.
