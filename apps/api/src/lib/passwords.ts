import { createHash, randomBytes } from "node:crypto";
import { hash, verify, Algorithm } from "@node-rs/argon2";

/**
 * Password hashing: argon2id with the SECURITY_AND_SAFETY §3 parameters
 * (m=64 MiB, t=3, p=4). Refresh tokens are stored as SHA-256 hashes only —
 * the token itself is never persisted (DATA_MODEL §2.4).
 */

const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 65_536, // 64 MiB in KiB
  timeCost: 3,
  parallelism: 4,
} as const;

export function hashPassword(candidate: string): Promise<string> {
  return hash(candidate, ARGON2_OPTIONS);
}

export function verifyPassword(passwordHash: string, candidate: string): Promise<boolean> {
  return verify(passwordHash, candidate).catch(() => false);
}

/** Opaque refresh token: 32 random bytes, base64url. */
export function newRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export function refreshTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
