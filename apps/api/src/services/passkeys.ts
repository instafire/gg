import { createHmac, timingSafeEqual } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { and, eq } from "drizzle-orm";
import type { AppConfig } from "../config";
import type { Db } from "../db";
import { passkeyCredentials, users } from "../db/schema";
import type { UserRow } from "../lib/serializers";
import { badRequest, notFound, unauthorized } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { getUserById } from "./users";
import { promoteTierForPasskey } from "./two-factor";

/**
 * Passkeys / WebAuthn (hardening, D-068) via @simplewebauthn/server.
 * Challenges are stateless: the challenge + ceremony purpose ride in an
 * HMAC-signed httpOnly cookie (signed with the JWT secret), so no
 * server-side challenge store is needed. A passkey is an ALTERNATIVE
 * login (passwordless), not a second factor on password login; adding
 * one still promotes the trust tier to T2 (D-067 rule).
 */

export const WEBAUTHN_CHALLENGE_COOKIE = "gg_webauthn_challenge";
const CHALLENGE_TTL_SECONDS = 300;

type Ceremony = "registration" | "authentication";

function signChallenge(config: AppConfig, ceremony: Ceremony, challenge: string): string {
  const mac = createHmac("sha256", config.JWT_SECRET)
    .update(`${ceremony}:${challenge}`)
    .digest("base64url");
  return `${ceremony}.${challenge}.${mac}`;
}

export function verifyChallengeCookie(
  config: AppConfig,
  cookieValue: string | undefined,
  ceremony: Ceremony,
): string | null {
  if (!cookieValue) return null;
  const parts = cookieValue.split(".");
  if (parts.length !== 3) return null;
  const [kind, challenge, mac] = parts as [string, string, string];
  if (kind !== ceremony || !challenge || !mac) return null;
  const expected = createHmac("sha256", config.JWT_SECRET)
    .update(`${ceremony}:${challenge}`)
    .digest("base64url");
  const given = Buffer.from(mac);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  return challenge;
}

export function challengeCookieOptions(config: AppConfig) {
  return {
    path: "/api/v1/auth",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.NODE_ENV === "production",
    maxAge: CHALLENGE_TTL_SECONDS,
  };
}

/** RP id: explicit env, else the APP_BASE_URL hostname (D-068). */
export function rpIdOf(config: AppConfig): string {
  return config.WEBAUTHN_RP_ID ?? new URL(config.APP_BASE_URL).hostname;
}

function expectedOrigins(config: AppConfig): string[] {
  const configured = config.WEBAUTHN_ORIGINS ?? [];
  return configured.length > 0 ? [...configured] : [config.APP_BASE_URL];
}

async function listUserCredentials(db: Db, userId: string) {
  return db
    .select()
    .from(passkeyCredentials)
    .where(eq(passkeyCredentials.userId, userId));
}

export async function registrationOptions(
  db: Db,
  config: AppConfig,
  user: UserRow,
): Promise<{ options: unknown; challengeCookie: string }> {
  const existing = await listUserCredentials(db, user.id);
  const options = await generateRegistrationOptions({
    rpName: config.WEBAUTHN_RP_NAME,
    rpID: rpIdOf(config),
    userID: new TextEncoder().encode(user.id),
    userName: user.handle,
    userDisplayName: user.handle,
    attestationType: "none",
    excludeCredentials: existing.map((row) => ({
      id: row.credentialId,
      transports: (row.transports ?? []) as AuthenticatorTransport[],
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });
  return {
    options,
    challengeCookie: signChallenge(config, "registration", options.challenge),
  };
}

type AuthenticatorTransport =
  | "ble"
  | "cable"
  | "hybrid"
  | "internal"
  | "nfc"
  | "smart-card"
  | "usb";

export async function verifyRegistration(
  db: Db,
  config: AppConfig,
  user: UserRow,
  response: RegistrationResponseJSON,
  expectedChallenge: string,
  label?: string,
): Promise<void> {
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: expectedOrigins(config),
    expectedRPID: rpIdOf(config),
    requireUserVerification: false,
  }).catch(() => null);
  if (!verification || !verification.verified || !verification.registrationInfo) {
    throw badRequest("Passkey registration could not be verified. Try again.");
  }
  const { credential } = verification.registrationInfo;
  const existing = await db
    .select()
    .from(passkeyCredentials)
    .where(eq(passkeyCredentials.credentialId, credential.id))
    .limit(1);
  if (existing.length > 0) {
    throw badRequest("That passkey is already registered.");
  }
  await db.insert(passkeyCredentials).values({
    id: uuidv7(),
    userId: user.id,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    transports: (credential.transports ?? []) as string[],
    deviceName: label ?? null,
  });
  await promoteTierForPasskey(db, user);
}

export async function authenticationOptions(
  config: AppConfig,
): Promise<{ options: unknown; challengeCookie: string }> {
  const options = await generateAuthenticationOptions({
    rpID: rpIdOf(config),
    userVerification: "preferred",
  });
  return {
    options,
    challengeCookie: signChallenge(config, "authentication", options.challenge),
  };
}

export async function verifyAuthentication(
  db: Db,
  config: AppConfig,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
): Promise<UserRow> {
  const [row] = await db
    .select()
    .from(passkeyCredentials)
    .where(eq(passkeyCredentials.credentialId, response.id))
    .limit(1);
  if (!row) throw unauthorized("That passkey isn't recognized.");
  const user = await getUserById(db, row.userId);
  if (!user || user.deletedAt) throw unauthorized("That passkey isn't recognized.");
  if (
    user.status === "banned" ||
    user.status === "suspended" ||
    user.status === "deactivated"
  ) {
    throw unauthorized("This account is not active");
  }
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: expectedOrigins(config),
    expectedRPID: rpIdOf(config),
    credential: {
      id: row.credentialId,
      publicKey: new Uint8Array(Buffer.from(row.publicKey, "base64url")),
      counter: row.counter,
      transports: (row.transports ?? []) as AuthenticatorTransport[],
    },
    requireUserVerification: false,
  }).catch(() => null);
  if (!verification || !verification.verified) {
    throw unauthorized("Passkey sign-in could not be verified.");
  }
  await db
    .update(passkeyCredentials)
    .set({
      counter: verification.authenticationInfo.newCounter,
      lastUsedAt: new Date(),
    })
    .where(eq(passkeyCredentials.id, row.id));
  return user;
}

export async function deletePasskey(
  db: Db,
  user: UserRow,
  passkeyId: string,
): Promise<void> {
  const [row] = await db
    .select()
    .from(passkeyCredentials)
    .where(
      and(
        eq(passkeyCredentials.id, passkeyId),
        eq(passkeyCredentials.userId, user.id),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Passkey not found");
  await db.delete(passkeyCredentials).where(eq(passkeyCredentials.id, row.id));
  const remaining = await listUserCredentials(db, user.id);
  if (remaining.length === 0) {
    await db
      .update(users)
      .set({ hasPasskey: false, updatedAt: new Date() })
      .where(eq(users.id, user.id));
  }
}
