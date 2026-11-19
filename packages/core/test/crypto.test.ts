import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { DecryptCommand, EncryptCommand } from "@aws-sdk/client-kms";
import { AwsKmsKeyService, type KmsLike } from "../src/crypto/aws-kms";
import {
  DecryptError, decryptField, encryptField, generateDataKeyBytes, importDataKey, type FieldRef,
} from "../src/crypto/envelope";
import { LocalKeyService } from "../src/crypto/key-service";
import { withUser } from "../src/db/user-context";
import { loadUserKey } from "../src/db/user-keys";
import { createPerson, createTestDb, type TestDb } from "./helpers/db";

const keys = new LocalKeyService(crypto.randomBytes(32), { NODE_ENV: "test" });
const A = crypto.randomUUID();
const B = crypto.randomUUID();
const ref = (over: Partial<FieldRef> = {}): FieldRef => ({
  userId: A, table: "tasks", column: "title_enc", rowId: crypto.randomUUID(), ...over,
});

describe("content encryption", () => {
  it("round-trips text, including text that is not plain ASCII", async () => {
    const key = await importDataKey(generateDataKeyBytes());
    const r = ref();
    const text = "Call the clinic at 3 — naïve café, 日本語, 🙂";
    expect(await decryptField(key, r, await encryptField(key, r, text))).toBe(text);
  });

  it("produces different ciphertext each time and never contains the plaintext", async () => {
    const key = await importDataKey(generateDataKeyBytes());
    const r = ref();
    const one = await encryptField(key, r, "resignation letter");
    const two = await encryptField(key, r, "resignation letter");
    expect(one.equals(two)).toBe(false);
    expect(one.toString("latin1")).not.toContain("resignation");
  });

  it.each([
    ["another person", { userId: B }],
    ["another table", { table: "notes" }],
    ["another column", { column: "notes_enc" }],
    ["another row", { rowId: crypto.randomUUID() }],
  ])("will not decrypt when moved to %s", async (_label, change) => {
    const key = await importDataKey(generateDataKeyBytes());
    const r = ref();
    const blob = await encryptField(key, r, "secret");
    await expect(decryptField(key, { ...r, ...change }, blob)).rejects.toBeInstanceOf(DecryptError);
  });

  it("will not decrypt with another person's key", async () => {
    const r = ref();
    const blob = await encryptField(await importDataKey(generateDataKeyBytes()), r, "secret");
    await expect(decryptField(await importDataKey(generateDataKeyBytes()), r, blob)).rejects.toBeInstanceOf(DecryptError);
  });

  it("rejects tampered, truncated and unknown-version ciphertext", async () => {
    const key = await importDataKey(generateDataKeyBytes());
    const r = ref();
    const blob = await encryptField(key, r, "secret");
    const flipped = Buffer.from(blob); flipped[flipped.length - 1]! ^= 1;
    const versioned = Buffer.from(blob); versioned[0] = 9;
    for (const bad of [flipped, blob.subarray(0, 10), versioned, Buffer.alloc(0)]) {
      await expect(decryptField(key, r, bad)).rejects.toBeInstanceOf(DecryptError);
    }
  });

  it("gives an error that reveals nothing", async () => {
    const key = await importDataKey(generateDataKeyBytes());
    const err = await decryptField(key, ref(), Buffer.alloc(40)).then(() => new Error("was accepted"), (e: Error) => e);
    expect(err.message).toBe("could not decrypt");
  });

  it("does not let a data key be read back out", async () => {
    const key = await importDataKey(generateDataKeyBytes());
    expect(key.extractable).toBe(false);
  });
});

describe("local key service", () => {
  it("unwraps what it wrapped, for the same person only", async () => {
    const dek = generateDataKeyBytes();
    const wrapped = await keys.wrap(dek, A);
    expect(Buffer.from(await keys.unwrap(wrapped, A)).equals(Buffer.from(dek))).toBe(true);
    await expect(keys.unwrap(wrapped, B)).rejects.toBeInstanceOf(DecryptError);
  });

  it("cannot be unwrapped by a different top key", async () => {
    const other = new LocalKeyService(crypto.randomBytes(32), { NODE_ENV: "test" });
    await expect(other.unwrap(await keys.wrap(generateDataKeyBytes(), A), A)).rejects.toBeInstanceOf(DecryptError);
  });

  it("refuses to run in production", () => {
    expect(() => new LocalKeyService(crypto.randomBytes(32), { NODE_ENV: "production" })).toThrow(/production/);
  });

  it("refuses a top key of the wrong size or a missing one", () => {
    expect(() => new LocalKeyService(crypto.randomBytes(16), { NODE_ENV: "test" })).toThrow();
    expect(() => LocalKeyService.fromBase64(undefined, { NODE_ENV: "test" })).toThrow(/LOCAL_KEK_BASE64/);
  });
});

