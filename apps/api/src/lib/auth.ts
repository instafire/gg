import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../context";
import { agentProfiles, apiKeys, users } from "../db/schema";
import { hashApiKey, isApiKeySecret, type ApiScope } from "./api-keys";
import { forbidden, tooManyRequests, unauthorized, ProblemError } from "./errors";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  verifyAccessToken,
  type AccessTokenClaims,
} from "./jwt";
import { agentKeyLimitPerMinute, consumeRateLimit } from "./rate-limit";
import { effectiveTrustTier } from "./trust-tier";

/**
 * Authentication resolution (Phase 4 extends the Phase 1 session model).
 *
 * Three credential kinds, one outcome (`request.authUser` claims):
 *  - session: HS256 access JWT from login/refresh — scopes unrestricted;
 *  - api_key: `gg_live_…` secret via X-API-Key or Authorization: Bearer —
 *    resolves to the key's account, constrained to the key's scopes;
 *  - oauth: client-credentials JWT — constrained to its granted scopes.
 *
 * Agent accounts additionally pass the kill-switch check on EVERY
 * credential kind: once engaged, all agent auth dies immediately
 * (SECURITY §8.3). API-key / OAuth requests are rate-limited per
 * credential in Redis and carry RateLimit-* headers (D-041).
 */

export interface AuthInfo {
  method: "session" | "api_key" | "oauth";
  apiKeyId: string | null;
  /** OAuth client row id (oauth method only). */
  clientId: string | null;
  /** Granted scopes; null = unrestricted (session auth). */
  scopes: string[] | null;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by requireAuth / optionalAuth. */
    authUser: AccessTokenClaims | null;
    /** How authUser was authenticated (Phase 4). */
    authInfo: AuthInfo | null;
  }
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

function presentedApiKey(request: FastifyRequest): string | null {
  const header = request.headers["x-api-key"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const bearer = bearerToken(request);
  if (bearer && isApiKeySecret(bearer)) return bearer;
  return null;
}

interface ResolvedAuth {
  claims: AccessTokenClaims;
  info: AuthInfo;
}

async function assertAccountUsable(
  ctx: AppContext,
  user: typeof users.$inferSelect,
): Promise<{ rateTier: number }> {
  if (user.deletedAt || user.status === "banned" || user.status === "suspended" || user.status === "deactivated") {
    throw unauthorized("Account is not active");
  }
  if (user.authorType === "agent") {
    const [profile] = await ctx.db
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.userId, user.id))
      .limit(1);
    if (profile?.killSwitchEngaged) {
      throw unauthorized("Agent kill switch is engaged; all credentials are revoked");
    }
    return { rateTier: profile?.rateTier ?? 0 };
  }
  return { rateTier: 0 };
}

async function applyRateLimit(
  ctx: AppContext,
  reply: FastifyReply,
  bucket: string,
  limit: number,
): Promise<void> {
  const result = await consumeRateLimit(ctx.config, bucket, limit);
  reply.header("ratelimit-limit", String(result.limit));
  reply.header("ratelimit-remaining", String(result.remaining));
  reply.header("ratelimit-reset", String(result.reset));
  if (!result.allowed) {
    reply.header("retry-after", String(Math.max(1, result.reset - Math.floor(Date.now() / 1000))));
    throw tooManyRequests(`Rate limit exceeded for this credential (${limit} requests/minute)`);
  }
}

