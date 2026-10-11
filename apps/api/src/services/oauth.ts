import { createHash, randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db";
import { agentProfiles, oauthAuthorizationCodes, oauthClients } from "../db/schema";
import {
  generateClientId,
  generateClientSecret,
  hashApiKey,
  hashesEqual,
  type ApiScope,
} from "../lib/api-keys";
import { badRequest, forbidden, unauthorized, unprocessable } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { signAccessToken, ACCESS_TOKEN_TTL_SECONDS } from "../lib/jwt";
import { effectiveTrustTier } from "../lib/trust-tier";
import type { OAuthClientRow } from "../lib/serializers";
import { getUserByHandle, getUserById } from "./users";

export interface CreatedOAuthClient {
  row: OAuthClientRow;
  /** Client secret — shown exactly once (confidential clients only). */
  secret: string | null;
}

export async function createOAuthClient(
  db: Db,
  input: {
    ownerId: string;
    name: string;
    redirectUris: string[];
    allowedScopes: ApiScope[];
    isConfidential: boolean;
  },
): Promise<CreatedOAuthClient> {
  const generated = input.isConfidential ? generateClientSecret() : null;
  const [row] = await db
    .insert(oauthClients)
    .values({
      id: uuidv7(),
      ownerId: input.ownerId,
      clientId: generateClientId(),
      clientSecretHash: generated?.hash ?? null,
      name: input.name,
      redirectUris: input.redirectUris,
      allowedScopes: input.allowedScopes,
      isConfidential: input.isConfidential,
    })
    .returning();
  return { row: row!, secret: generated?.secret ?? null };
}

export async function listOAuthClients(db: Db, ownerId: string): Promise<OAuthClientRow[]> {
  return db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.ownerId, ownerId))
    .orderBy(desc(oauthClients.createdAt));
}

/** Delete by primary key. The route enforces ownership before calling. */
export async function deleteOAuthClient(db: Db, clientRowId: string): Promise<boolean> {
  const deleted = await db
    .delete(oauthClients)
    .where(eq(oauthClients.id, clientRowId))
    .returning();
  return deleted.length > 0;
}

export async function getOAuthClientByRowId(
  db: Db,
  clientRowId: string,
): Promise<OAuthClientRow | null> {
  const [row] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.id, clientRowId))
    .limit(1);
  return row ?? null;
}

export interface ClientCredentialsResult {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  scope: string;
}

// ── Authorization-code grant (hardening, D-066) ─────────────────────────

const AUTH_CODE_TTL_MS = 10 * 60 * 1000;

export async function getOAuthClientByClientId(
  db: Db,
  clientId: string,
): Promise<OAuthClientRow | null> {
  const [row] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);
  return row ?? null;
}

export interface AuthorizeRequest {
  client: OAuthClientRow;
  redirectUri: string;
  scopes: string[];
}

/**
 * Validate an authorize request against the registered client: the
 * redirect_uri must be one of the client's registered URIs (exact
 * match) and every requested scope must be allowed. Returns the
 * effective scopes (all allowed scopes when none were requested).
 */
export function validateAuthorizeRequest(
  client: OAuthClientRow,
  redirectUri: string,
  requestedScopes: string[] | null,
): string[] {
  const registered = (client.redirectUris as string[] | null) ?? [];
  if (!registered.includes(redirectUri)) {
    throw unprocessable("redirect_uri is not registered for this client");
  }
  const allowed = (client.allowedScopes as string[] | null) ?? [];
  if (requestedScopes === null) return [...allowed];
  const outside = requestedScopes.filter((scope) => !allowed.includes(scope));
  if (outside.length > 0) {
    throw unprocessable(`Scope not allowed for this client: ${outside.join(" ")}`);
  }
  return requestedScopes;
}

function hashAuthCode(rawCode: string): string {
  return createHash("sha256").update(rawCode).digest("hex");
}

/** Mint a single-use authorization code; only its hash is stored. */
export async function createAuthorizationCode(
  db: Db,
  input: {
    clientRowId: string;
    userId: string;
    redirectUri: string;
    scopes: string[];
    codeChallenge: string;
  },
): Promise<string> {
  const rawCode = randomBytes(32).toString("base64url");
  await db.insert(oauthAuthorizationCodes).values({
    id: uuidv7(),
    codeHash: hashAuthCode(rawCode),
    clientId: input.clientRowId,
    userId: input.userId,
    redirectUri: input.redirectUri,
    scopes: input.scopes,
    codeChallenge: input.codeChallenge,
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
  });
  return rawCode;
}

/**
 * Exchange an authorization code for a user-context access token.
 * PKCE S256 is mandatory (D-066): sha256(code_verifier) must equal the
 * stored challenge. Confidential clients must also authenticate with
 * their secret; public clients rely on PKCE alone.
 */
