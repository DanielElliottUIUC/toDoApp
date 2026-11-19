// The only way server code reaches a person's rows.
//
// One transaction, as the `authenticated` role, with that one person's id set
// for the length of the transaction. Row-level security then applies to the
// server exactly as it applies to that person signed in. Both settings are
// transaction-local: they vanish at commit or rollback, so nothing carries
// over to the next borrower of a pooled connection.

import type { Pool, PoolClient } from "pg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A database connection that can see exactly one person's rows. */
export interface UserDb {
  readonly userId: string;
  query: PoolClient["query"];
}

export async function withUser<T>(pool: Pool, userId: string, fn: (db: UserDb) => Promise<T>): Promise<T> {
  if (!UUID.test(userId)) throw new Error("withUser needs a person's id");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    const result = await fn({ userId, query: client.query.bind(client) as PoolClient["query"] });
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
