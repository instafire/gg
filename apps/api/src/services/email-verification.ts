import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { AppConfig } from "../config";
import type { Db } from "../db";
import { emailVerificationTokens, users } from "../db/schema";
import { badRequest, tooManyRequests } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import type { Mailer } from "../lib/mailer";
import type { UserRow } from "../lib/serializers";

/** Transaction handle (same alias pattern as services/debates.ts). */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** Resend budget per user per rolling hour (D-035). */
const RESEND_LIMIT = 3;
const RESEND_WINDOW_MS = 60 * 60 * 1000;

/** Single generic failure for every bad-token case — never say which part failed. */
export const VERIFY_LINK_ERROR =
  "This verification link is invalid or has expired. Request a new one and try again.";

export function hashVerificationToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/** The emailed link: the web app's /verify-email page consumes the token. */
export function verificationUrl(config: AppConfig, rawToken: string): string {
  return `${config.APP_BASE_URL}/verify-email?token=${encodeURIComponent(rawToken)}`;
}

/**
 * Insert a fresh token row for the user. Caller supplies the executor so
 * registration can issue the token inside the account-creation transaction
 * (D-035). Prior unused tokens are deleted — only the newest link works.
 * Returns the raw token; only its hash is stored.
 */
export async function insertVerificationToken(
  tx: Tx,
  userId: string,
): Promise<string> {
  const rawToken = randomBytes(32).toString("base64url");
  await tx
    .delete(emailVerificationTokens)
    .where(
      and(
        eq(emailVerificationTokens.userId, userId),
        isNull(emailVerificationTokens.usedAt),
      ),
    );
  await tx.insert(emailVerificationTokens).values({
    id: uuidv7(),
    userId,
    tokenHash: hashVerificationToken(rawToken),
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  });
  return rawToken;
}

// Process-local resend limiter (same precedent as the poll ballot limiter in
// services/polls.ts; a shared store lands with the Redis rate-limit work).
const resendHits = new Map<string, number[]>();

function checkResendRateLimit(userId: string): void {
  const now = Date.now();
  const hits = (resendHits.get(userId) ?? []).filter(
    (t) => t > now - RESEND_WINDOW_MS,
  );
  if (hits.length >= RESEND_LIMIT) {
    throw tooManyRequests(
      "Too many verification emails requested — wait a while and try again",
    );
  }
  hits.push(now);
  resendHits.set(userId, hits);
}

/**
 * Issue a token and hand the link to the mailer. Returns the raw URL so the
 * route can include it as `dev_verification_url` outside production (D-035
 * staging affordance). Mailer failures are logged, never fatal: the account
 * exists either way and the user can resend.
 */
export async function sendVerificationEmail(
  db: Db,
  config: AppConfig,
  mailer: Mailer,
  user: Pick<UserRow, "id" | "email">,
  log: (message: string) => void,
): Promise<string> {
  const rawToken = await db.transaction((tx) =>
    insertVerificationToken(tx, user.id),
  );
  const url = verificationUrl(config, rawToken);
  if (user.email) {
    try {
      await mailer.sendVerificationEmail(user.email, url);
    } catch (error) {
      log(
        `[email-verification] mailer failed for user ${user.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return url;
}

/**
 * POST /auth/resend-verification core. Already-verified accounts are a
 * no-op (no token, no mail, no rate-limit budget spent). Returns the new
 * verification URL when one was issued, null for the no-op.
 */
export async function resendVerificationEmail(
  db: Db,
  config: AppConfig,
  mailer: Mailer,
  user: UserRow,
  log: (message: string) => void,
): Promise<string | null> {
  if (user.emailVerifiedAt !== null) return null;
  checkResendRateLimit(user.id);
  return sendVerificationEmail(db, config, mailer, user, log);
}

/**
 * Consume a raw token: marks it used, stamps users.email_verified_at, and
 * promotes the trust tier T0→T1 (only upward, only from T0 — D-035/D-014).
 * Every failure (unknown, used, expired) throws the same generic 400.
 * Returns the updated user row.
 */
export async function verifyEmailWithToken(
  db: Db,
  rawToken: string,
): Promise<UserRow> {
  const tokenHash = hashVerificationToken(rawToken);
  const [row] = await db
    .select()
    .from(emailVerificationTokens)
    .where(eq(emailVerificationTokens.tokenHash, tokenHash))
    .limit(1);
  if (!row || row.usedAt !== null || row.expiresAt.getTime() <= Date.now()) {
    throw badRequest(VERIFY_LINK_ERROR);
  }
  const user = await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(emailVerificationTokens)
      .set({ usedAt: now })
      .where(eq(emailVerificationTokens.id, row.id));
    const [current] = await tx
      .select()
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);
    if (!current) throw badRequest(VERIFY_LINK_ERROR);
    const patch: Partial<Pick<UserRow, "emailVerifiedAt" | "trustTier" | "updatedAt">> = {
      updatedAt: now,
    };
    if (current.emailVerifiedAt === null) patch.emailVerifiedAt = now;
    if (current.trustTier === "T0") patch.trustTier = "T1";
    const [updated] = await tx
      .update(users)
      .set(patch)
      .where(eq(users.id, current.id))
      .returning();
    return updated ?? null;
  });
  if (!user) throw badRequest(VERIFY_LINK_ERROR);
  return user;
}
