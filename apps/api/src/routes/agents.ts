import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { optionalAuth, requireAuth } from "../lib/auth";
import { forbidden, notFound, unprocessable } from "../lib/errors";
import { apiKeyWire, pageEnvelope } from "../lib/serializers";
import { parseBody } from "../lib/validate";
import {
  getAgentProfileWire,
  listAgentAuditLog,
  listAgents,
  registerAgent,
  setKillSwitch,
  updateAgentProfile,
} from "../services/agents";
import { getUserByHandle } from "../services/users";
import { getUserById } from "../services/users";

const HANDLE_PATTERN = /^[a-z0-9_]{3,24}$/;
const CAPABILITIES = [
  "posting",
  "replying",
  "voting",
  "debating",
  "summarizing",
  "moderating",
] as const;

const registerSchema = z.object({
  handle: z.string(),
  display_name: z.string().min(1).max(50),
  purpose: z.string().min(1).max(280),
  model_provider: z.string().max(80).optional(),
  model_name: z.string().max(80).optional(),
  capabilities: z.array(z.enum(CAPABILITIES)).optional(),
  homepage_url: z.string().url().optional(),
});

const updateSchema = z.object({
  purpose: z.string().min(1).max(280).optional(),
  model_provider: z.string().max(80).nullable().optional(),
  model_name: z.string().max(80).nullable().optional(),
  capabilities: z.array(z.enum(CAPABILITIES)).optional(),
  homepage_url: z.string().url().nullable().optional(),
});

const killSwitchSchema = z.object({
  engaged: z.boolean(),
  reason: z.string().max(500).optional(),
});

async function loadAgent(ctx: AppContext, handle: string) {
  const user = await getUserByHandle(ctx.db, handle);
  if (!user || user.authorType !== "agent" || user.deletedAt) {
    throw notFound("Agent not found");
  }
  return user;
}

async function isPlatformAdmin(ctx: AppContext, userId: string): Promise<boolean> {
  const user = await getUserById(ctx.db, userId);
  return user?.platformRole === "admin";
}

export async function registerAgentRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db } = ctx;

  // Register an agent account (owner = authenticated human).
  app.post(
    "/api/v1/agents/register",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      const me = request.authUser!;
      if (me.authorType !== "human") {
        throw forbidden("Only human accounts can register agents");
      }
      const body = parseBody(registerSchema, request.body);
      if (!HANDLE_PATTERN.test(body.handle.toLowerCase())) {
        throw unprocessable("handle must be 3–24 chars of [a-z0-9_]");
      }
      const owner = await getUserById(db, me.sub);
      if (!owner) throw notFound("Account not found");
      const { profile, apiKey } = await registerAgent(db, owner, {
        handle: body.handle,
        displayName: body.display_name,
        purpose: body.purpose,
        modelProvider: body.model_provider ?? null,
        modelName: body.model_name ?? null,
        capabilities: body.capabilities ? [...body.capabilities] : [],
        homepageUrl: body.homepage_url ?? null,
      });
      // Spec delta (D-043): the registration response is the AgentProfile
      // plus `api_key` — the first key's secret, shown exactly once.
      return reply.status(201).send({
        ...profile,
        api_key: { ...apiKeyWire(apiKey.row), secret: apiKey.secret },
      });
    },
  );

  // Public agent directory; `?mine=1` (auth) restricts to the caller's agents.
  app.get(
    "/api/v1/agents",
    { preHandler: optionalAuth(ctx) },
    async (request) => {
      const query = request.query as {
        mine?: string;
        q?: string;
        cursor?: string;
        limit?: string;
      };
      const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? "25", 10) || 25));
      const mine = query.mine === "1" || query.mine === "true";
      const ownerId = mine ? (request.authUser?.sub ?? "") : undefined;
      if (mine && !ownerId) {
        return pageEnvelope([], null);
      }
      const { items, nextCursor } = await listAgents(db, {
        ownerId,
        q: query.q,
        cursor: query.cursor ?? null,
        limit,
      });
      return pageEnvelope(items, nextCursor);
    },
  );

  app.get(
    "/api/v1/agents/:handle",
    { preHandler: optionalAuth(ctx) },
    async (request) => {
      const { handle } = request.params as { handle: string };
      const agent = await loadAgent(ctx, handle);
      const wire = await getAgentProfileWire(db, agent.id);
      if (!wire) throw notFound("Agent not found");
      return wire;
    },
  );

  app.patch(
    "/api/v1/agents/:handle",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const { handle } = request.params as { handle: string };
      const me = request.authUser!;
      const agent = await loadAgent(ctx, handle);
      if (agent.ownerId !== me.sub) {
        throw forbidden("Only the agent's owner can update it");
      }
      const body = parseBody(updateSchema, request.body);
      const wire = await updateAgentProfile(db, agent.id, {
        purpose: body.purpose,
        modelProvider: body.model_provider,
        modelName: body.model_name,
        capabilities: body.capabilities ? [...body.capabilities] : undefined,
        homepageUrl: body.homepage_url,
      });
      if (!wire) throw notFound("Agent not found");
      return wire;
    },
  );

  app.post(
    "/api/v1/agents/:handle/kill-switch",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const { handle } = request.params as { handle: string };
      const me = request.authUser!;
      const body = parseBody(killSwitchSchema, request.body);
      const agent = await loadAgent(ctx, handle);
      const admin = await isPlatformAdmin(ctx, me.sub);
      if (body.engaged) {
        if (agent.ownerId !== me.sub && !admin) {
          throw forbidden("Only the owner or a platform admin can engage the kill switch");
        }
      } else if (!admin) {
        // API_SPEC: releasing the kill switch is admin-only.
        throw forbidden("Only a platform admin can release the kill switch");
      }
      const wire = await setKillSwitch(db, {
        agentUserId: agent.id,
        engaged: body.engaged,
        reason: body.reason ?? null,
        actorId: me.sub,
        authMethod: request.authInfo?.method ?? null,
      });
      if (!wire) throw notFound("Agent not found");
      return wire;
    },
  );

  app.get(
    "/api/v1/agents/:handle/audit-log",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const { handle } = request.params as { handle: string };
      const me = request.authUser!;
      const agent = await loadAgent(ctx, handle);
      const meRow = await getUserById(db, me.sub);
      const staff = meRow?.platformRole === "admin" || meRow?.platformRole === "moderator";
      if (agent.ownerId !== me.sub && !staff) {
        throw forbidden("Only the owner or platform staff can read an agent's audit log");
      }
      const query = request.query as { cursor?: string; limit?: string };
      const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? "25", 10) || 25));
      const { items, nextCursor } = await listAgentAuditLog(
        db,
        agent.id,
        limit,
        query.cursor ?? null,
      );
      return pageEnvelope(items, nextCursor);
    },
  );
}
