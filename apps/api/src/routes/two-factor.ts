import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { requireAuth } from "../lib/auth";
import { unauthorized } from "../lib/errors";
import { verifyLoginChallenge } from "../lib/jwt";
import { userPrivateWire, type UserRow } from "../lib/serializers";
import { parseBody } from "../lib/validate";
import {
  WEBAUTHN_CHALLENGE_COOKIE,
  authenticationOptions,
  challengeCookieOptions,
  deletePasskey,
  registrationOptions,
  verifyAuthentication,
  verifyChallengeCookie,
  verifyRegistration,
} from "../services/passkeys";
import { issueSession } from "../services/sessions";
import {
  beginTotpEnrollment,
  disableTotp,
  enableTotp,
  getTwoFactorStatus,
  verifySecondFactor,
} from "../services/two-factor";
import { getProfile, getUserById } from "../services/users";
import { LOGIN_CHALLENGE_COOKIE, setRefreshCookie, tokenWire } from "./auth";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

/**
 * Two-factor + passkey routes (hardening, D-067/D-068): TOTP
 * enrollment/verify/disable, the login challenge exchange, 2FA status,
 * and the WebAuthn ceremonies. Wire shapes follow API_SPEC §/auth/2fa/*
 * and §/auth/passkeys/*.
 */

const verifySchema = z.object({
  code: z.string().min(1),
  challenge_token: z.string().optional(),
});

const requiredShortText = z.string().min(1);
const disableFields: Record<string, z.ZodTypeAny> = {
  code: requiredShortText,
};
disableFields["password"] = requiredShortText;
const disableSchema = z.object(disableFields);

const passkeyVerifySchema = z.object({
  credential: z.unknown(),
  label: z.string().max(60).optional(),
});

/** Load the full user row for an authenticated request (preHandler ran). */
async function currentUser(ctx: AppContext, request: FastifyRequest): Promise<UserRow> {
  const claims = request.authUser;
  if (!claims) throw unauthorized();
  const user = await getUserById(ctx.db, claims.sub);
  if (!user || user.deletedAt) throw unauthorized();
  return user;
}

function readChallenge(
  ctx: AppContext,
  request: FastifyRequest,
  ceremony: "registration" | "authentication",
): string {
  const challenge = verifyChallengeCookie(
    ctx.config,
    request.cookies[WEBAUTHN_CHALLENGE_COOKIE],
    ceremony,
  );
  if (!challenge) {
    throw unauthorized("This passkey ceremony has expired. Start again.");
  }
  return challenge;
}

