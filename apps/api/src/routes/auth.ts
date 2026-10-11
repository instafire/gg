import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { credentials, profiles, userSettings, users } from "../db/schema";
import { ageBracket, isMinorRestricted, isValidDateString, meetsMinAge } from "../lib/age";
import { requireAuth } from "../lib/auth";
import { conflict, forbidden, unauthorized, unprocessable } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { signLoginChallenge, verifyAccessToken } from "../lib/jwt";
import { hashPassword, verifyPassword } from "../lib/passwords";
import { userPrivateWire } from "../lib/serializers";
import { parseBody } from "../lib/validate";
import {
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  issueSession,
  revokeByRefreshToken,
  revokeSession,
  rotateSession,
  type TokenPair,
} from "../services/sessions";
import {
  insertVerificationToken,
  resendVerificationEmail,
  verificationUrl,
  verifyEmailWithToken,
} from "../services/email-verification";
import { createMailer, devLinksEnabled } from "../lib/mailer";
import {
  requestPasswordReset,
  resetPasswordWithToken,
} from "../services/password-reset";
import { getProfile, getUserById } from "../services/users";

const HANDLE_PATTERN = /^[a-z0-9_]{3,24}$/;

const registerSchema = z
  .object({
    handle: z.string(),
    email: z.string(),
    ["password"]: z.string(),
    displayName: z.string().max(50).optional(),
    display_name: z.string().max(50).optional(),
    dateOfBirth: z.string().optional(),
    date_of_birth: z.string().optional(),
  })
  .transform((value) => ({
    handle: value.handle.toLowerCase(),
    email: value.email.toLowerCase(),
    ["password"]: value.password,
    displayName: value.displayName ?? value.display_name,
    dateOfBirth: value.dateOfBirth ?? value.date_of_birth,
  }));

const loginSchema = z.object({
  email: z.string(),
  ["password"]: z.string(),
});

const refreshSchema = z.object({
  ["refresh_token"]: z.string().optional(),
  refreshToken: z.string().optional(),
});

const verifyEmailSchema = z.object({
  token: z.string().min(1),
});

const forgotPasswordSchema = z.object({
  email: z.string().min(1),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  new_password: z.string(),
});

const profileUpdateSchema = z.object({
  displayName: z.string().min(1).max(50).optional(),
  display_name: z.string().min(1).max(50).optional(),
  bio: z.string().max(500).nullable().optional(),
  websiteUrl: z.string().url().nullable().optional(),
  website_url: z.string().url().nullable().optional(),
  location: z.string().max(100).nullable().optional(),
  locationText: z.string().max(100).nullable().optional(),
  location_text: z.string().max(100).nullable().optional(),
  avatarMediaId: z.string().uuid().nullable().optional(),
  avatar_media_id: z.string().uuid().nullable().optional(),
  bannerMediaId: z.string().uuid().nullable().optional(),
  banner_media_id: z.string().uuid().nullable().optional(),
  isPrivate: z.boolean().optional(),
  is_private: z.boolean().optional(),
});



/** TokenPair wire shape (API_SPEC TokenPair schema, snake_case). */
export function tokenWire(pair: TokenPair): Record<string, unknown> {
  return {
    ["access_token"]: pair.access,
    ["refresh_token"]: pair.refresh,
    token_type: pair.tokenType,
    expires_in: pair.expiresIn,
  };
}

/** Cookie carrying a login 2FA challenge from the social-login callback. */
export const LOGIN_CHALLENGE_COOKIE = "gg_login_challenge";

export function setRefreshCookie(ctx: AppContext, reply: FastifyReply, token: string): void {
  reply.setCookie(REFRESH_COOKIE_NAME, token, {
    path: REFRESH_COOKIE_PATH,
    httpOnly: true,
    sameSite: "lax",
    secure: ctx.config.NODE_ENV === "production",
    maxAge: 30 * 24 * 60 * 60,
  });
}

