// Content encryption. AES-256-GCM through WebCrypto, so the same code runs in
// Node and in an edge runtime.
//
// Stored layout: version (1 byte) | nonce (12 bytes) | ciphertext and tag.
//
// Every value is bound to where it lives: the person, table, column and row
// are fed in as additional authenticated data. Ciphertext copied to another
// row, another column or another person fails to decrypt.

import type { webcrypto } from "node:crypto";

/** A person's data key, held as a key object that cannot be read back out. */
export type DataKey = webcrypto.CryptoKey;

const VERSION = 1;
const NONCE_BYTES = 12;
const subtle = globalThis.crypto.subtle;

/** Where an encrypted value lives. All four parts are bound into it. */
export interface FieldRef {
  userId: string;
  table: string;
  column: string;
  rowId: string;
}

const aadFor = (ref: FieldRef) =>
  new TextEncoder().encode([ref.userId, ref.table, ref.column, ref.rowId].join("|"));

/** Turns 32 raw key bytes into a key that can encrypt and decrypt but cannot be read back out. */
export async function importDataKey(raw: Uint8Array): Promise<DataKey> {
  if (raw.byteLength !== 32) throw new Error("a data key must be 32 bytes");
  return subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export function generateDataKeyBytes(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

export async function sealBytes(key: DataKey, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const body = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, plaintext));
  const out = new Uint8Array(1 + NONCE_BYTES + body.byteLength);
  out[0] = VERSION;
  out.set(nonce, 1);
  out.set(body, 1 + NONCE_BYTES);
  return out;
}

export async function openBytes(key: DataKey, blob: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  if (blob.byteLength < 1 + NONCE_BYTES + 16) throw new DecryptError();
  if (blob[0] !== VERSION) throw new DecryptError();
  const nonce = blob.subarray(1, 1 + NONCE_BYTES);
  try {
    return new Uint8Array(
      await subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, blob.subarray(1 + NONCE_BYTES)),
    );
  } catch {
    // Deliberately says nothing about why: wrong key, wrong place and tampering look the same.
    throw new DecryptError();
  }
}

/** Raised when a value will not decrypt. Carries no detail and no content. */
export class DecryptError extends Error {
  constructor() {
    super("could not decrypt");
    this.name = "DecryptError";
  }
}

export async function encryptField(key: DataKey, ref: FieldRef, plaintext: string): Promise<Buffer> {
  return Buffer.from(await sealBytes(key, new TextEncoder().encode(plaintext), aadFor(ref)));
}

export async function decryptField(key: DataKey, ref: FieldRef, blob: Uint8Array): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode(await openBytes(key, blob, aadFor(ref)));
}
