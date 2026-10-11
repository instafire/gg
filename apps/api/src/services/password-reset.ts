import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { AppConfig } from "../config";
import type { Db } from "../db";
import { credentials, passwordResetTokens, users } from "../db/schema";
import { badRequest } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import type { Mailer } from "../lib/mailer";
import { hashPassword } from "../lib/passwords";
import { revokeAllSessions } from "./sessions";

/**
 * Password reset (hardening, D-070). Mirrors the email-verification
 * token discipline (D-035): raw token only in the emailed link, SHA-256
 * hash at rest, single-use, short TTL — 1 hour here. Requesting a reset
 * is enumeration-safe: the route answers 202 whether or not the account
 * exists. A successful reset revokes every session (API_SPEC).
 */

const TOKEN_TTL_MS = 60 * 60 * 1000;

/** Single generic failure for every bad-token case. */
export const RESET_LINK_ERROR =
  "This password reset link is invalid or has expired. Request a new one and try again.";

export function hashResetToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/** The emailed link: the web app's /reset-password page consumes it. */
export function passwordResetUrl(config: AppConfig, rawToken: string): string {
  return `${config.APP_BASE_URL}/reset-password?token=${encodeURIComponent(rawToken)}`;
}

/**
 * Issue a reset token for the user (invalidating prior unused ones) and
 * hand the link to the mailer. Returns the raw URL for the D-070 dev
 * affordance; mailer failures are logged, never fatal.
 */
export async function requestPasswordReset(
  db: Db,
  config: AppConfig,
  mailer: Mailer,
  email: string,
  log: (message: string) => void,
): Promise<string | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  if (!user || user.deletedAt || !user.email) return null;
  const rawToken = await db.transaction(async (tx) => {
    const token = randomBytes(32).toString("base64url");
    await tx
      .delete(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.userId, user.id),
          isNull(passwordResetTokens.usedAt),
        ),
      );
    await tx.insert(passwordResetTokens).values({
      id: uuidv7(),
      userId: user.id,
      tokenHash: hashResetToken(token),
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    });
    return token;
  });
  const url = passwordResetUrl(config, rawToken);
  try {
    await mailer.sendPasswordResetEmail(user.email, url);
  } catch (error) {
    log(
      `[password-reset] mailer failed for user ${user.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return url;
}

/**
 * Consume a reset token: burn it, set the new password, revoke all
 * sessions. Every failure throws the same generic 400.
 */
export async function resetPasswordWithToken(
  db: Db,
  rawToken: string,
  newPassword: string,
): Promise<void> {
  const tokenHash = hashResetToken(rawToken);
  const [row] = await db
    .select()
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.tokenHash, tokenHash))
    .limit(1);
  if (!row || row.usedAt !== null || row.expiresAt.getTime() <= Date.now()) {
    throw badRequest(RESET_LINK_ERROR);
  }
  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(eq(passwordResetTokens.id, row.id));
    const [cred] = await tx
      .select()
      .from(credentials)
      .where(eq(credentials.userId, row.userId))
      .limit(1);
    if (cred) {
      await tx
        .update(credentials)
        .set({ passwordHash, updatedAt: now })
        .where(eq(credentials.id, cred.id));
    } else {
      await tx.insert(credentials).values({
        id: uuidv7(),
        userId: row.userId,
        passwordHash,
      });
    }
    await revokeAllSessions(tx, row.userId);
  });
}