export async function authorizationCodeGrant(
  db: Db,
  jwtSecret: string,
  input: {
    code: string;
    redirectUri: string;
    clientId: string;
    codeVerifier: string;
    clientSecret: string | null;
  },
): Promise<ClientCredentialsResult> {
  const client = await getOAuthClientByClientId(db, input.clientId);
  if (!client) throw unauthorized("Invalid client credentials");
  if (client.isConfidential) {
    if (
      !input.clientSecret ||
      !client.clientSecretHash ||
      !hashesEqual(client.clientSecretHash, hashApiKey(input.clientSecret))
    ) {
      throw unauthorized("Invalid client credentials");
    }
  }
  const [codeRow] = await db
    .select()
    .from(oauthAuthorizationCodes)
    .where(eq(oauthAuthorizationCodes.codeHash, hashAuthCode(input.code)))
    .limit(1);
  if (!codeRow || codeRow.clientId !== client.id) {
    throw badRequest("Invalid authorization code");
  }
  if (codeRow.usedAt !== null) {
    throw badRequest("Authorization code has already been used");
  }
  if (codeRow.expiresAt.getTime() <= Date.now()) {
    throw badRequest("Authorization code has expired");
  }
  if (codeRow.redirectUri !== input.redirectUri) {
    throw badRequest("redirect_uri does not match the authorization request");
  }
  const computedChallenge = createHash("sha256")
    .update(input.codeVerifier)
    .digest("base64url");
  if (computedChallenge !== codeRow.codeChallenge) {
    throw badRequest("PKCE verification failed");
  }
  const user = await getUserById(db, codeRow.userId);
  if (
    !user ||
    user.deletedAt ||
    user.status === "banned" ||
    user.status === "suspended" ||
    user.status === "deactivated"
  ) {
    throw unauthorized("The authorizing account is not active");
  }
  // Single-use: burn the code before minting.
  await db
    .update(oauthAuthorizationCodes)
    .set({ usedAt: new Date() })
    .where(eq(oauthAuthorizationCodes.id, codeRow.id));
  const scopes = (codeRow.scopes as string[] | null) ?? [];
  const accessToken = signAccessToken(
    {
      sub: user.id,
      handle: user.handle,
      authorType: user.authorType,
      trustTier: user.trustTier,
      sid: `oauth-code:${client.id}`,
      scopes,
      clientId: client.id,
    },
    jwtSecret,
  );
  return {
    accessToken,
    tokenType: "Bearer",
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    scope: scopes.join(" "),
  };
}

/**
 * OAuth 2.1 client-credentials grant (Phase 4 scope, D-037/D-043).
 * The client acts for ONE agent (`agent_handle`) owned by the client's
 * owner. The issued JWT carries the intersection of the requested scopes
 * and the client's allowed scopes, and dies at the agent's kill switch
 * like every other agent credential.
 */
export async function clientCredentialsGrant(
  db: Db,
  jwtSecret: string,
  input: {
    clientId: string;
    clientSecret: string;
    agentHandle: string;
    requestedScopes: string[] | null;
  },
): Promise<ClientCredentialsResult> {
  const [client] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, input.clientId))
    .limit(1);
  if (!client || !client.clientSecretHash) {
    throw unauthorized("Invalid client credentials");
  }
  if (!hashesEqual(client.clientSecretHash, hashApiKey(input.clientSecret))) {
    throw unauthorized("Invalid client credentials");
  }
  const agent = await getUserByHandle(db, input.agentHandle);
  if (!agent || agent.authorType !== "agent" || agent.deletedAt) {
    throw forbidden("agent_handle does not identify an agent account");
  }
  if (agent.ownerId !== client.ownerId) {
    throw forbidden("This client does not own that agent");
  }
  if (agent.status === "banned" || agent.status === "suspended" || agent.status === "deactivated") {
    throw unauthorized("Agent account is not active");
  }
  const [agentProfile] = await db
    .select({ killSwitchEngaged: agentProfiles.killSwitchEngaged })
    .from(agentProfiles)
    .where(eq(agentProfiles.userId, agent.id))
    .limit(1);
  if (agentProfile?.killSwitchEngaged) {
    throw forbidden("Agent is suspended by its kill switch");
  }
  const allowed = (client.allowedScopes as string[] | null) ?? [];
  const granted =
    input.requestedScopes === null
      ? allowed
      : input.requestedScopes.filter((scope) => allowed.includes(scope));
  if (input.requestedScopes !== null && granted.length !== input.requestedScopes.length) {
    throw forbidden("Requested scope exceeds this client's allowed scopes");
  }
  const accessToken = signAccessToken(
    {
      sub: agent.id,
      handle: agent.handle,
      authorType: "agent",
      // D-045: the token carries the agent's effective (owner-derived) tier.
      trustTier: await effectiveTrustTier(db, agent),
      sid: `oauth:${client.id}`,
      scopes: granted,
      clientId: client.id,
    },
    jwtSecret,
  );
  return {
    accessToken,
    tokenType: "Bearer",
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    scope: granted.join(" "),
  };
}
