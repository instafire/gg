import { and, eq, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Db } from "../db";
import { refreshTokens, users } from "../db/schema";
import { unauthorized } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { signAccessToken, ACCESS_TOKEN_TTL_SECONDS } from "../lib/jwt";
import { newRefreshToken, refreshTokenHash } from "../lib/passwords";
import type { UserRow } from "../lib/serializers";

export const REFRESH_COOKIE_NAME = "gg_refresh";
/** Cookie is scoped to the auth endpoints only (task spec / SECURITY §3.4). */
export const REFRESH_COOKIE_PATH = "/api/v1/auth";
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30-day family lifetime

export interface TokenPair {
  access: string;
  refresh: string;
  tokenType: "Bearer";
  expiresIn: number;
}

interface RequestMeta {
  ip?: string;
  userAgent?: string;
  deviceLabel?: string;
}

function metaFromRequest(request: FastifyRequest): RequestMeta {
  return {
    ip: request.ip,
    userAgent: request.headers["user-agent"],
  };
}

async function insertRefreshRow(
  db: Db,
  userId: string,
  familyId: string,
  meta: RequestMeta,
): Promise<{ id: string; token: string }> {
  const token = newRefreshToken();
  const id = uuidv7();
  await db.insert(refreshTokens).values({
    id,
    userId,
    tokenHash: refreshTokenHash(token),
    familyId,
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    deviceLabel: meta.deviceLabel ?? null,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  });
  return { id, token };
}

function toTokenPair(
  user: UserRow,
  sessionId: string,
  refreshToken: string,
  jwtSecret: string,
): TokenPair {
  return {
    access: signAccessToken(
      {
        sub: user.id,
        handle: user.handle,
        authorType: user.authorType,
        trustTier: user.trustTier,
        sid: sessionId,
      },
      jwtSecret,
    ),
    refresh: refreshToken,
    tokenType: "Bearer",
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  };
}

/** Start a new session family (login / register). */
export async function issueSession(
  db: Db,
  user: UserRow,
  jwtSecret: string,
  request: FastifyRequest,
): Promise<TokenPair> {
  const row = await insertRefreshRow(db, user.id, uuidv7(), metaFromRequest(request));
  return toTokenPair(user, row.id, row.token, jwtSecret);
}

/**
 * Rotate a refresh token (SECURITY §3.4). Reuse of an already-rotated or
 * revoked token revokes the ENTIRE family (theft detection) and 401s.
 */
export async function rotateSession(
  db: Db,
  presentedToken: string,
  jwtSecret: string,
  request: FastifyRequest,
): Promise<TokenPair> {
  const hash = refreshTokenHash(presentedToken);
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hash))
    .limit(1);
  if (!row) throw unauthorized("Invalid refresh token");

  if (row.rotatedAt !== null || row.revokedAt !== null) {
    // Reuse of a rotated/revoked token: kill the whole family.
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)),
      );
    throw unauthorized("Refresh token reuse detected; session family revoked");
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    throw unauthorized("Refresh token expired");
  }

  const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  if (
    !user ||
    user.status === "banned" ||
    user.status === "suspended" ||
    user.status === "deactivated"
  ) {
    throw unauthorized("Account is not active");
  }

  const next = await insertRefreshRow(db, user.id, row.familyId, metaFromRequest(request));
  await db
    .update(refreshTokens)
    .set({ rotatedAt: new Date(), replacedById: next.id, lastUsedAt: new Date() })
    .where(eq(refreshTokens.id, row.id));
  return toTokenPair(user, next.id, next.token, jwtSecret);
}

/** Revoke one session row (logout by session id from the access token). */
export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.id, sessionId), isNull(refreshTokens.revokedAt)));
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Revoke EVERY live session of a user (password reset, D-070). All
 * refresh-token families die; access tokens expire on their own TTL.
 */
export async function revokeAllSessions(db: Db | Tx, userId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

/** Revoke the session that owns a presented refresh token (logout via cookie). */
export async function revokeByRefreshToken(db: Db, token: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshTokens.tokenHash, refreshTokenHash(token)),
        isNull(refreshTokens.revokedAt),
      ),
    );
}
