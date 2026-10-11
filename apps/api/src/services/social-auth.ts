import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AppConfig } from "../config";
import type { Db } from "../db";
import { oauthIdentities, profiles, users, userSettings } from "../db/schema";
import type { UserRow } from "../lib/serializers";
import { uuidv7 } from "../lib/ids";

/**
 * Social sign-in (hardening, D-069): a generic OAuth 2.0
 * authorization-code engine for Google + Discord (Apple deferred — its
 * client-secret is an ES256 JWT, a separate build). Provider endpoints
 * come from env with real defaults, so tests point them at a mocked
 * provider. Account linking is by provider-VERIFIED email (D-005): an
 * unverified provider email is refused outright. New accounts are
 * created email-verified (T1) with no password credential (the owner
 * can set one later via password reset); date of birth is collected at
 * onboarding.
 */

export type SocialProviderId = "google" | "discord" | "apple";

export interface SocialProviderConfig {
  id: SocialProviderId;
  name: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scopes: string[];
}

const PROVIDER_DEFAULTS: Record<
  SocialProviderId,
  Omit<SocialProviderConfig, "id" | "clientId" | "clientSecret"> & {
    envPrefix: string;
  }
> = {
  google: {
    name: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scopes: ["openid", "email", "profile"],
    envPrefix: "OAUTH_GOOGLE",
  },
  discord: {
    name: "Discord",
    authorizeUrl: "https://discord.com/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    userinfoUrl: "https://discord.com/api/users/@me",
    scopes: ["identify", "email"],
    envPrefix: "OAUTH_DISCORD",
  },
  apple: {
    name: "Apple",
    authorizeUrl: "https://appleid.apple.com/auth/authorize",
    tokenUrl: "https://appleid.apple.com/auth/token",
    userinfoUrl: "",
    scopes: ["name", "email"],
    envPrefix: "OAUTH_APPLE",
  },
};

/** Providers with complete env config (Apple is never complete in v1). */
export function configuredSocialProviders(
  config: AppConfig,
): SocialProviderConfig[] {
  const out: SocialProviderConfig[] = [];
  for (const id of Object.keys(PROVIDER_DEFAULTS) as SocialProviderId[]) {
    if (id === "apple") continue; // D-069: deferred, see PROGRESS.
    const defaults = PROVIDER_DEFAULTS[id];
    const prefix = defaults.envPrefix as "OAUTH_GOOGLE" | "OAUTH_DISCORD";
    const clientId = config[`${prefix}_CLIENT_ID`];
    const clientSecret = config[`${prefix}_CLIENT_SECRET`];
    if (!clientId || !clientSecret) continue;
    out.push({
      id,
      name: defaults.name,
      clientId,
      clientSecret,
      authorizeUrl: config[`${prefix}_AUTHORIZE_URL`] ?? defaults.authorizeUrl,
      tokenUrl: config[`${prefix}_TOKEN_URL`] ?? defaults.tokenUrl,
      userinfoUrl: config[`${prefix}_USERINFO_URL`] ?? defaults.userinfoUrl,
      scopes: defaults.scopes,
    });
  }
  return out;
}

export function socialProviderById(
  config: AppConfig,
  id: string,
): SocialProviderConfig | null {
  return configuredSocialProviders(config).find((p) => p.id === id) ?? null;
}

export function socialRedirectUri(config: AppConfig, provider: SocialProviderId): string {
  return `${config.APP_BASE_URL}/api/v1/auth/oauth/${provider}/callback`;
}

export function socialAuthorizeUrl(
  config: AppConfig,
  provider: SocialProviderConfig,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: provider.clientId,
    redirect_uri: socialRedirectUri(config, provider.id),
    response_type: "code",
    scope: provider.scopes.join(" "),
    state,
  });
  if (provider.id === "google") params.set("access_type", "online");
  if (provider.id === "discord") params.set("prompt", "none");
  return `${provider.authorizeUrl}?${params.toString()}`;
}

// ── State cookie (HMAC-signed, like the WebAuthn challenge cookie) ─────

export const OAUTH_STATE_COOKIE = "gg_oauth_state";

export function signOAuthState(
  config: AppConfig,
  provider: SocialProviderId,
): { state: string; cookie: string } {
  const state = randomBytes(24).toString("base64url");
  const mac = createHmac("sha256", config.JWT_SECRET)
    .update(`oauth:${provider}:${state}`)
    .digest("base64url");
  return { state, cookie: `${provider}.${state}.${mac}` };
}

