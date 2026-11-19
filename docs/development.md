# Development

## Layout

| Path | What it holds |
|---|---|
| `supabase/migrations/` | The database schema, as plain SQL. The source of truth for tables, row-level security and database functions. |
| `packages/core/` | Domain logic with no framework in it: encryption, per-person database access, the audit log, the job queue, message rules, key storage and spend costing. |
| `packages/core/test/` | Tests. They run the real migrations against a throwaway Postgres. |
| `spikes/` | Throwaway prototypes from build step 1. Not part of the app. |
| `docs/` | The brief, the research, spike results and the decision log. |

## Running the checks

```
npm install
npm run typecheck
npm test
```

`npm test` starts its own Postgres (the `embedded-postgres` package) in a temporary folder, applies a small stand-in for what a hosted Supabase project already provides (`packages/core/test/helpers/supabase-shim.sql`), applies every migration, runs the tests and removes everything. Nothing touches the hosted Supabase project and no secret is needed.

The same checks run on every pull request (`.github/workflows/checks.yml`), in UTC, so anything that quietly depends on the local time zone fails there.

## Rules the tests enforce

- Every table has row-level security enabled and forced. A new table that is not listed in `packages/core/test/isolation.test.ts` fails the suite, so a table cannot ship without an isolation test.
- The signed-out role has no privilege on anything.
- The job runner's login can read nothing until it is scoped to one person, and the tick's login can call three functions and read no table.

## Adding a table

1. Write the migration. Enable and force row-level security, revoke Supabase's default grants, then grant back only what is needed.
2. Name content columns with an `_enc` suffix and encrypt them with `encryptField`.
3. Add the table to `ownedTables` or `sharedTables` in the isolation test.
