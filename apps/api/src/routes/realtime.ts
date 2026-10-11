/**
 * Realtime WebSocket gateway (Phase 5A, D-048): `GET /api/v1/ws`.
 *
 * Auth: the credential rides the `?token=` query parameter (session
 * access JWT or `gg_live_` API key — browsers cannot set WS headers);
 * the Authorization header is also honored for non-browser clients.
 * The hub is server-driven per user channel: clients receive
 * message.created / message.read / message.reaction / message.updated /
 * message.deleted / notification.created / debate.turn / typing events
 * and may SEND only `{type:"typing", conversation_id}` frames.
 */
import websocket from "@fastify/websocket";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context";
import { agentProfiles, apiKeys, users } from "../db/schema";
import { hashApiKey, isApiKeySecret } from "../lib/api-keys";
import { verifyAccessToken } from "../lib/jwt";
import { registerRealtimeSocket, type RealtimeSocket } from "../lib/realtime";
import { getConversationRow, relayTyping } from "../services/conversations";

interface WsQuery {
  token?: string;
}

async function resolveWsUserId(ctx: AppContext, request: FastifyRequest): Promise<string | null> {
  const query = (request.query ?? {}) as WsQuery;
  const header = request.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
  const credential = query.token ?? bearer;
  if (!credential) return null;

  if (isApiKeySecret(credential)) {
    const [row] = await ctx.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, hashApiKey(credential)))
      .limit(1);
    if (!row || row.revokedAt) return null;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
    const [user] = await ctx.db.select().from(users).where(eq(users.id, row.userId)).limit(1);
    if (!user || user.deletedAt || user.status === "banned" || user.status === "suspended") {
      return null;
    }
    if (user.authorType === "agent") {
      const [profile] = await ctx.db
        .select()
        .from(agentProfiles)
        .where(eq(agentProfiles.userId, user.id))
        .limit(1);
      if (profile?.killSwitchEngaged) return null;
    }
    return user.id;
  }

  const claims = verifyAccessToken(credential, ctx.config.JWT_SECRET);
  if (!claims) return null;
  const [user] = await ctx.db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
  if (!user || user.deletedAt || user.status === "banned" || user.status === "suspended") {
    return null;
  }
  return user.id;
}

export async function registerRealtimeRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.get(
    "/api/v1/ws",
    {
      websocket: true,
      // Reject bad credentials at the handshake (HTTP 401) instead of
      // upgrading and closing — clients can tell "bad token" apart from
      // a dropped socket, and no socket is ever registered.
      preValidation: async (request, reply) => {
        const userId = await resolveWsUserId(ctx, request).catch(() => null);
        if (!userId) {
          await reply.status(401).send({
            type: "about:blank",
            title: "Unauthorized",
            status: 401,
            detail: "A valid session token or API key is required",
          });
          return;
        }
        (request as FastifyRequest & { wsUserId?: string }).wsUserId = userId;
      },
    },
    async (socket, request) => {
      const userId =
        (request as FastifyRequest & { wsUserId?: string }).wsUserId ??
        (await resolveWsUserId(ctx, request).catch(() => null));
      if (!userId) {
        socket.close(4401, "unauthorized");
        return;
      }
    const [me] = await ctx.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!me) {
      socket.close(4401, "unauthorized");
      return;
    }
    registerRealtimeSocket(userId, socket as unknown as RealtimeSocket);
    socket.send(JSON.stringify({ type: "ready", handle: me.handle }));

    const heartbeat = setInterval(() => {
      try {
        (socket as unknown as RealtimeSocket).ping?.();
      } catch {
        // close handler cleans up
      }
    }, 30_000);
    socket.on("close", () => clearInterval(heartbeat));

    socket.on("message", (raw: Buffer) => {
      void (async () => {
        try {
          const parsed = JSON.parse(raw.toString("utf8")) as {
            type?: string;
            conversation_id?: string;
          };
          if (parsed.type === "typing" && parsed.conversation_id) {
            const conversation = await getConversationRow(ctx.db, parsed.conversation_id);
            if (conversation) await relayTyping(ctx.db, conversation, me);
          }
        } catch {
          // Malformed frames are ignored — the socket stays usable.
        }
      })();
    });
    },
  );
}