export function verifyOAuthState(
  config: AppConfig,
  cookieValue: string | undefined,
  provider: SocialProviderId,
  presentedState: string | null,
): boolean {
  if (!cookieValue || !presentedState) return false;
  const parts = cookieValue.split(".");
  if (parts.length !== 3) return false;
  const [kind, state, mac] = parts as [string, string, string];
  if (kind !== provider || state !== presentedState) return false;
  const expected = createHmac("sha256", config.JWT_SECRET)
    .update(`oauth:${provider}:${state}`)
    .digest("base64url");
  const given = Buffer.from(mac);
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

// ── Provider calls ──────────────────────────────────────────────────────

export interface SocialProfile {
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
}

async function exchangeCode(
  config: AppConfig,
  provider: SocialProviderConfig,
  code: string,
): Promise<string | null> {
  const formFields: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: socialRedirectUri(config, provider.id),
    client_id: provider.clientId,
  };
  const providerSecret = provider.clientSecret;
  formFields["client_secret"] = providerSecret;
  const response = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(formFields),
  }).catch(() => null);
  if (!response || !response.ok) return null;
  const data = (await response.json().catch(() => null)) as {
    access_token?: unknown;
  } | null;
  return typeof data?.access_token === "string" ? data.access_token : null;
}

async function fetchProfile(
  provider: SocialProviderConfig,
  accessToken: string,
): Promise<SocialProfile | null> {
  const response = await fetch(provider.userinfoUrl, {
    headers: { authorization: `Bearer ${accessToken}` },
  }).catch(() => null);
  if (!response || !response.ok) return null;
  const data = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!data) return null;
  if (provider.id === "google") {
    return {
      providerUserId: String(data.sub ?? ""),
      email: typeof data.email === "string" ? data.email.toLowerCase() : null,
      emailVerified: data.email_verified === true,
    };
  }
  // discord
  return {
    providerUserId: String(data.id ?? ""),
    email: typeof data.email === "string" ? data.email.toLowerCase() : null,
    emailVerified: data.verified === true,
  };
}

export async function fetchSocialProfile(
  config: AppConfig,
  provider: SocialProviderConfig,
  code: string,
): Promise<SocialProfile | null> {
  const accessToken = await exchangeCode(config, provider, code);
  if (!accessToken) return null;
  const profile = await fetchProfile(provider, accessToken);
  if (!profile || !profile.providerUserId) return null;
  return profile;
}

// ── Account resolution ─────────────────────────────────────────────────

export type SocialResolution =
  | { kind: "login"; user: UserRow }
  | { kind: "unverified_email" }
  | { kind: "error" };

async function uniqueHandle(db: Db, email: string): Promise<string> {
  const local = email.split("@")[0] ?? "user";
  let base = local
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20);
  if (base.length < 3) base = `${base}user`.slice(0, 20);
  let candidate = base;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.handle, candidate))
      .limit(1);
    if (!taken) return candidate;
    candidate = `${base.slice(0, 15)}${Math.floor(1000 + Math.random() * 9000)}`;
  }
  return `user_${randomBytes(4).toString("hex")}`;
}

export async function resolveSocialLogin(
  db: Db,
  provider: SocialProviderConfig,
  profile: SocialProfile,
): Promise<SocialResolution> {
  // 1. Known identity → its user.
  const [identity] = await db
    .select()
    .from(oauthIdentities)
    .where(
      and(
        eq(oauthIdentities.provider, provider.id),
        eq(oauthIdentities.providerUserId, profile.providerUserId),
      ),
    )
    .limit(1);
  if (identity) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, identity.userId))
      .limit(1);
    return user && !user.deletedAt ? { kind: "login", user } : { kind: "error" };
  }
  // 2. Linking is by provider-verified email only (D-005/D-069).
  if (!profile.email || !profile.emailVerified) {
    return { kind: "unverified_email" };
  }
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.email, profile.email))
    .limit(1);
  if (existing && !existing.deletedAt) {
    await db.insert(oauthIdentities).values({
      id: uuidv7(),
      userId: existing.id,
      provider: provider.id,
      providerUserId: profile.providerUserId,
      email: profile.email,
    });
    // The provider verified this email — GG can trust it too.
    if (!existing.emailVerifiedAt) {
      await db
        .update(users)
        .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, existing.id));
    }
    return { kind: "login", user: existing };
  }
  // 3. Brand-new account: email-verified (T1), no password credential.
  const handle = await uniqueHandle(db, profile.email);
  const userId = uuidv7();
  const now = new Date();
  const user = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(users)
      .values({
        id: userId,
        handle,
        email: profile.email,
        emailVerifiedAt: now,
        authorType: "human",
        status: "active",
        trustTier: "T1",
      })
      .returning();
    await tx.insert(profiles).values({ userId, displayName: handle });
    await tx.insert(userSettings).values({ userId });
    await tx.insert(oauthIdentities).values({
      id: uuidv7(),
      userId,
      provider: provider.id,
      providerUserId: profile.providerUserId,
      email: profile.email,
    });
    return created!;
  });
  return { kind: "login", user };
}
