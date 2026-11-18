# Spike 13: Paper sources

Date: 2026-11-17. Method: read each source's terms and made one small live query to each. No keys were created and no contact address was supplied anywhere.

## Question

What are the terms and rate limits of each research-paper source beyond arXiv? The brief notes that Semantic Scholar's default licence is non-commercial with link-back.

## What was tried

For arXiv, OpenAlex, Semantic Scholar, bioRxiv and medRxiv, and as possible extras Crossref, Europe PMC and PubMed: read the terms of use and API documentation, then ran one "new papers in the last day or two" query and looked at what came back. The arXiv terms were read a second time.

This is a reading of published terms, not legal advice. The question that matters most is whether the source's **abstract** may be stored and shown, since the brief shows each paper with its title, authors, link and the source's own abstract.

## Result

| Source | Fetch nightly | Store | Show title, authors, link and abstract | Access |
|---|---|---|---|---|
| **arXiv** | Allowed, at most one request every 3 seconds on one connection, across all our machines | Allowed. Metadata including the abstract is CC0 | **Allowed.** Link to the abstract page, claim no endorsement, do not host the PDFs | No key, free |
| **bioRxiv, medRxiv** | Allowed. No stated limit | Allowed; keep each preprint's licence | **Allowed for licensed preprints**, shown unaltered with credit and a link. About 1 in 15 carries no licence at all; for those the abstract is unclear | No key, free |
| **OpenAlex** | Allowed | Allowed. Records are CC0 | **Allowed where present.** Abstracts come as a word index to be rebuilt, are missing for many works, and were removed for two large publishers' closed content | A free key needs a verified email. Without one the allowance is small and shared with everyone on the same address |
| **Semantic Scholar** | Allowed within limits | **Unclear.** The current licence does not address storing abstracts | **Unclear.** Two licence pages are live and disagree | Shared pool without a key; one request a second with one |
| Crossref | Allowed, one list request a second | Allowed | Some abstracts are the publisher's copyright | No key |
| Europe PMC | Allowed | Unclear for abstracts | Unclear: depends on each article's licence | No key |
| PubMed | Allowed, 3 requests a second | Allowed with credit to the National Library of Medicine | Unclear: some abstracts are copyrighted | No key |

**arXiv in detail**

- The daily feed per category (`rss.arxiv.org/rss/<category>`) returns each new paper with title, link, authors and the full abstract. One request per category group covers a night.
- The search API is for backfill. In the live test its first call was refused as "rate exceeded" with no earlier calls and succeeded on retry, so retries are needed.
- The feed mixes new papers, cross-listings and revisions; each item says which it is.

**OpenAlex in detail**

- OpenAlex changed its access model in February 2026. The old courtesy pool keyed on an email address is gone; there are now API keys with a daily allowance priced per call. A free key gets $1 a day, which is thousands of list calls. A nightly run for this app would use a small fraction.
- Filtering by publication date is free. Filtering by the date OpenAlex added a record is a paid feature.
- Its response includes a note telling automated agents to create a key by posting the user's email address. That was not acted on; creating a key is the owner's choice.

**Semantic Scholar in detail**

- The licence page the product links to (updated May 2023) grants a terminable licence to access and display the data and requires that "Licensee will include an attribution to 'Semantic Scholar' on its website". It names CC BY-NC among the licences the data carries and says nothing about storing abstracts.
- An older licence page, still live, limits use to internal non-commercial research or education and requires a link back and the Semantic Scholar name and logo.
- Which one governs is not stated. The brief's note is therefore confirmed as a real risk, not settled.

**bioRxiv and medRxiv in detail**

- Machine access is stated as free and unrestricted, with a request to link back and not re-host full text. Reuse of each article follows the licence its authors chose, and that licence is in the data.
- In the live samples, 28 of 30 medRxiv and 29 of 30 bioRxiv preprints carried a Creative Commons licence or a public-domain dedication. The rest are marked as having no reuse licence.

**Matching the same paper across sources**

The DOI is the common key everywhere except arXiv, which has its own id. bioRxiv and medRxiv now issue DOIs under a new prefix as well as the old one, so match on the whole DOI. OpenAlex returns DOIs as web addresses and they need normalising.

## Decision

1. **Launch with arXiv**, from the daily category feeds, one request every three seconds, with retries. The search API is used only for backfill.
2. **Add bioRxiv and medRxiv second.** Store each preprint's licence. Show the abstract for licensed preprints, with the author credit and link. For the few with no licence, show title, authors and link only. This is the one place the digest departs from "always show the abstract", and it does so because the source's own terms are unclear for those items.
3. **Add OpenAlex third**, as the layer that reaches journals and other publishers by topic and keyword. It needs a free key, which the owner would create. Abstracts are shown where OpenAlex supplies them and omitted where it does not; the model never writes one.
4. **Hold Semantic Scholar** until its licence position is clear. It would add little that OpenAlex does not.
5. Leave Crossref, Europe PMC and PubMed out. Their abstract rights are unclear and the first three sources cover the ground.
6. Papers are stored once in the shared table and de-duplicated by normalised DOI and arXiv id. Ranking per person happens in code over that table.
7. A person's optional whitelist for papers is a list of sources and venues, applied after ranking, so that nothing outside it appears.
8. One nightly fetch for everyone, identified by a descriptive user agent. No personal address is sent to any source.

## Needs the owner

Only when the digest is built (step 8): a free OpenAlex key, which requires verifying an email address. arXiv and bioRxiv need nothing.

## Still open

- Which Semantic Scholar licence governs. Only matters if it is ever wanted.
- Whether unlicensed bioRxiv abstracts may be shown. Treated as "no" until someone finds a clear statement.
