import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Minimal HS256 JWT implementation for access tokens (SECURITY §3.4:
 * 15-minute access tokens; the signing algorithm choice was left to
 * Phase 1 — HS256 with a vault-held secret fits the single-host laptop
 * deployment, D-010; RS256/kid rotation is a later hardening step).
 */

export interface AccessTokenClaims {
  sub: string;
  handle: string;
  authorType: "human" | "agent";
  trustTier: string;
  /** Refresh-token row id (the session). */
  sid: string;
  /** Phase 4: OAuth client-credentials tokens carry their granted scopes. */
  scopes?: string[];
  /** Phase 4: OAuth client row id that minted this token. */
  clientId?: string;
  iat: number;
  exp: number;
}

export const ACCESS_TOKEN_TTL_SECONDS = 900;

/**
 * Login second-factor challenge (D-067): after a correct password, a
 * TOTP-enabled account gets this short-lived token instead of a session;
 * it is exchanged at POST /auth/2fa/totp/verify for the real session.
 * It is deliberately NOT an access token (no `sid` claim — verifyAccess
 * Token rejects it) and an access token is not a challenge (no
 * `purpose` claim).
 */
export const LOGIN_CHALLENGE_TTL_SECONDS = 300;

export function signLoginChallenge(
  userId: string,
  key: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      sub: userId,
      purpose: "login_2fa",
      iat: nowSeconds,
      exp: nowSeconds + LOGIN_CHALLENGE_TTL_SECONDS,
    }),
  );
  const signature = createHmac("sha256", key)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export function verifyLoginChallenge(
  token: string,
  key: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  const expected = createHmac("sha256", key)
    .update(`${header}.${payload}`)
    .digest("base64url");
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { sub?: unknown; purpose?: unknown; exp?: unknown };
    if (claims.purpose !== "login_2fa") return null;
    if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) return null;
    if (typeof claims.sub !== "string") return null;
    return claims.sub;
  } catch {
    return null;
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function signAccessToken(
  claims: Omit<AccessTokenClaims, "iat" | "exp">,
  key: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      ...claims,
      iat: nowSeconds,
      exp: nowSeconds + ACCESS_TOKEN_TTL_SECONDS,
    }),
  );
  const signature = createHmac("sha256", key)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export function verifyAccessToken(
  token: string,
  key: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): AccessTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  const expected = createHmac("sha256", key)
    .update(`${header}.${payload}`)
    .digest("base64url");
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as AccessTokenClaims;
    if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) return null;
    if (typeof claims.sub !== "string" || typeof claims.sid !== "string") return null;
    return claims;
  } catch {
    return null;
  }
}