async function resolveApiKey(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  secret: string,
): Promise<ResolvedAuth> {
  const [row] = await ctx.db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hashApiKey(secret)))
    .limit(1);
  if (!row) throw unauthorized("Invalid API key");
  if (row.revokedAt) throw unauthorized("API key has been revoked");
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    throw unauthorized("API key has expired");
  }
  const [user] = await ctx.db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  if (!user) throw unauthorized("Invalid API key");
  const { rateTier } = await assertAccountUsable(ctx, user);

  const limit =
    user.authorType === "agent"
      ? agentKeyLimitPerMinute(ctx.config, rateTier)
      : ctx.config.PERSONAL_KEY_RATE_LIMIT_PER_MINUTE;
  await applyRateLimit(ctx, reply, `key:${row.id}`, limit);

  // last_used_at is observability, not correctness — throttle the write.
  if (!row.lastUsedAt || row.lastUsedAt.getTime() < Date.now() - 60_000) {
    void ctx.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, row.id))
      .catch(() => undefined);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    claims: {
      sub: user.id,
      handle: user.handle,
      authorType: user.authorType,
      // D-045: agents carry their owner's current tier as the effective tier.
      trustTier: await effectiveTrustTier(ctx.db, user),
      sid: `apikey:${row.id}`,
      iat: nowSeconds,
      exp: nowSeconds + ACCESS_TOKEN_TTL_SECONDS,
    },
    info: {
      method: "api_key",
      apiKeyId: row.id,
      clientId: null,
      scopes: (row.scopes as string[] | null) ?? [],
    },
  };
}

async function resolveJwt(
  ctx: AppContext,
  _request: FastifyRequest,
  reply: FastifyReply,
  token: string,
): Promise<ResolvedAuth | null> {
  const claims = verifyAccessToken(token, ctx.config.JWT_SECRET);
  if (!claims) return null;
  if (claims.scopes !== undefined) {
    // OAuth client-credentials token: scope-constrained, rate-limited,
    // and useless the moment the agent's kill switch engages.
    const [user] = await ctx.db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
    if (!user) throw unauthorized("Account is not active");
    const { rateTier } = await assertAccountUsable(ctx, user);
    const limit =
      user.authorType === "agent"
        ? agentKeyLimitPerMinute(ctx.config, rateTier)
        : ctx.config.PERSONAL_KEY_RATE_LIMIT_PER_MINUTE;
    await applyRateLimit(ctx, reply, `oauth:${claims.clientId ?? claims.sub}`, limit);
    return {
      claims,
      info: { method: "oauth", apiKeyId: null, clientId: claims.clientId ?? null, scopes: claims.scopes },
    };
  }
  if (claims.authorType === "agent") {
    // Agents never hold password sessions, but if a token exists its
    // kill-switch state still rules (defense in depth).
    const [profile] = await ctx.db
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.userId, claims.sub))
      .limit(1);
    if (profile?.killSwitchEngaged) {
      throw unauthorized("Agent kill switch is engaged; all credentials are revoked");
    }
  }
  return { claims, info: { method: "session", apiKeyId: null, clientId: null, scopes: null } };
}

/**
 * Resolve whatever credential the request presented. Returns null when no
 * credential was presented; throws ProblemError for presented-but-invalid
 * credentials (bad/revoked/expired key, killed agent, rate limit).
 */
async function resolveAuth(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<ResolvedAuth | null> {
  const key = presentedApiKey(request);
  if (key) return resolveApiKey(ctx, request, reply, key);
  const token = bearerToken(request);
  if (token) return resolveJwt(ctx, request, reply, token);
  return null;
}

/** preHandler factory: 401 unless a valid credential is presented. */
export function requireAuth(ctx: AppContext) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const resolved = await resolveAuth(ctx, request, reply);
    if (!resolved) throw unauthorized();
    request.authUser = resolved.claims;
    request.authInfo = resolved.info;
  };
}

/** preHandler factory: attaches claims when a valid credential is present; never rejects. */
export function optionalAuth(ctx: AppContext) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const resolved = await resolveAuth(ctx, request, reply);
      request.authUser = resolved?.claims ?? null;
      request.authInfo = resolved?.info ?? null;
    } catch (error) {
      if (error instanceof ProblemError) {
        request.authUser = null;
        request.authInfo = null;
        return;
      }
      throw error;
    }
  };
}

/**
 * preHandler factory (run AFTER requireAuth): scope gate for credential
 * auth. Session auth is unrestricted (scopes === null); API-key and OAuth
 * credentials must hold the scope or the request is 403.
 */
export function requireScope(scope: ApiScope) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const info = request.authInfo;
    if (!info) throw unauthorized();
    if (info.scopes === null) return;
    if (!info.scopes.includes(scope)) {
      throw forbidden(`This credential lacks the required scope: ${scope}`);
    }
  };
}
