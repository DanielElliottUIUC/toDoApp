# Spike 3: Encryption with row-level security

Date: 2026-11-17. Method: a working prototype against a local Postgres 18 with synthetic data, plus documentation for the Supabase and key-service facts. Nothing was created in the Supabase project.

## Question

Where do the keys live, and how does the agent's worker decrypt for one person without being able to read anyone else?

## What was tried

`spikes/03-encryption-rls/` holds a schema and a test script. The schema reproduces the parts of Supabase the design depends on (the `authenticated` role and `auth.uid()` reading the request's claims), adds a worker login with no power to bypass row-level security, and creates four tables with row-level security enabled and forced. The script creates two people, gives each a data key, writes one encrypted task each, and then tries to cross the boundary in every way I could think of. Run it with `npm install && npm test` in that folder.

Docker would not stay up on this machine, so the prototype starts its own Postgres from the `embedded-postgres` npm package in a temporary folder.

## Result

**25 of 25 checks pass.**

| Group | What was shown |
|---|---|
| Isolation by row-level security | A worker scoped to person A sees only A's rows, gets nothing when asking for B's by id, cannot read B's wrapped key, cannot insert a row owned by B, and its updates and deletes against B's rows change nothing |
| Fail closed | The worker with no person selected cannot read any table. The `authenticated` role with no person id sees zero rows |
| Connection pooling | With a pool of one connection, the person context is gone the moment the transaction ends |
| Separation by cryptography alone | A raw dump contains no plaintext. A's data key cannot open B's content. B's wrapped key presented as A's will not unwrap. Ciphertext moved to another row or another column will not decrypt. Tampered ciphertext is rejected |
| The one cross-person question | The dispatcher gets due person ids through a single function and cannot read the schedule table directly |
| Audit log | Every key unwrap is recorded in that person's log. Entries cannot be edited or deleted, and A cannot write into B's log |
| Coverage | Every table in the schema has row-level security enabled and forced |

**The design the prototype proves**

- **Key-encryption key:** one key in a managed key service. It never leaves the service and is never in the database, the repository or a log.
- **Data key:** one random 256-bit key per person, made at sign-up, stored only in wrapped form in `user_keys`. The person's id is bound into the wrapping as authenticated context, so a wrapped key copied onto another row is useless.
- **Content:** AES-256-GCM in application code, never in SQL, so plaintext never appears in a query, a query log or the Supabase dashboard. Each value is bound to its person, table, column and row.
- **Clear columns:** only what code needs for arithmetic and scheduling: dates, durations, status, category ids, timestamps. Titles, notes, messages, memory and raw intake items are ciphertext. The consequence is that the database cannot search or sort by content; that happens in the application after decryption, which is fine at this scale.
- **The worker:** logs in as a dedicated role with no table privileges of its own. For each run it opens one transaction, becomes `authenticated`, sets the person id for that transaction only, reads that person's wrapped key under row-level security, asks the key service to unwrap it, and holds the plain key in memory until the run ends. It never uses the service-role key for people's data.
- **The web server:** the same path, using the signed-in person's own token.
- **The dispatcher:** the single place a query spans people. It is one function that returns ids and nothing else.
- **Diary lock:** a separate diary key that is wrapped in the browser by a key derived from the person's passphrase, with a second copy wrapped by the recovery code. The server stores ciphertext only and has nothing that can open it.

**Facts from the documentation**

- Supabase advises against pgsodium and transparent column encryption, both headed for deprecation. Supabase Vault protects disks and backups but anyone with the service role, the `postgres` role or dashboard SQL access can read its decrypted view. So per-person encryption has to be done by the application with the top key held outside Supabase, which is what the prototype does.
- The service-role key bypasses row-level security entirely, and so does a direct connection as `postgres`.
- Supabase is retiring the `anon` and `service_role` keys by the end of 2026 in favour of publishable and secret keys. `.env.example` currently names the old ones. A check of the local `.env` on 2026-11-18 (types only, values not printed) found the project is already on the new keys, but the two values are under each other's names: the secret key sat in the entry named for the anon key. The entries were renamed to `SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` the same day, in `.env.example` and in the local `.env`, with each value under the name that matches its type.
- Key services, for one key and about 3,000 unwraps a day: Azure Key Vault about $0.27 a month, Google Cloud KMS about $0.33, AWS KMS about $1.21 ($1 per key, 20,000 requests a month free). Cloudflare Secrets Store and Doppler cannot wrap or unwrap and are not key services.

## Decision

1. Application-level envelope encryption as described above. No pgsodium, no Vault for people's content.
2. The worker reaches people's data only through the per-transaction, per-person path. The service-role (secret) key is not present in the worker's environment at all.
3. Because the runner's environment variables were exposed in a real incident this month (spike 2), the worker's key-service credential is limited to unwrap, and its database login cannot bypass row-level security. A leaked worker environment then yields neither plaintext nor other people's rows without also defeating row-level security.
4. Every table ships with a test that one person cannot read another's rows, plus one schema-wide test that fails if any table lacks forced row-level security. The prototype's checks become those tests.
5. Use Supabase's new publishable and secret keys, under entries named for them in `.env.example` (done on 2026-11-18).
6. **Key service: AWS KMS**, for its native encryption context (the person-id binding is a first-class feature and can be required by policy), its per-action permissions (unwrap only), and its request log. It is about a dollar a month more than the cheapest option.

## Needs the owner

**Approved by the owner on 2026-11-18:** AWS KMS at about $1.21 a month. Still needed from him at the foundation step: an AWS account, one key and one unwrap-only credential, created by following written steps, with the two values placed in `.env`.

## Still open

- Confirm on the hosted project that a custom login role without bypass works through Supabase's connection pooler in transaction mode. The fallback is a short-lived signed token per person through the Data API. To be tested first thing at the foundation step, including the cross-person denial test.
- Choose the passphrase key-derivation function for the diary lock when the diary is built.
- Key rotation procedure (re-wrap data keys under a new top key; content is untouched). Designed for by the `kek_version` column, not exercised here.
