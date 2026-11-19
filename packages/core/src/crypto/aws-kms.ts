// The production key service: AWS KMS. The top key never leaves AWS.
//
// The person's id travels as KMS "encryption context". KMS refuses to decrypt
// unless the same context is presented, and the context appears in AWS's own
// request log, so every unwrap is recorded outside this app as well.
//
// The credential given to the job runner should be allowed kms:Decrypt on
// this one key and nothing else.

import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { DecryptError } from "./envelope";
import type { KeyService } from "./key-service";

/** The one method of the AWS client this file uses; lets tests stand in for AWS. */
export interface KmsLike {
  send(command: EncryptCommand | DecryptCommand): Promise<{ CiphertextBlob?: Uint8Array; Plaintext?: Uint8Array }>;
}

const contextFor = (userId: string) => ({ purpose: "user-data-key", user_id: userId });

export class AwsKmsKeyService implements KeyService {
  readonly keyId: string;
  readonly #client: KmsLike;

  /** @param keyArn the key's ARN or alias, from AWS_KMS_KEY_ID */
  constructor(keyArn: string, client: KmsLike = new KMSClient({}) as unknown as KmsLike) {
    if (!keyArn) throw new Error("AWS_KMS_KEY_ID is not set");
    this.keyId = `aws-kms:${keyArn}`;
    this.#client = client;
  }

  get #arn(): string {
    return this.keyId.slice("aws-kms:".length);
  }

  async wrap(dataKey: Uint8Array, userId: string): Promise<Uint8Array> {
    const out = await this.#client.send(
      new EncryptCommand({ KeyId: this.#arn, Plaintext: dataKey, EncryptionContext: contextFor(userId) }),
    );
    if (!out.CiphertextBlob) throw new Error("the key service returned nothing");
    return out.CiphertextBlob;
  }

  async unwrap(wrapped: Uint8Array, userId: string): Promise<Uint8Array> {
    try {
      const out = await this.#client.send(
        new DecryptCommand({ KeyId: this.#arn, CiphertextBlob: wrapped, EncryptionContext: contextFor(userId) }),
      );
      if (!out.Plaintext) throw new DecryptError();
      return out.Plaintext;
    } catch (e) {
      // A wrong person or a tampered key surfaces from KMS as InvalidCiphertextException.
      if (e instanceof DecryptError || (e as { name?: string }).name === "InvalidCiphertextException") {
        throw new DecryptError();
      }
      throw e;
    }
  }
}
