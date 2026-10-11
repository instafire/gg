import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { AppConfig } from "../config";

/**
 * Field-level encryption at rest (hardening, D-065). AES-256-GCM with a
 * random 12-byte IV per value; the stored form is
 * `enc:v1:<base64(iv ‖ authTag ‖ ciphertext)>` so ciphertext is always
 * distinguishable from legacy plaintext rows (everything written before
 * this module existed). Reads tolerate legacy plaintext; writes encrypt
 * whenever a key is configured.
 *
 * One key story for every recoverable secret: webhook signing secrets
 * (D-042) and TOTP shared secrets (D-067) both live behind this module,
 * keyed by WEBHOOK_ENCRYPTION_KEY (base64, 32 bytes). The worker carries
 * a copy of this module per the D-034 duplication precedent.
 */

export const ENCRYPTED_PREFIX = "enc:v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Resolve the configured key, or null when encryption is not configured. */
export function fieldEncryptionKey(config: AppConfig): Buffer | null {
  if (!config.WEBHOOK_ENCRYPTION_KEY) return null;
  return Buffer.from(config.WEBHOOK_ENCRYPTION_KEY, "base64");
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

/**
 * Decrypt a stored field. Legacy plaintext (no prefix) is returned as-is.
 * An encrypted value with no key configured is a hard error — failing
 * closed beats signing with garbage.
 */
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

/**
 * Encrypt for storage: returns ciphertext when a key is configured,
 * otherwise the legacy plaintext form (only reachable outside production —
 * loadConfig refuses to boot production without a key).
 */
export function encryptFieldIfKeyed(
  key: Buffer | null,
  plaintext: string,
): string {
  return key ? encryptField(key, plaintext) : plaintext;
}
