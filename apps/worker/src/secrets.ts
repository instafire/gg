import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Worker copy of the API's field-encryption module (D-034 duplication
 * precedent; the two copies MUST agree on format). See
 * apps/api/src/lib/secrets.ts and DECISIONS D-065: AES-256-GCM, stored
 * as `enc:v1:<base64(iv ‖ tag ‖ ciphertext)>`, keyed by
 * WEBHOOK_ENCRYPTION_KEY. Legacy plaintext values pass through reads
 * unchanged. The worker only decrypts (webhook signing); encryption
 * lives in the API copy and is mirrored here for completeness.
 */

export const ENCRYPTED_PREFIX = "enc:v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Resolve the key from env, or null when encryption is not configured. */
export function fieldEncryptionKeyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Buffer | null {
  const raw = env.WEBHOOK_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      "WEBHOOK_ENCRYPTION_KEY must be the base64 encoding of exactly 32 bytes",
    );
  }
  return key;
}

export function isEncryptedField(stored: string): boolean {
  return stored.startsWith(ENCRYPTED_PREFIX);
}

export function encryptField(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return (
    ENCRYPTED_PREFIX +
    Buffer.concat([iv, tag, ciphertext]).toString("base64")
  );
}

export function decryptField(key: Buffer | null, stored: string): string {
  if (!isEncryptedField(stored)) return stored;
  if (!key) {
    throw new Error(
      "Encountered an encrypted field but WEBHOOK_ENCRYPTION_KEY is not configured",
    );
  }
  const raw = Buffer.from(stored.slice(ENCRYPTED_PREFIX.length), "base64");
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8",
  );
}
