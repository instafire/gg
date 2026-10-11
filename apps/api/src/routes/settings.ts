/**
 * Account settings & lifecycle (API_SPEC: getMySettings, updateMySettings,
 * deactivateMe; round 2 adds change-password + email-change).
 *
 * Routes register under both `/api/v1/users/me/*` (spec) and `/api/v1/me/*`
 * (the alias pair the auth routes already use). Profile text fields stay on
 * PATCH /users/me (ProfileUpdate); this surface owns the UserSettings
 * document plus account-visibility (profiles.is_private).
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import {
  credentials,
  emailChangeRequests,
  profiles,
  refreshTokens,
  userSettings,
  users,
} from "../db/schema";
import { requireAuth } from "../lib/auth";
import { conflict, unprocessable } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { hashPassword, verifyPassword } from "../lib/passwords";
import { userSettingsWire, type UserSettingsRow } from "../lib/serializers";
import { parseBody } from "../lib/validate";
import { getProfile, getUserById } from "../services/users";

const quietHoursSchema = z
  .object({
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
  })
  .nullable();

const settingsPatchSchema = z.object({
  hide_ai_accounts: z.boolean().optional(),
  hideAiAccounts: z.boolean().optional(),
  hide_nsfw: z.boolean().optional(),
  hideNsfw: z.boolean().optional(),
  dm_policy: z.enum(["everyone", "followers", "mentioned", "none"]).optional(),
  dmPolicy: z.enum(["everyone", "followers", "mentioned", "none"]).optional(),
  mention_policy: z.enum(["everyone", "followers", "none"]).optional(),
  mentionPolicy: z.enum(["everyone", "followers", "none"]).optional(),
  read_receipts: z.boolean().optional(),
  readReceipts: z.boolean().optional(),
  presence_visible: z.boolean().optional(),
  presenceVisible: z.boolean().optional(),
  captions_default_on: z.boolean().optional(),
  captionsDefaultOn: z.boolean().optional(),
  font_scale: z.number().min(0.8).max(1.6).optional(),
  fontScale: z.number().min(0.8).max(1.6).optional(),
  high_contrast: z.boolean().optional(),
  highContrast: z.boolean().optional(),
  reduced_motion: z.boolean().optional(),
  reducedMotion: z.boolean().optional(),
  demographic_breakdowns_opt_in: z.boolean().optional(),
  demographicBreakdownsOptIn: z.boolean().optional(),
  language: z.string().min(2).max(10).optional(),
  notification_prefs: z.record(z.string(), z.boolean()).optional(),
  notificationPrefs: z.record(z.string(), z.boolean()).optional(),
  /** Phase 5B: per-type web-push toggles + digest cadence. */
  push_prefs: z.record(z.string(), z.boolean()).optional(),
  pushPrefs: z.record(z.string(), z.boolean()).optional(),
  digest_frequency: z.enum(["off", "daily", "weekly"]).optional(),
  digestFrequency: z.enum(["off", "daily", "weekly"]).optional(),
  quiet_hours: quietHoursSchema.optional(),
  quietHours: quietHoursSchema.optional(),
  /** Account visibility — applied to profiles.is_private. */
  is_private: z.boolean().optional(),
  isPrivate: z.boolean().optional(),
});

const changePasswordSchema = z.object({
  current_password: z.string().optional(),
  currentPassword: z.string().optional(),
  new_password: z.string().optional(),
  newPassword: z.string().optional(),
});

const emailChangeSchema = z.object({
  new_email: z.string().optional(),
  newEmail: z.string().optional(),
  email: z.string().optional(),
});

async function getOrCreateSettings(
  ctx: AppContext,
  userId: string,
): Promise<UserSettingsRow> {
  const { db } = ctx;
  const [row] = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  if (row) return row;
  const [created] = await db
    .insert(userSettings)
    .values({ userId })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [again] = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  return again!;
}

