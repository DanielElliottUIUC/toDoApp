# Spike 11: Poetry source

Date: 2026-11-17. Method: read each candidate's terms and tried its public endpoint. Nothing was imported.

## Question

Is there a public-domain or licensed source of poems the digest can show in full, one a day?

## What was tried

Read the terms and tested the access route for PoetryDB, Project Gutenberg, Wikisource, the Poetry Foundation, the Academy of American Poets, Standard Ebooks, the Library of Congress and several public datasets. Read the US rule on publication date and on translations. The PoetryDB licence and a live request were checked a second time.

This is a reading of published terms, not legal advice.

## Result

**The rule.** In the United States, works published in 1930 or earlier are in the public domain as of 1 January 2026. The test is the publication date, not the year the poet died. A translation is a separate work with its own copyright, so a modern translation of an old poem is not free to use.

| Source | Usable? | Why |
|---|---|---|
| **PoetryDB** (`poetrydb.org`) | **Yes** | Free API, no key. About 3,000 poems by 129 poets, mostly pre-1900 and early 1900s English-language canon. The data is licensed CC BY 4.0, which permits copying with credit. The maintainer states the texts are public domain, taken chiefly from Project Gutenberg. Each poem comes with title, author and lines, and can be chosen by length or poet. Actively maintained, by one person |
| **Standard Ebooks** | **Yes, as a second source** | Everything it produces is dedicated to the public domain (CC0). Roughly 84 poetry collections, each a public repository on GitHub with every poem individually marked up. Its website must not be crawled; the repositories are the route |
| Project Gutenberg | Indirectly | Texts are public domain in the US, but the site forbids automated access outside its mirrors, files are whole books with no per-poem structure, and the Gutenberg name must be stripped or its licence shown. PoetryDB has already done this work. The site was down for maintenance during the spike, so its robot policy was read second-hand |
| Wikisource | Not worth it | Free and open, but pages are inconsistent (version pages, templates) and need per-page parsing, and it requires a contact address in each request |
| Poetry Foundation | **No** | Terms allow personal use only and bar copying, redistribution and any automated gathering |
| Academy of American Poets (Poem-a-Day) | **No** | The poems are new and under copyright, and the terms prohibit copying |
| Public datasets | Mostly no | Several are scraped from the Poetry Foundation and are not clean whatever licence tag they carry. One is lines, not poems. One large collection asserts public-domain status without documenting it |
| Library of Congress | No | No poem-level, rights-cleared collection was found |

**Weak points of PoetryDB**

- Public-domain status rests on the maintainer's statement. It was not audited poem by poem, and only 1 of 40 sampled poems named its source.
- It is one person's service on a small host, and queries returning more than 500 poems are refused.

## Decision

1. **PoetryDB is the source, imported once into the app's own table.** The licence allows it, and it removes a nightly dependency on a single-maintainer service. The import walks the poet list at a gentle pace.
2. Store title, poet, lines, line count, the source field where present and the poet's dates. The digest picks from the stored table; selection by length and poet is done locally.
3. **Safeguard for the unaudited part:** keep only poets who died in or before 1930 unless a poem's source shows publication in 1930 or earlier, and exclude anything marked as a translation by a translator who died after 1930. This is stricter than the law requires and costs a few poets.
4. Credit is shown as the licence asks: "Poetry data from PoetryDB (poetrydb.org), licensed under CC BY 4.0", on the app's sources page, with "via PoetryDB" under the poem.
5. **Standard Ebooks is the fallback and the way to grow the collection**, by cloning chosen poetry repositories once and reading the per-poem markup. Not needed for launch.
6. No poem is fetched live at digest time and the model never writes, completes or alters a poem.

## Still open

- Project Gutenberg's robot policy should be read first-hand once the site is back. It matters only if Gutenberg is ever used directly, which this decision avoids.
- A licensed source of contemporary poetry would need the owner to arrange permission. Not pursued.
