// A person's data key: made once, stored wrapped, unwrapped per use.

import { generateDataKeyBytes, importDataKey, type DataKey } from "../crypto/envelope";
import type { KeyService } from "../crypto/key-service";
import type { UserDb } from "./user-context";

/**
 * Returns the person's data key, creating it on first use. The plain key
 * exists only in memory, as a non-extractable key object, for as long as the
 * caller holds it.
 */
export async function loadUserKey(db: UserDb, keys: KeyService): Promise<DataKey> {
  let row = (await db.query("select wrapped_dek from user_keys where user_id = $1", [db.userId])).rows[0];
  if (!row) {
    const fresh = generateDataKeyBytes();
    try {
      await db.query(
        "insert into user_keys (user_id, wrapped_dek, kek_id) values ($1, $2, $3) on conflict (user_id) do nothing",
        [db.userId, Buffer.from(await keys.wrap(fresh, db.userId)), keys.keyId],
      );
    } finally {
      fresh.fill(0);
    }
    // Read back what is stored: if two requests raced, both use the winner's key.
    row = (await db.query("select wrapped_dek from user_keys where user_id = $1", [db.userId])).rows[0];
    if (!row) throw new Error("could not create a data key for this person");
  }
  const raw = await keys.unwrap(new Uint8Array(row.wrapped_dek as Buffer), db.userId);
  try {
    return await importDataKey(raw);
  } finally {
    raw.fill(0);
  }
}