function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db, config } = ctx;
  const mailer = createMailer(config, (message) => app.log.info(message));

  app.post("/api/v1/auth/register", async (request, reply) => {
    const body = parseBody(registerSchema, request.body);
    if (!HANDLE_PATTERN.test(body.handle)) {
      throw unprocessable("handle must be 3–24 chars of [a-z0-9_]");
    }
    if (!z.email().safeParse(body.email).success) {
      throw unprocessable("email is not a valid address");
    }
    if (body.password.length < 10 || body.password.length > 128) {
      throw unprocessable("password must be 10–128 characters");
    }
    if (!body.dateOfBirth || !isValidDateString(body.dateOfBirth)) {
      throw unprocessable("dateOfBirth must be a valid YYYY-MM-DD date");
    }
    const dob: string = body.dateOfBirth;
    if (!meetsMinAge(dob, config.MIN_AGE)) {
      throw unprocessable(`You must be at least ${config.MIN_AGE} years old to register`);
    }

    const [emailTaken] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);
    if (emailTaken) throw conflict("An account with this email already exists");
    const [handleTaken] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.handle, body.handle))
      .limit(1);
    if (handleTaken) throw conflict("This handle is already taken");

    const minor = isMinorRestricted(dob);
    const userId = uuidv7();
    const passwordHash = await hashPassword(body.password);
    // The verification token is issued in the same transaction as the
    // account (D-035); the raw token leaves only via the mailed link.
    let verificationRawToken: string | null = null;
    await db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        handle: body.handle,
        email: body.email,
        authorType: "human",
        trustTier: "T0",
        dateOfBirth: dob,
        isMinorRestricted: minor,
        ageBracket: ageBracket(dob),
        status: "active",
      });
      await tx.insert(profiles).values({
        userId,
        displayName: body.displayName ?? body.handle,
        // Minors start private (D-011 restricted defaults).
        isPrivate: minor,
      });
      await tx.insert(credentials).values({ id: uuidv7(), userId, passwordHash });
      await tx.insert(userSettings).values({ userId });
      verificationRawToken = await insertVerificationToken(tx, userId);
    });

    const user = await getUserById(db, userId);
    if (!user) throw unauthorized("Account creation failed");
    const pair = await issueSession(db, user, config.JWT_SECRET, request);
    setRefreshCookie(ctx, reply, pair.refresh);

    // Hand the link to the mailer (LogMailer until SMTP lands). A mailer
    // failure never fails registration — the user can resend.
    let devVerificationUrl: string | null = null;
    if (verificationRawToken) {
      const url = verificationUrl(config, verificationRawToken);
      try {
        await mailer.sendVerificationEmail(body.email, url);
      } catch (error) {
        request.log.error(
          error,
          "[email-verification] mailer failed during register",
        );
      }
      // D-035 staging affordance: while no real mailer is configured
      // (and never in production) the response carries the link so the
      // flow is testable. A configured SMTP mailer removes it (D-070).
      if (devLinksEnabled(config)) devVerificationUrl = url;
    }

    return reply.status(201).send({
      user: userPrivateWire(user, await getProfile(db, userId)),
      tokens: tokenWire(pair),
      ...(devVerificationUrl
        ? { dev_verification_url: devVerificationUrl }
        : {}),
    });
  });

  app.post("/api/v1/auth/verify-email", async (request, reply) => {
    const body = parseBody(verifyEmailSchema, request.body);
    const user = await verifyEmailWithToken(db, body.token);
    return reply.send({
      email_verified: true,
      user: userPrivateWire(user, await getProfile(db, user.id)),
    });
  });

  app.post(
    "/api/v1/auth/resend-verification",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      const me = request.authUser!;
      const user = await getUserById(db, me.sub);
      if (!user) throw unauthorized("Account no longer exists");
      const url = await resendVerificationEmail(db, config, mailer, user, (m) =>
        request.log.info(m),
      );
      return reply.status(202).send({
        status: url ? "pending" : "already_verified",
        ...(url && devLinksEnabled(config)
          ? { dev_verification_url: url }
          : {}),
      });
    },
  );

  app.post("/api/v1/auth/login", async (request, reply) => {
    const body = parseBody(loginSchema, request.body);
    const email = body.email.toLowerCase();
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    const [cred] = user
      ? await db
          .select()
          .from(credentials)
          .where(eq(credentials.userId, user.id))
          .limit(1)
      : [];
    // Always run an argon2 verify (against a throwaway hash when the account
    // or credential is missing) so login timing does not enumerate accounts.
    const hashToCheck = cred?.passwordHash ?? (await hashPassword("gg-timing-dummy"));
    const ok = await verifyPassword(hashToCheck, body.password);
    if (!user || !cred || !ok) throw unauthorized("Invalid email or password");
    if (
      user.status === "banned" ||
      user.status === "suspended" ||
      user.status === "deactivated"
    ) {
      throw forbidden("This account is not active");
    }
    // Second-factor gate (D-067): a TOTP-enabled account gets a
    // challenge, not a session. The challenge is exchanged at
    // POST /auth/2fa/totp/verify with a TOTP or recovery code.
    if (user.totpEnabled) {
      return reply.send({
        status: "totp_required",
        totp_required: true,
        challenge_token: signLoginChallenge(user.id, config.JWT_SECRET),
      });
    }
    const pair = await issueSession(db, user, config.JWT_SECRET, request);
    setRefreshCookie(ctx, reply, pair.refresh);
    return reply.send({
      user: userPrivateWire(user, await getProfile(db, user.id)),
      tokens: tokenWire(pair),
    });
  });

  // Password reset (D-070). Forgot is enumeration-safe: always 202.
  app.post("/api/v1/auth/password/forgot", async (request, reply) => {
    const body = parseBody(forgotPasswordSchema, request.body);
    const url = await requestPasswordReset(db, config, mailer, body.email, (m) =>
      request.log.info(m),
    );
    return reply.status(202).send({
      status: "pending",
      ...(url && devLinksEnabled(config) ? { dev_reset_url: url } : {}),
    });
  });

  app.post("/api/v1/auth/password/reset", async (request, reply) => {
    const body = parseBody(resetPasswordSchema, request.body);
    if (body.new_password.length < 10 || body.new_password.length > 128) {
      throw unprocessable("password must be 10–128 characters");
    }
    await resetPasswordWithToken(db, body.token, body.new_password);
    clearRefreshCookie(reply);
    return reply.send({ status: "password_reset" });
  });

  app.post("/api/v1/auth/refresh", async (request, reply) => {
    const body = parseBody(refreshSchema, request.body);
    const cookieToken = (request.cookies as Record<string, string | undefined>)[
      REFRESH_COOKIE_NAME
    ];
    const presented = body.refresh_token ?? body.refreshToken ?? cookieToken;
    if (!presented) throw unauthorized("No refresh token presented");
    const pair = await rotateSession(db, presented, config.JWT_SECRET, request);
    setRefreshCookie(ctx, reply, pair.refresh);
    return reply.send(tokenWire(pair));
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    // Best-effort revocation from whichever credential is presented.
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const claims = verifyAccessToken(
        authHeader.slice("Bearer ".length),
        config.JWT_SECRET,
      );
      if (claims) await revokeSession(db, claims.sid);
    }
    const cookieToken = (request.cookies as Record<string, string | undefined>)[
      REFRESH_COOKIE_NAME
    ];
    if (cookieToken) await revokeByRefreshToken(db, cookieToken);
    clearRefreshCookie(reply);
    return reply.status(204).send();
  });

  const meHandler = async (request: { authUser: { sub: string } | null }) => {
    const user = await getUserById(db, request.authUser!.sub);
    if (!user) throw unauthorized("Account no longer exists");
    return userPrivateWire(user, await getProfile(db, user.id));
  };

  app.get("/api/v1/me", { preHandler: requireAuth(ctx) }, async (request) =>
    meHandler(request),
  );
  app.get("/api/v1/users/me", { preHandler: requireAuth(ctx) }, async (request) =>
    meHandler(request),
  );

  const patchMe = async (request: {
    authUser: { sub: string } | null;
    body: unknown;
  }) => {
    const body = parseBody(profileUpdateSchema, request.body);
    const userId = request.authUser!.sub;
    const patch: Partial<typeof profiles.$inferInsert> = {};
    const displayName = body.displayName ?? body.display_name;
    if (displayName !== undefined) patch.displayName = displayName;
    if (body.bio !== undefined) patch.bio = body.bio;
    const websiteUrl = body.websiteUrl ?? body.website_url;
    if (websiteUrl !== undefined) patch.websiteUrl = websiteUrl;
    const location = body.location ?? body.locationText ?? body.location_text;
    if (location !== undefined) patch.locationText = location;
    const avatarMediaId = body.avatarMediaId ?? body.avatar_media_id;
    if (avatarMediaId !== undefined) patch.avatarMediaId = avatarMediaId;
    const bannerMediaId = body.bannerMediaId ?? body.banner_media_id;
    if (bannerMediaId !== undefined) patch.bannerMediaId = bannerMediaId;
    const isPrivate = body.isPrivate ?? body.is_private;
    if (isPrivate !== undefined) patch.isPrivate = isPrivate;
    if (Object.keys(patch).length > 0) {
      await db.update(profiles).set(patch).where(eq(profiles.userId, userId));
    }
    const user = await getUserById(db, userId);
    if (!user) throw unauthorized("Account no longer exists");
    return userPrivateWire(user, await getProfile(db, userId));
  };

  app.patch("/api/v1/me", { preHandler: requireAuth(ctx) }, async (request) =>
    patchMe(request),
  );
  app.patch("/api/v1/users/me", { preHandler: requireAuth(ctx) }, async (request) =>
    patchMe(request),
  );
}
