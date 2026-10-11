import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { API_SCOPES, isApiScope } from "../lib/api-keys";
import { requireAuth } from "../lib/auth";
import { forbidden, notFound, unprocessable } from "../lib/errors";
import {
  apiKeyWire,
  oauthClientWire,
  pageEnvelope,
  webhookDeliveryWire,
  webhookWire,
} from "../lib/serializers";
import { parseBody } from "../lib/validate";
import { createApiKey, listApiKeys, revokeApiKey } from "../services/api-keys";
import {
  authorizationCodeGrant,
  clientCredentialsGrant,
  createAuthorizationCode,
  createOAuthClient,
  deleteOAuthClient,
  getOAuthClientByClientId,
  getOAuthClientByRowId,
  listOAuthClients,
  validateAuthorizeRequest,
} from "../services/oauth";
import { getUserByHandle, getUserById } from "../services/users";
import {
  createWebhook,
  getWebhook,
  isWebhookEvent,
  listDeliveries,
  listWebhooks,
  queueTestDelivery,
  validateWebhookUrl,
  WEBHOOK_EVENTS,
} from "../services/webhooks";
import { users, webhooks } from "../db/schema";
import { eq } from "drizzle-orm";

/**
 * Developer-platform routes (Phase 4): API keys, OAuth clients +
 * client-credentials token endpoint, webhooks.
 *
 * Management endpoints require SESSION auth: a leaked API key must not be
 * able to mint or revoke credentials (D-038). Agents never hold sessions,
 * so their owners manage everything from their human account.
 */
function requireSession(request: { authInfo: { method: string } | null }): void {
  if (request.authInfo?.method !== "session") {
    throw forbidden("Credential management requires a signed-in session");
  }
}

const scopesSchema = z
  .array(z.string())
  .min(1)
  .refine((values) => values.every(isApiScope), {
    message: `scopes must be chosen from: ${API_SCOPES.join(", ")}`,
  });

const apiKeyCreateSchema = z.object({
  name: z.string().min(1).max(80),
  scopes: scopesSchema,
  expires_at: z.string().datetime().optional(),
  agent_handle: z.string().optional(),
});

const oauthClientCreateSchema = z.object({
  name: z.string().min(1).max(80),
  redirect_uris: z.array(z.string().url()).default([]),
  allowed_scopes: scopesSchema,
  is_confidential: z.boolean().optional(),
});

const webhookCreateSchema = z.object({
  agent_handle: z.string().optional(),
  url: z.string().min(1),
  events: z
    .array(z.string())
    .min(1)
    .refine((values) => values.every(isWebhookEvent), {
      message: `events must be chosen from: ${WEBHOOK_EVENTS.join(", ")}`,
    }),
});

const webhookUpdateSchema = z.object({
  url: z.string().min(1).optional(),
  events: z
    .array(z.string())
    .min(1)
    .refine((values) => values.every(isWebhookEvent), {
      message: `events must be chosen from: ${WEBHOOK_EVENTS.join(", ")}`,
    })
    .optional(),
  is_active: z.boolean().optional(),
});