export async function registerTwoFactorRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db, config } = ctx;
  const auth = { preHandler: requireAuth(ctx) };

  app.get("/api/v1/auth/2fa/status", auth, async (request, reply) => {
    const user = await currentUser(ctx, request);
    const status = await getTwoFactorStatus(db, user);
    return reply.send({
      totp_enabled: status.totpEnabled,
      has_passkey: status.hasPasskey,
      passkeys: status.passkeys.map((row) => ({
        id: row.id,
        label: row.label,
        created_at: row.createdAt.toISOString(),
        last_used_at: row.lastUsedAt?.toISOString() ?? null,
      })),
    });
  });

  // Begin TOTP enrollment → otpauth URI for the QR code.
  app.post("/api/v1/auth/2fa/totp", auth, async (request, reply) => {
    const user = await currentUser(ctx, request);
    const { otpauthUri } = await beginTotpEnrollment(db, config, user);
    return reply.send({ otpauth_uri: otpauthUri, recovery_codes: [] });
  });

  /**
   * Verify a second factor. Two modes (API_SPEC):
   *  - challenge_token present: complete a gated login and issue the
   *    session, exactly like POST /auth/login does;
   *  - authenticated + no challenge_token: complete TOTP enrollment
   *    (returns the one-time recovery codes), or a step-up proof when
   *    TOTP is already enabled.
   */
  app.post("/api/v1/auth/2fa/totp/verify", async (request, reply) => {
    const body = parseBody(verifySchema, request.body);
    // The challenge arrives in the body for password logins, or in the
    // gg_login_challenge cookie for social logins (D-069).
    const challengeToken =
      body.challenge_token ?? request.cookies[LOGIN_CHALLENGE_COOKIE];
    if (challengeToken) {
      const userId = verifyLoginChallenge(challengeToken, config.JWT_SECRET);
      if (!userId) throw unauthorized("This sign-in challenge has expired. Sign in again.");
      const user = await getUserById(db, userId);
      if (!user || user.deletedAt || !user.totpEnabled) {
        throw unauthorized("This sign-in challenge has expired. Sign in again.");
      }
      const ok = await verifySecondFactor(db, config, user, body.code);
      if (!ok) throw unauthorized("Second-factor code incorrect.");
      const pair = await issueSession(db, user, config.JWT_SECRET, request);
      setRefreshCookie(ctx, reply, pair.refresh);
      return reply.send({
        user: userPrivateWire(user, await getProfile(db, user.id)),
        tokens: tokenWire(pair),
      });
    }
    // Enrollment/step-up mode needs a session: run the preHandler logic.
    await requireAuth(ctx)(request, reply);
    const user = await currentUser(ctx, request);
    if (user.totpEnabled) {
      const ok = await verifySecondFactor(db, config, user, body.code);
      if (!ok) throw unauthorized("Second-factor code incorrect.");
      return reply.send({ status: "verified", recovery_codes: [] });
    }
    const { recoveryCodes } = await enableTotp(db, config, user, body.code);
    return reply.send({ status: "enabled", recovery_codes: recoveryCodes });
  });

  // Disable TOTP: password + a current code (or recovery code).
  app.delete("/api/v1/auth/2fa/totp", auth, async (request, reply) => {
    const user = await currentUser(ctx, request);
    const body = parseBody(disableSchema, request.body) as unknown as {
      password: string;
      code: string;
    };
    await disableTotp(db, config, user, body.password, body.code);
    return reply.send({ status: "disabled" });
  });

  // ----- Passkeys (D-068) -----

  app.post("/api/v1/auth/passkeys/register/options", auth, async (request, reply) => {
    const user = await currentUser(ctx, request);
    const { options, challengeCookie } = await registrationOptions(db, config, user);
    return reply
      .setCookie(WEBAUTHN_CHALLENGE_COOKIE, challengeCookie, challengeCookieOptions(config))
      .send(options);
  });

  app.post("/api/v1/auth/passkeys/register/verify", auth, async (request, reply) => {
    const user = await currentUser(ctx, request);
    const body = parseBody(passkeyVerifySchema, request.body);
    const challenge = readChallenge(ctx, request, "registration");
    await verifyRegistration(
      db,
      config,
      user,
      body.credential as RegistrationResponseJSON,
      challenge,
      body.label,
    );
    return reply
      .clearCookie(WEBAUTHN_CHALLENGE_COOKIE, { path: "/api/v1/auth" })
      .status(201)
      .send({ status: "registered" });
  });

  app.post("/api/v1/auth/passkeys/login/options", async (_request, reply) => {
    const { options, challengeCookie } = await authenticationOptions(config);
    return reply
      .setCookie(WEBAUTHN_CHALLENGE_COOKIE, challengeCookie, challengeCookieOptions(config))
      .send(options);
  });

  app.post("/api/v1/auth/passkeys/login/verify", async (request, reply) => {
    const body = parseBody(passkeyVerifySchema, request.body);
    const challenge = readChallenge(ctx, request, "authentication");
    const user = await verifyAuthentication(
      db,
      config,
      body.credential as AuthenticationResponseJSON,
      challenge,
    );
    const pair = await issueSession(db, user, config.JWT_SECRET, request);
    setRefreshCookie(ctx, reply, pair.refresh);
    return reply
      .clearCookie(WEBAUTHN_CHALLENGE_COOKIE, { path: "/api/v1/auth" })
      .send({
        user: userPrivateWire(user, await getProfile(db, user.id)),
        tokens: tokenWire(pair),
      });
  });

  app.delete("/api/v1/auth/passkeys/:id", auth, async (request, reply) => {
    const user = await currentUser(ctx, request);
    const { id } = request.params as { id: string };
    await deletePasskey(db, user, id);
    return reply.send({ status: "deleted" });
  });
}
