// The key service holds the one top key. It wraps and unwraps each person's
// data key and never hands the top key out.
//
// The person's id is bound into every wrap, so a wrapped key copied onto
// another person's row will not unwrap.

import { DecryptError, openBytes, sealBytes, type DataKey } from "./envelope";

export interface KeyService {
  /** Identifies the top key in use, stored beside each wrapped key for rotation. */
  readonly keyId: string;
  wrap(dataKey: Uint8Array, userId: string): Promise<Uint8Array>;
  /** Throws DecryptError if the wrapped key does not belong to this person. */
  unwrap(wrapped: Uint8Array, userId: string): Promise<Uint8Array>;
}

const contextFor = (userId: string) => new TextEncoder().encode(`user-data-key|${userId}`);

/**
 * A stand-in for development and tests: the top key is 32 bytes handed in by
 * the caller, normally from the LOCAL_KEK_BASE64 environment variable.
 *
 * It protects against a leaked database only as long as that variable is not
 * leaked with it, which is exactly the weakness a real key service removes.
 * It refuses to start in production.
 */
export class LocalKeyService implements KeyService {
  readonly keyId = "local:v1";
  readonly #key: Promise<DataKey>;

  constructor(topKey: Uint8Array, env: { NODE_ENV?: string } = process.env) {
    if (env.NODE_ENV === "production") {
      throw new Error("LocalKeyService must not be used in production; configure the AWS key service");
    }
    if (topKey.byteLength !== 32) throw new Error("the local top key must be 32 bytes");
    this.#key = globalThis.crypto.subtle.importKey("raw", topKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  static fromBase64(value: string | undefined, env: { NODE_ENV?: string } = process.env): LocalKeyService {
    if (!value) throw new Error("LOCAL_KEK_BASE64 is not set");
    return new LocalKeyService(new Uint8Array(Buffer.from(value, "base64")), env);
  }

  async wrap(dataKey: Uint8Array, userId: string): Promise<Uint8Array> {
    return sealBytes(await this.#key, dataKey, contextFor(userId));
  }

  async unwrap(wrapped: Uint8Array, userId: string): Promise<Uint8Array> {
    return openBytes(await this.#key, wrapped, contextFor(userId));
  }
}

export { DecryptError };