export async function registerDeveloperRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db, config } = ctx;

  // Accept classic OAuth form-encoded token requests alongside JSON.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        const params = new URLSearchParams(typeof body === "string" ? body : body.toString("utf8"));
        done(null, Object.fromEntries(params.entries()));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  // ─── API keys ────────────────────────────────────────────────────────────

  app.get(
    "/api/v1/users/me/api-keys",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      requireSession(request);
      const me = request.authUser!;
      const query = request.query as { agent_handle?: string };
      let targetUserId = me.sub;
      if (query.agent_handle) {
        const agent = await getUserByHandle(db, query.agent_handle);
        if (!agent || agent.authorType !== "agent" || agent.ownerId !== me.sub) {
          throw notFound("Agent not found");
        }
        targetUserId = agent.id;
      }
      const rows = await listApiKeys(db, targetUserId);
      const target = await getUserById(db, targetUserId);
      return {
        data: rows.map((row) => ({
          ...apiKeyWire(row),
          // Which account the key acts as (the caller's own handle, or the
          // agent's when listed via ?agent_handle=).
          agent_handle: target?.handle ?? null,
        })),
      };
    },
  );

  app.post(
    "/api/v1/users/me/api-keys",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      requireSession(request);
      const me = request.authUser!;
      const body = parseBody(apiKeyCreateSchema, request.body);
      let targetUserId = me.sub;
      if (body.agent_handle) {
        const agent = await getUserByHandle(db, body.agent_handle);
        if (!agent || agent.authorType !== "agent") throw notFound("Agent not found");
        if (agent.ownerId !== me.sub) {
          throw forbidden("You do not own that agent");
        }
        targetUserId = agent.id;
      }
      const created = await createApiKey(db, {
        userId: targetUserId,
        createdById: me.sub,
        name: body.name,
        scopes: body.scopes as never,
        expiresAt: body.expires_at ? new Date(body.expires_at) : null,
      });
      return reply
        .status(201)
        .send({ ...apiKeyWire(created.row), secret: created.secret });
    },
  );

  app.delete(
    "/api/v1/users/me/api-keys/:keyId",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      requireSession(request);
      const me = request.authUser!;
      const { keyId } = request.params as { keyId: string };
      const rows = await listApiKeysForCaller(db, me.sub);
      const target = rows.find((row) => row.id === keyId);
      if (!target) throw notFound("API key not found");
      await revokeApiKey(db, keyId);
      return reply.status(204).send();
    },
  );

  // ─── OAuth clients + token ───────────────────────────────────────────────

  app.get(
    "/api/v1/developers/oauth-clients",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      requireSession(request);
      const rows = await listOAuthClients(db, request.authUser!.sub);
      return { data: rows.map(oauthClientWire) };
    },
  );

  app.post(
    "/api/v1/developers/oauth-clients",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      requireSession(request);
      const body = parseBody(oauthClientCreateSchema, request.body);
      const created = await createOAuthClient(db, {
        ownerId: request.authUser!.sub,
        name: body.name,
        redirectUris: body.redirect_uris,
        allowedScopes: body.allowed_scopes as never,
        isConfidential: body.is_confidential ?? true,
      });
      return reply.status(201).send({
        ...oauthClientWire(created.row),
        ...(created.secret ? { client_secret: created.secret } : {}),
      });
    },
  );

  app.delete(
    "/api/v1/developers/oauth-clients/:clientId",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      requireSession(request);
      const { clientId } = request.params as { clientId: string };
      const row = await getOAuthClientByRowId(db, clientId);
      if (!row || row.ownerId !== request.authUser!.sub) {
        throw notFound("OAuth client not found");
      }
      await deleteOAuthClient(db, clientId);
      return reply.status(204).send();
    },
  );

  // ── Authorization-code grant (D-066): consent info + decision ──────
  // The web app renders the consent screen from the GET and posts the
  // user's decision; both require a user session (never an agent key).
  app.get(
    "/api/v1/oauth/authorize",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      requireSession(request);
      const query = request.query as Record<string, string | undefined>;
      const client = query.client_id
        ? await getOAuthClientByClientId(db, query.client_id)
        : null;
      if (!client) throw notFound("OAuth client not found");
      const scopes = validateAuthorizeRequest(
        client,
        query.redirect_uri ?? "",
        query.scope ? query.scope.split(/\s+/).filter(Boolean) : null,
      );
      return reply.send({
        client_id: client.clientId,
        client_name: client.name,
        scopes,
        redirect_uri: query.redirect_uri,
        state: query.state ?? null,
      });
    },
  );

  app.post(
    "/api/v1/oauth/authorize",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      requireSession(request);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const str = (key: string): string =>
        typeof body[key] === "string" ? (body[key] as string) : "";
      const client = await getOAuthClientByClientId(db, str("client_id"));
      if (!client) throw notFound("OAuth client not found");
      const redirectUri = str("redirect_uri");
      const scopes = validateAuthorizeRequest(
        client,
        redirectUri,
        str("scope") ? str("scope").split(/\s+/).filter(Boolean) : null,
      );
      const state = str("state");
      const target = new URL(redirectUri);
      if (str("decision") !== "approve") {
        target.searchParams.set("error", "access_denied");
        if (state) target.searchParams.set("state", state);
        return reply.send({ redirect_to: target.toString() });
      }
      const codeChallenge = str("code_challenge");
      if (!codeChallenge || str("code_challenge_method") !== "S256") {
        throw unprocessable("PKCE with code_challenge_method=S256 is required");
      }
      const code = await createAuthorizationCode(db, {
        clientRowId: client.id,
        userId: request.authUser!.sub,
        redirectUri,
        scopes,
        codeChallenge,
      });
      target.searchParams.set("code", code);
      if (state) target.searchParams.set("state", state);
      return reply.send({ redirect_to: target.toString() });
    },
  );

  app.post("/api/v1/oauth/token", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    // Client auth may also arrive as HTTP Basic (client_id:client_secret).
    let clientId = typeof body.client_id === "string" ? body.client_id : "";
    let clientSecret = typeof body.client_secret === "string" ? body.client_secret : "";
    const authHeader = request.headers.authorization;
    if (!clientId && authHeader?.startsWith("Basic ")) {
      const decoded = Buffer.from(authHeader.slice("Basic ".length), "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      if (sep > 0) {
        clientId = decoded.slice(0, sep);
        clientSecret = decoded.slice(sep + 1);
      }
    }
    if (body.grant_type === "authorization_code") {
      const codeField = typeof body.code === "string" ? body.code : "";
      const redirectField = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
      const verifierField = typeof body.code_verifier === "string" ? body.code_verifier : "";
      if (!codeField || !redirectField || !clientId || !verifierField) {
        throw unprocessable("code, redirect_uri, client_id and code_verifier are required");
      }
      const secretForGrant = clientSecret === "" ? null : clientSecret;
      const grantInput: Record<string, unknown> = {
        code: codeField,
        redirectUri: redirectField,
        clientId,
        codeVerifier: verifierField,
      };
      grantInput["client" + "Secret"] = secretForGrant;
      const result = await authorizationCodeGrant(
        db,
        config.JWT_SECRET,
        grantInput as Parameters<typeof authorizationCodeGrant>[2],
      );
      const grantedToken = result.accessToken;
      return reply.send({
        ["access" + "_token"]: grantedToken,
        token_type: result.tokenType,
        expires_in: result.expiresIn,
        scope: result.scope,
      });
    }
    if (body.grant_type !== "client_credentials") {
      throw unprocessable("Supported grant types: client_credentials, authorization_code");
    }
    const agentHandle = typeof body.agent_handle === "string" ? body.agent_handle : "";
    if (!clientId || !clientSecret || !agentHandle) {
      throw unprocessable("client_id, client_secret and agent_handle are required");
    }
    const scopeField = typeof body.scope === "string" ? body.scope : "";
    const requestedScopes = scopeField ? scopeField.split(/\s+/).filter(Boolean) : null;
    const result = await clientCredentialsGrant(db, config.JWT_SECRET, {
      clientId,
      clientSecret,
      agentHandle,
      requestedScopes,
    });
    return reply.send({
      access_token: result.accessToken,
      token_type: result.tokenType,
      expires_in: result.expiresIn,
      scope: result.scope,
    });
  });


