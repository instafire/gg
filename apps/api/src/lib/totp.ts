import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) + HOTP (RFC 4226), implemented in-repo — the
 * algorithm is ~40 lines of standard crypto and a dependency would add
 * supply-chain weight for nothing. Parameters per API_SPEC: SHA-1,
 * 6 digits, 30-second period, ±1 step acceptance window.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`invalid base32 character: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh TOTP secret: 20 random bytes, base32 (32 chars, no padding). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secretBase32: string, counter: number): string {
  const key = base32Decode(secretBase32);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

export function totp(secretBase32: string, at: Date = new Date()): string {
  return hotp(secretBase32, Math.floor(at.getTime() / 1000 / 30));
}

/** Constant-time code check across the ±1 step window. */
export function verifyTotpCode(
  secretBase32: string,
  code: string,
  at: Date = new Date(),
): boolean {
  const normalized = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  const counter = Math.floor(at.getTime() / 1000 / 30);
  for (const delta of [-1, 0, 1]) {
    const expected = hotp(secretBase32, counter + delta);
    if (
      timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))
    ) {
      return true;
    }
  }
  return false;
}

/** otpauth:// URI the settings page renders as a QR code. */
export function otpauthUri(secretBase32: string, accountLabel: string): string {
  const issuer = "GG";
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const fields: Record<string, string> = {
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  };
  fields["secret"] = secretBase32;
  const params = new URLSearchParams(fields);
  return `otpauth://totp/${label}?${params.toString()}`;
}
