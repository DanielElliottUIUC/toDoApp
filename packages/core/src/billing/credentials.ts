// A person's own model-provider API key.
//
// Stored encrypted with that person's data key, shown back only as its last
// four characters, decrypted only at the moment a call is made, and never
// written to a log, an error message or the audit log.

import { audit, type Actor } from "../audit";
import { decryptField, encryptField, type DataKey, type FieldRef } from "../crypto/envelope";
import type { UserDb } from "../db/user-context";

export type Provider = "anthropic";

const refFor = (userId: string, provider: Provider): FieldRef => ({
  userId, table: "provider_credentials", column: "key_enc", rowId: `${userId}:${provider}`,
});

/** Thrown for a key that is plainly not one. The message never includes the key. */
export class InvalidApiKeyError extends Error {
  constructor() {
    super("that does not look like an API key");
    this.name = "InvalidApiKeyError";
  }
}

function checkShape(provider: Provider, apiKey: string): string {
  const key = apiKey.trim();
  // Shape only: long enough, no spaces, the provider's prefix. Whether it works is for the provider to say.
  if (key.length < 20 || /\s/.test(key) || (provider === "anthropic" && !key.startsWith("sk-ant-"))) {
    throw new InvalidApiKeyError();
  }
  return key;
}

export async function saveApiKey(db: UserDb, dataKey: DataKey, provider: Provider, apiKey: string): Promise<{ last4: string }> {
  const key = checkShape(provider, apiKey);
  const last4 = key.slice(-4);
  const enc = await encryptField(dataKey, refFor(db.userId, provider), key);
  await db.query(
    `insert into provider_credentials (user_id, provider, key_enc, key_last4) values ($1, $2, $3, $4)
     on conflict (user_id, provider) do update set key_enc = excluded.key_enc, key_last4 = excluded.key_last4, updated_at = now()`,
    [db.userId, provider, enc, last4],
  );
  await audit(db, { actor: "user", action: "credential.saved", target: "provider_credentials", meta: { provider } });
  return { last4 };
}

/** What may be shown on a settings page: that a key exists, and its last four characters. */
export async function describeApiKey(db: UserDb, provider: Provider): Promise<{ last4: string; updatedAt: Date } | null> {
  const r = await db.query(
    "select key_last4, updated_at from provider_credentials where user_id = $1 and provider = $2", [db.userId, provider]);
  return r.rows[0] ? { last4: r.rows[0].key_last4, updatedAt: r.rows[0].updated_at } : null;
}

/**
 * The plain key, for making one call. The caller must not store it, log it or
 * put it in an error. `actor` says who is using it and is written to the
 * person's audit log.
 */
export async function useApiKey(db: UserDb, dataKey: DataKey, provider: Provider, actor: Actor, purpose: string): Promise<string | null> {
  const r = await db.query("select key_enc from provider_credentials where user_id = $1 and provider = $2", [db.userId, provider]);
  if (!r.rows[0]) return null;
  const key = await decryptField(dataKey, refFor(db.userId, provider), new Uint8Array(r.rows[0].key_enc as Buffer));
  await audit(db, { actor, action: "credential.used", target: "provider_credentials", meta: { provider, purpose } });
  return key;
}

export async function removeApiKey(db: UserDb, provider: Provider): Promise<boolean> {
  const r = await db.query("delete from provider_credentials where user_id = $1 and provider = $2", [db.userId, provider]);
  if (r.rowCount === 1) {
    await audit(db, { actor: "user", action: "credential.removed", target: "provider_credentials", meta: { provider } });
  }
  return r.rowCount === 1;
}
