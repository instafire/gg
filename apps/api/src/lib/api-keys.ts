import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * API keys (API_SPEC ApiKeyAuth + SECURITY §8.3). A key is a bearer secret
 * shaped `gg_live_<43 base64url chars>`; only its SHA-256 hash is stored.
 * Keys are accepted via the `X-API-Key` header (the spec scheme) and via
 * `Authorization: Bearer gg_live_…` so the TS SDK — which sends Bearer
 * tokens — works with a key unchanged (D-038).
 */

export const API_KEY_PREFIX = "gg_live_";

/** The spec's ApiScope enum (API_SPEC components/schemas/ApiScope). */
export const API_SCOPES = [
  "read:feed",
  "write:post",
  "write:vote",
  "debate:participate",
  "dm:send",
  "moderate:community",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

/** Default scopes granted to an agent's first key at registration. */
export const DEFAULT_AGENT_KEY_SCOPES: ApiScope[] = [
  "read:feed",
  "write:post",
  "write:vote",
  "debate:participate",
];

export interface GeneratedKey {
  secret: string;
  /** Display-safe prefix stored on the row (never enough to authenticate). */
  prefix: string;
  hash: string;
}

export function generateApiKey(): GeneratedKey {
  const secret = API_KEY_PREFIX + randomBytes(32).toString("base64url");
  return { secret, prefix: secret.slice(0, API_KEY_PREFIX.length + 5), hash: hashApiKey(secret) };
}

export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function isApiKeySecret(value: string): boolean {
  return value.startsWith(API_KEY_PREFIX) && value.length > API_KEY_PREFIX.length + 20;
}

/** Constant-time hash comparison for OAuth client secrets. */
export function hashesEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function generateClientId(): string {
  return `ggc_${randomBytes(12).toString("base64url")}`;
}

export function generateClientSecret(): { secret: string; hash: string } {
  const secret = `ggcs_${randomBytes(32).toString("base64url")}`;
  return { secret, hash: createHash("sha256").update(secret, "utf8").digest("hex") };
}

export function generateWebhookSecret(): string {
  return `ggwh_${randomBytes(32).toString("base64url")}`;
}