export async function registerSettingsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db } = ctx;
  const prefixes = ["/api/v1/users/me", "/api/v1/me"] as const;

  for (const prefix of prefixes) {
    app.get(
      `${prefix}/settings`,
      { preHandler: requireAuth(ctx) },
      async (request) => {
        const me = request.authUser!;
        const [settings, profile] = await Promise.all([
          getOrCreateSettings(ctx, me.sub),
          getProfile(db, me.sub),
        ]);
        return {
          ...userSettingsWire(settings),
          is_private: profile?.isPrivate ?? false,
        };
      },
    );

    app.patch(
      `${prefix}/settings`,
      { preHandler: requireAuth(ctx) },
      async (request) => {
        const body = parseBody(settingsPatchSchema, request.body);
        const me = request.authUser!;
        const current = await getOrCreateSettings(ctx, me.sub);
        const patch: Partial<typeof userSettings.$inferInsert> = {};
        const set = <K extends keyof typeof patch>(
          key: K,
          value: (typeof patch)[K] | undefined,
        ) => {
          if (value !== undefined) patch[key] = value;
        };
        set("hideAiAccounts", body.hide_ai_accounts ?? body.hideAiAccounts);
        set("hideNsfw", body.hide_nsfw ?? body.hideNsfw);
        set("dmPolicy", body.dm_policy ?? body.dmPolicy);
        set("mentionPolicy", body.mention_policy ?? body.mentionPolicy);
        set("readReceipts", body.read_receipts ?? body.readReceipts);
        set("presenceVisible", body.presence_visible ?? body.presenceVisible);
        set("captionsDefaultOn", body.captions_default_on ?? body.captionsDefaultOn);
        set("fontScale", body.font_scale ?? body.fontScale);
        set("highContrast", body.high_contrast ?? body.highContrast);
        set("reducedMotion", body.reduced_motion ?? body.reducedMotion);
        set(
          "demographicBreakdownsOptIn",
          body.demographic_breakdowns_opt_in ?? body.demographicBreakdownsOptIn,
        );
        set("language", body.language);
        const prefs = body.notification_prefs ?? body.notificationPrefs;
        if (prefs !== undefined) {
          patch.notificationPrefs = {
            ...((current.notificationPrefs ?? {}) as Record<string, boolean>),
            ...prefs,
          };
        }
        const pushPrefs = body.push_prefs ?? body.pushPrefs;
        if (pushPrefs !== undefined) {
          patch.pushPrefs = {
            ...((current.pushPrefs ?? {}) as Record<string, boolean>),
            ...pushPrefs,
          };
        }
        set("digestFrequency", body.digest_frequency ?? body.digestFrequency);
        const quiet = body.quiet_hours ?? body.quietHours;
        if (quiet !== undefined) patch.quietHours = quiet;
        if (Object.keys(patch).length > 0) {
          await db
            .update(userSettings)
            .set({ ...patch, updatedAt: new Date() })
            .where(eq(userSettings.userId, me.sub));
        }
        const isPrivate = body.is_private ?? body.isPrivate;
        if (isPrivate !== undefined) {
          await db
            .update(profiles)
            .set({ isPrivate, updatedAt: new Date() })
            .where(eq(profiles.userId, me.sub));
        }
        const [settings, profile] = await Promise.all([
          getOrCreateSettings(ctx, me.sub),
          getProfile(db, me.sub),
        ]);
        return {
          ...userSettingsWire(settings),
          is_private: profile?.isPrivate ?? false,
        };
      },
    );

    app.post(
      `${prefix}/change-password`,
      { preHandler: requireAuth(ctx) },
      async (request, reply) => {
        const body = parseBody(changePasswordSchema, request.body);
        const me = request.authUser!;
        const currentPassword = body.current_password ?? body.currentPassword;
        const newPassword = body.new_password ?? body.newPassword;
        if (!currentPassword || !newPassword) {
          throw unprocessable("current_password and new_password are required");
        }
        if (newPassword.length < 10 || newPassword.length > 128) {
          throw unprocessable("new password must be 10–128 characters");
        }
        const [cred] = await db
          .select()
          .from(credentials)
          .where(eq(credentials.userId, me.sub))
          .limit(1);
        if (!cred) throw unprocessable("This account has no password credential");
        const ok = await verifyPassword(cred.passwordHash, currentPassword);
        if (!ok) throw unprocessable("Current password is incorrect");
        if (newPassword === currentPassword) {
          throw unprocessable("New password must differ from the current password");
        }
        const passwordHash = await hashPassword(newPassword);
        // Keep the caller's own session family alive; every other session
        // (all other families) is revoked.
        const [currentRow] = await db
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.id, me.sid))
          .limit(1);
        await db.transaction(async (tx) => {
          await tx
            .update(credentials)
            .set({ passwordHash, updatedAt: new Date() })
            .where(eq(credentials.userId, me.sub));
          await tx
            .update(refreshTokens)
            .set({ revokedAt: new Date() })
            .where(
              and(
                eq(refreshTokens.userId, me.sub),
                isNull(refreshTokens.revokedAt),
                currentRow
                  ? ne(refreshTokens.familyId, currentRow.familyId)
                  : undefined,
              ),
            );
        });
        return reply.status(204).send();
      },
    );

    app.post(
      `${prefix}/email-change`,
      { preHandler: requireAuth(ctx) },
      async (request, reply) => {
        const body = parseBody(emailChangeSchema, request.body);
        const me = request.authUser!;
        const newEmail = (body.new_email ?? body.newEmail ?? body.email)?.toLowerCase();
        if (!newEmail || !z.email().safeParse(newEmail).success) {
          throw unprocessable("new_email must be a valid email address");
        }
        const user = await getUserById(db, me.sub);
        if (!user) throw unprocessable("Account no longer exists");
        if (user.email === newEmail) {
          throw unprocessable("That is already your account email");
        }
        const [taken] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, newEmail))
          .limit(1);
        if (taken) throw conflict("An account with this email already exists");
        // No mailer yet: the request row + hashed token are the record.
        // A confirmation endpoint lands with the email slice.
        const token = randomBytes(32).toString("base64url");
        const tokenHash = createHash("sha256").update(token).digest("hex");
        await db.transaction(async (tx) => {
          await tx
            .delete(emailChangeRequests)
            .where(
              and(
                eq(emailChangeRequests.userId, me.sub),
                isNull(emailChangeRequests.confirmedAt),
              ),
            );
          await tx.insert(emailChangeRequests).values({
            id: uuidv7(),
            userId: me.sub,
            newEmail,
            tokenHash,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          });
        });
        return reply.status(202).send({ status: "pending", new_email: newEmail });
      },
    );

    app.post(
      `${prefix}/deactivate`,
      { preHandler: requireAuth(ctx) },
      async (request, reply) => {
        const me = request.authUser!;
        await db.transaction(async (tx) => {
          await tx
            .update(users)
            .set({ status: "deactivated", updatedAt: new Date() })
            .where(eq(users.id, me.sub));
          await tx
            .update(refreshTokens)
            .set({ revokedAt: new Date() })
            .where(
              and(
                eq(refreshTokens.userId, me.sub),
                isNull(refreshTokens.revokedAt),
              ),
            );
        });
        return reply.status(204).send();
      },
    );
  }
}
