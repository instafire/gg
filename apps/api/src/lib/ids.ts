import { randomBytes } from "node:crypto";

/**
 * UUIDv7 (DATA_MODEL §0.1): time-ordered, generated in the app layer.
 * Layout: 48-bit unix-ms timestamp, version 7, variant 10, 62 random bits.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Short public code for posts (DATA_MODEL §0.1), 10 chars base62. */
export function shortCode(): string {
  const bytes = randomBytes(10);
  let out = "";
  for (const b of bytes) out += BASE62[b % BASE62.length];
  return out;
}

/**
 * ltree path label for a post (DATA_MODEL §5.1). ltree labels allow
 * [A-Za-z0-9_]; the UUID hex (dashes stripped) qualifies and UUIDv7's
 * time-ordering keeps sibling paths roughly chronological under ORDER BY path.
 */
export function pathLabel(postId: string): string {
  return postId.replaceAll("-", "");
}