describe("AWS key service", () => {
  // A stand-in for AWS that behaves as KMS does: it will only decrypt when
  // given the same encryption context the value was encrypted under.
  function fakeKms() {
    const calls: { op: string; keyId?: string; context?: Record<string, string> }[] = [];
    const client: KmsLike = {
      async send(command) {
        const input = command.input as { KeyId?: string; Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array; EncryptionContext?: Record<string, string> };
        const ctx = JSON.stringify(input.EncryptionContext);
        if (command instanceof EncryptCommand) {
          calls.push({ op: "encrypt", keyId: input.KeyId, context: input.EncryptionContext });
          return { CiphertextBlob: Buffer.concat([Buffer.from(ctx + "\0"), Buffer.from(input.Plaintext!)]) };
        }
        if (command instanceof DecryptCommand) {
          calls.push({ op: "decrypt", keyId: input.KeyId, context: input.EncryptionContext });
          const blob = Buffer.from(input.CiphertextBlob!);
          const split = blob.indexOf(0);
          if (blob.subarray(0, split).toString() !== ctx) {
            throw Object.assign(new Error("bad context"), { name: "InvalidCiphertextException" });
          }
          return { Plaintext: new Uint8Array(blob.subarray(split + 1)) };
        }
        throw new Error("unexpected command");
      },
    };
    return { client, calls };
  }

  it("sends the person's id as encryption context on both wrap and unwrap", async () => {
    const { client, calls } = fakeKms();
    const svc = new AwsKmsKeyService("arn:aws:kms:us-east-2:000000000000:key/test", client);
    const dek = generateDataKeyBytes();
    const wrapped = await svc.wrap(dek, A);
    expect(Buffer.from(await svc.unwrap(wrapped, A)).equals(Buffer.from(dek))).toBe(true);
    expect(calls).toEqual([
      { op: "encrypt", keyId: "arn:aws:kms:us-east-2:000000000000:key/test", context: { purpose: "user-data-key", user_id: A } },
      { op: "decrypt", keyId: "arn:aws:kms:us-east-2:000000000000:key/test", context: { purpose: "user-data-key", user_id: A } },
    ]);
    expect(svc.keyId).toBe("aws-kms:arn:aws:kms:us-east-2:000000000000:key/test");
  });

  it("turns a refusal for the wrong person into a plain decrypt error", async () => {
    const { client } = fakeKms();
    const svc = new AwsKmsKeyService("arn:test", client);
    await expect(svc.unwrap(await svc.wrap(generateDataKeyBytes(), A), B)).rejects.toBeInstanceOf(DecryptError);
  });

  it("passes other AWS failures through unchanged", async () => {
    const client: KmsLike = { async send() { throw Object.assign(new Error("denied"), { name: "AccessDeniedException" }); } };
    await expect(new AwsKmsKeyService("arn:test", client).unwrap(new Uint8Array(8), A)).rejects.toThrow("denied");
  });

  it("needs a key id", () => {
    expect(() => new AwsKmsKeyService("", fakeKms().client)).toThrow(/AWS_KMS_KEY_ID/);
  });
});

describe("a person's data key in the database", () => {
  let db: TestDb;
  let p1: string;
  let p2: string;
  beforeAll(async () => {
    db = await createTestDb();
    p1 = await createPerson(db);
    p2 = await createPerson(db);
  });
  afterAll(async () => db.close());

  it("is created on first use and is the same key afterwards", async () => {
    const r: FieldRef = { userId: p1, table: "t", column: "c", rowId: "1" };
    const blob = await withUser(db.worker, p1, async (c) => encryptField(await loadUserKey(c, keys), r, "hello"));
    const back = await withUser(db.worker, p1, async (c) => decryptField(await loadUserKey(c, keys), r, blob));
    expect(back).toBe("hello");
    const rows = await db.admin.query("select kek_id from user_keys where user_id = $1", [p1]);
    expect(rows.rows).toEqual([{ kek_id: "local:v1" }]);
  });

  it("is stored only in wrapped form", async () => {
    await withUser(db.worker, p1, (c) => loadUserKey(c, keys));
    const stored = (await db.admin.query("select wrapped_dek from user_keys where user_id = $1", [p1])).rows[0].wrapped_dek as Buffer;
    const raw = await keys.unwrap(new Uint8Array(stored), p1);
    expect(stored.includes(Buffer.from(raw))).toBe(false);
  });

  it("differs between people, and one person's key cannot open another's content", async () => {
    const r: FieldRef = { userId: p1, table: "t", column: "c", rowId: "2" };
    const blob = await withUser(db.worker, p1, async (c) => encryptField(await loadUserKey(c, keys), r, "private"));
    const k2 = await withUser(db.worker, p2, (c) => loadUserKey(c, keys));
    await expect(decryptField(k2, r, blob)).rejects.toBeInstanceOf(DecryptError);
  });

  it("will not unwrap if the wrapped key is copied onto another person's row", async () => {
    await withUser(db.worker, p1, (c) => loadUserKey(c, keys));
    const p3 = await createPerson(db);
    await db.admin.query(
      "insert into user_keys (user_id, wrapped_dek, kek_id) select $1, wrapped_dek, kek_id from user_keys where user_id = $2", [p3, p1]);
    await expect(withUser(db.worker, p3, (c) => loadUserKey(c, keys))).rejects.toBeInstanceOf(DecryptError);
  });

  it("gives two simultaneous first uses the same key", async () => {
    const p4 = await createPerson(db);
    const r: FieldRef = { userId: p4, table: "t", column: "c", rowId: "3" };
    const pool2 = new (await import("pg")).default.Pool({ connectionString: (db.worker as unknown as { options: { connectionString: string } }).options.connectionString, max: 2 });
    try {
      const [k1, k2] = await Promise.all([
        withUser(pool2, p4, (c) => loadUserKey(c, keys)),
        withUser(pool2, p4, (c) => loadUserKey(c, keys)),
      ]);
      expect(await decryptField(k2, r, await encryptField(k1, r, "same"))).toBe("same");
    } finally {
      await pool2.end();
    }
  });
});