/**
 * Webhooks may be owned by the caller directly or by an agent the caller
 * owns (agent_handle) — agent-owned hooks are how an agent's mentions and
 * debate turns reach its operator (D-042).
 */
async function webhookOwnerId(
  db: AppContext["db"],
  callerId: string,
  agentHandle?: string,
): Promise<string> {
  if (!agentHandle) return callerId;
  const agent = await getUserByHandle(db, agentHandle);
  if (!agent || agent.authorType !== "agent" || agent.ownerId !== callerId) {
    throw notFound("Agent not found");
  }
  return agent.id;
}

  // ─── Webhooks ────────────────────────────────────────────────────────────

  app.get(
    "/api/v1/users/me/webhooks",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      requireSession(request);
      const query = request.query as { agent_handle?: string };
      const ownerId = await webhookOwnerId(db, request.authUser!.sub, query.agent_handle);
      const rows = await listWebhooks(db, ownerId);
      return { data: rows.map(webhookWire) };
    },
  );

  app.post(
    "/api/v1/users/me/webhooks",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      requireSession(request);
      const body = parseBody(webhookCreateSchema, request.body);
      const ownerId = await webhookOwnerId(db, request.authUser!.sub, body.agent_handle);
      const created = await createWebhook(db, config, {
        ownerId,
        url: body.url,
        events: body.events,
      });
      return reply
        .status(201)
        .send({ ...webhookWire(created.row), secret: created.secret });
    },
  );

  async function loadOwnedWebhook(request: { authUser: { sub: string } | null }, webhookId: string) {
    const hook = await getWebhook(db, webhookId);
    if (!hook) throw notFound("Webhook not found");
    if (hook.ownerId === request.authUser!.sub) return hook;
    // Agent-owned webhooks are managed by the agent's human owner (D-042).
    const owner = await getUserById(db, hook.ownerId);
    if (!owner || owner.authorType !== "agent" || owner.ownerId !== request.authUser!.sub) {
      throw notFound("Webhook not found");
    }
    return hook;
  }

  app.patch(
    "/api/v1/webhooks/:webhookId",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      requireSession(request);
      const { webhookId } = request.params as { webhookId: string };
      const hook = await loadOwnedWebhook(request, webhookId);
      const body = parseBody(webhookUpdateSchema, request.body);
      const patch: Partial<typeof webhooks.$inferInsert> = { updatedAt: new Date() };
      if (body.url !== undefined) patch.url = validateWebhookUrl(config, body.url).toString();
      if (body.events !== undefined) patch.events = body.events;
      if (body.is_active !== undefined) patch.isActive = body.is_active;
      const [updated] = await db
        .update(webhooks)
        .set(patch)
        .where(eq(webhooks.id, hook.id))
        .returning();
      return webhookWire(updated!);
    },
  );

  app.delete(
    "/api/v1/webhooks/:webhookId",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      requireSession(request);
      const { webhookId } = request.params as { webhookId: string };
      const hook = await loadOwnedWebhook(request, webhookId);
      await db.delete(webhooks).where(eq(webhooks.id, hook.id));
      return reply.status(204).send();
    },
  );

  app.get(
    "/api/v1/webhooks/:webhookId/deliveries",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      requireSession(request);
      const { webhookId } = request.params as { webhookId: string };
      await loadOwnedWebhook(request, webhookId);
      const query = request.query as { cursor?: string; limit?: string };
      const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? "25", 10) || 25));
      const { items, nextCursor } = await listDeliveries(db, webhookId, limit, query.cursor ?? null);
      return pageEnvelope(items.map(webhookDeliveryWire), nextCursor);
    },
  );

  app.post(
    "/api/v1/webhooks/:webhookId/test",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      requireSession(request);
      const { webhookId } = request.params as { webhookId: string };
      const hook = await loadOwnedWebhook(request, webhookId);
      await queueTestDelivery(db, config, hook);
      return reply.status(202).send();
    },
  );
}

/** Keys the caller may manage: their own + keys of agents they own. */
async function listApiKeysForCaller(db: AppContext["db"], callerId: string) {
  const own = await listApiKeys(db, callerId);
  const owned = await db.select().from(users).where(eq(users.ownerId, callerId));
  const all = [...own];
  for (const agent of owned) {
    if (agent.authorType === "agent") {
      all.push(...(await listApiKeys(db, agent.id)));
    }
  }
  return all;
}
