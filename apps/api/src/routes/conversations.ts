/**
 * Messages routes (Phase 5A): conversations inbox + requests, message
 * send/read/edit/delete, emoji reactions, mute/leave, group membership.
 * All gate logic lives in services/conversations.ts (D-049).
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { users } from "../db/schema";
import { requireAuth, requireScope } from "../lib/auth";
import { notFound, unauthorized } from "../lib/errors";
import { pageEnvelope, type UserRow } from "../lib/serializers";
import { parseBody } from "../lib/validate";
import { auditAgentAction } from "../services/agent-audit";
import { logEvent } from "../services/events";
import {
  addParticipant,
  conversationWire,
  createConversation,
  deleteMessage,
  editMessage,
  getConversationRow,
  getParticipant,
  leaveConversation,
  listConversations,
  listMessages,
  markConversationRead,
  muteConversation,
  relayTyping,
  removeParticipant,
  sendMessage,
  setMessageReaction,
  setRequestStatus,
} from "../services/conversations";

const createSchema = z.object({
  participant_handles: z.array(z.string().min(1).max(30)).min(1).max(50),
  title: z.string().max(80).optional(),
});

const sendSchema = z.object({
  body: z.string().max(4000).optional(),
  media_id: z.string().uuid().optional(),
  reply_to_message_id: z.string().uuid().optional(),
  shared_post_id: z.string().uuid().optional(),
});

const readSchema = z.object({ message_id: z.string().uuid() });
const editSchema = z.object({ body: z.string().min(1).max(4000) });
const reactionSchema = z.object({ emoji: z.string().min(1).max(16) });
const muteSchema = z.object({ muted_until: z.string().datetime().nullable() });
const addParticipantSchema = z.object({ handle: z.string().min(1).max(30) });
const listQuerySchema = z.object({
  box: z.enum(["main", "requests"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

async function loadMe(ctx: AppContext, userId: string): Promise<UserRow> {
  const [user] = await ctx.db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw unauthorized("Account is not active");
  return user;
}

export async function registerConversationRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db } = ctx;

  app.get(
    "/api/v1/conversations",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const query = listQuerySchema.parse(request.query ?? {});
      const me = request.authUser!;
      const page = await listConversations(
        db,
        me.sub,
        query.box ?? "main",
        query.cursor,
        query.limit,
      );
      return pageEnvelope(page.items, page.nextCursor);
    },
  );

  app.post(
    "/api/v1/conversations",
    { preHandler: [requireAuth(ctx), requireScope("dm:send")] },
    async (request, reply) => {
      const body = parseBody(createSchema, request.body);
      const me = await loadMe(ctx, request.authUser!.sub);
      const result = await createConversation(db, me, body.participant_handles, body.title ?? null);
      await auditAgentAction(db, request, "dm.create", "conversation", result.conversation.id);
      return reply.status(result.created ? 201 : 200).send(result.conversation);
    },
  );

  app.get(
    "/api/v1/conversations/:conversationId",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const { conversationId } = request.params as { conversationId: string };
      const me = request.authUser!;
      const conversation = await getConversationRow(db, conversationId);
      if (!conversation) throw notFound("Conversation not found");
      const participant = await getParticipant(db, conversationId, me.sub);
      if (!participant) throw notFound("Conversation not found");
      // D-055: leaving or being removed from a GROUP revokes read access
      // too (DM left is only a hide — the pair thread resurfaces).
      if (conversation.kind === "group" && participant.leftAt) {
        throw notFound("Conversation not found");
      }
      return conversationWire(db, conversation, me.sub);
    },
  );

  app.get(
    "/api/v1/conversations/:conversationId/messages",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const { conversationId } = request.params as { conversationId: string };
      const query = listQuerySchema.parse(request.query ?? {});
      const me = request.authUser!;
      const conversation = await getConversationRow(db, conversationId);
      if (!conversation) throw notFound("Conversation not found");
      const participant = await getParticipant(db, conversationId, me.sub);
      if (!participant) throw notFound("Conversation not found");
      if (conversation.kind === "group" && participant.leftAt) {
        throw notFound("Conversation not found");
      }
      const page = await listMessages(db, conversationId, me.sub, query.cursor, query.limit);
      return pageEnvelope(page.items, page.nextCursor);
    },
  );

  app.post(
    "/api/v1/conversations/:conversationId/messages",
    { preHandler: [requireAuth(ctx), requireScope("dm:send")] },
    async (request, reply) => {
      const { conversationId } = request.params as { conversationId: string };
      const body = parseBody(sendSchema, request.body);
      const me = await loadMe(ctx, request.authUser!.sub);
      const conversation = await getConversationRow(db, conversationId);
      if (!conversation) throw notFound("Conversation not found");
      const wire = await sendMessage(db, conversation, me, {
        body: body.body ?? null,
        mediaId: body.media_id ?? null,
        replyToMessageId: body.reply_to_message_id ?? null,
        sharedPostId: body.shared_post_id ?? null,
      });
      await auditAgentAction(db, request, "dm.send", "message", wire.id);
      await logEvent(db, {
        userId: me.id,
        type: "dm.sent",
        subjectType: "conversation",
        subjectId: conversationId,
        props: { kind: conversation.kind },
      });
      return reply.status(201).send(wire);
    },
  );

  app.post(
    "/api/v1/conversations/:conversationId/read",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      const { conversationId } = request.params as { conversationId: string };
      const body = parseBody(readSchema, request.body);
      const me = await loadMe(ctx, request.authUser!.sub);
      const conversation = await getConversationRow(db, conversationId);
      if (!conversation) throw notFound("Conversation not found");
      await markConversationRead(db, conversation, me, body.message_id);
      return reply.status(204).send();
    },
  );

  for (const [segment, status] of [
    ["accept", "active"],
    ["decline", "declined"],
  ] as const) {
    app.post(
      `/api/v1/conversations/:conversationId/${segment}`,
      { preHandler: requireAuth(ctx) },
      async (request) => {
        const { conversationId } = request.params as { conversationId: string };
        const me = await loadMe(ctx, request.authUser!.sub);
        const conversation = await getConversationRow(db, conversationId);
        if (!conversation) throw notFound("Conversation not found");
        return setRequestStatus(db, conversation, me, status);
      },
    );
  }

  app.post(
    "/api/v1/conversations/:conversationId/mute",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const { conversationId } = request.params as { conversationId: string };
      const body = parseBody(muteSchema, request.body);
      const me = await loadMe(ctx, request.authUser!.sub);
      const conversation = await getConversationRow(db, conversationId);
      if (!conversation) throw notFound("Conversation not found");
      return muteConversation(
        db,
        conversation,
        me,
        body.muted_until ? new Date(body.muted_until) : null,
      );
    },
  );

  app.post(
    "/api/v1/conversations/:conversationId/leave",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      const { conversationId } = request.params as { conversationId: string };
      const me = await loadMe(ctx, request.authUser!.sub);
      const conversation = await getConversationRow(db, conversationId);
      if (!conversation) throw notFound("Conversation not found");
      await leaveConversation(db, conversation, me);
      return reply.status(204).send();
    },
  );

  app.post(
    "/api/v1/conversations/:conversationId/participants",
    { preHandler: [requireAuth(ctx), requireScope("dm:send")] },
    async (request) => {
      const { conversationId } = request.params as { conversationId: string };
      const body = parseBody(addParticipantSchema, request.body);
      const me = await loadMe(ctx, request.authUser!.sub);
      const conversation = await getConversationRow(db, conversationId);
      if (!conversation) throw notFound("Conversation not found");
      return addParticipant(db, conversation, me, body.handle);
    },
  );

  app.delete(
    "/api/v1/conversations/:conversationId/participants/:handle",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      const { conversationId, handle } = request.params as {
        conversationId: string;
        handle: string;
      };
      const me = await loadMe(ctx, request.authUser!.sub);
      const conversation = await getConversationRow(db, conversationId);
      if (!conversation) throw notFound("Conversation not found");
      await removeParticipant(db, conversation, me, handle);
      return reply.status(204).send();
    },
  );

  app.patch(
    "/api/v1/conversations/:conversationId/messages/:messageId",
    { preHandler: [requireAuth(ctx), requireScope("dm:send")] },
    async (request) => {
      const { conversationId, messageId } = request.params as {
        conversationId: string;
        messageId: string;
      };
      const body = parseBody(editSchema, request.body);
      const me = await loadMe(ctx, request.authUser!.sub);
      const conversation = await getConversationRow(db, conversationId);
      if (!conversation) throw notFound("Conversation not found");
      return editMessage(db, conversation, me, messageId, body.body);
    },
  );

  app.delete(
    "/api/v1/conversations/:conversationId/messages/:messageId",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      const { conversationId, messageId } = request.params as {
        conversationId: string;
        messageId: string;
      };
      const me = await loadMe(ctx, request.authUser!.sub);
      const conversation = await getConversationRow(db, conversationId);
      if (!conversation) throw notFound("Conversation not found");
      await deleteMessage(db, conversation, me, messageId);
      return reply.status(204).send();
    },
  );

  app.post(
    "/api/v1/conversations/:conversationId/messages/:messageId/reactions",
    { preHandler: [requireAuth(ctx), requireScope("dm:send")] },
    async (request) => {
      const { conversationId, messageId } = request.params as {
        conversationId: string;
        messageId: string;
      };
      const body = parseBody(reactionSchema, request.body);
      const me = await loadMe(ctx, request.authUser!.sub);
      const conversation = await getConversationRow(db, conversationId);
      if (!conversation) throw notFound("Conversation not found");
      return setMessageReaction(db, conversation, me, messageId, body.emoji, true);
    },
  );

  app.delete(
    "/api/v1/conversations/:conversationId/messages/:messageId/reactions/:emoji",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const { conversationId, messageId, emoji } = request.params as {
        conversationId: string;
        messageId: string;
        emoji: string;
      };
      const me = await loadMe(ctx, request.authUser!.sub);
      const conversation = await getConversationRow(db, conversationId);
      if (!conversation) throw notFound("Conversation not found");
      return setMessageReaction(db, conversation, me, messageId, decodeURIComponent(emoji), false);
    },
  );

  // Typing relay (D-048): fire-and-forget; 204 whether or not it relayed.
  app.post(
    "/api/v1/conversations/:conversationId/typing",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      const { conversationId } = request.params as { conversationId: string };
      const me = await loadMe(ctx, request.authUser!.sub);
      const conversation = await getConversationRow(db, conversationId);
      if (conversation) await relayTyping(db, conversation, me);
      return reply.status(204).send();
    },
  );
}
