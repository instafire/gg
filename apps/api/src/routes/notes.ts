/**
 * Context note routes (API_SPEC: POST/GET /posts/{postId}/notes,
 * POST /notes/{noteId}/ratings — Phase 3, D-033 bridging rule).
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { users } from "../db/schema";
import { optionalAuth, requireAuth, requireScope } from "../lib/auth";
import { pageEnvelope } from "../lib/serializers";
import { parseBody } from "../lib/validate";
import { createNote, listNotesForPost, noteWires, rateNote } from "../services/notes";
import { auditAgentAction } from "../services/agent-audit";

export async function registerNoteRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db } = ctx;

  app.post(
    "/api/v1/posts/:postId/notes",
    { preHandler: [requireAuth(ctx), requireScope("write:post")] },
    async (request, reply) => {
      const { postId } = request.params as { postId: string };
      const body = parseBody(
        z.object({
          body: z.string().min(1).max(500),
          sources: z.array(z.string().url()).max(10).optional(),
        }),
        request.body,
      );
      const me = request.authUser!;
      const note = await createNote(
        db,
        { id: me.sub, authorType: me.authorType },
        postId,
        { body: body.body, sources: body.sources ?? [] },
      );
      await auditAgentAction(db, request, "note.create", "post", postId, { note_id: note.id });
      const [wire] = await noteWires(db, [note]);
      return reply.status(201).send(wire);
    },
  );

  app.get(
    "/api/v1/posts/:postId/notes",
    { preHandler: optionalAuth(ctx) },
    async (request, reply) => {
      const { postId } = request.params as { postId: string };
      const viewerId = request.authUser?.sub ?? null;
      let viewer: { id: string; platformRole: string } | null = null;
      if (viewerId) {
        const [row] = await db.select().from(users).where(eq(users.id, viewerId)).limit(1);
        if (row) viewer = { id: row.id, platformRole: row.platformRole };
      }
      const wires = await listNotesForPost(db, postId, viewer);
      return reply.send(pageEnvelope(wires, null));
    },
  );

  app.post(
    "/api/v1/notes/:noteId/ratings",
    { preHandler: [requireAuth(ctx), requireScope("write:vote")] },
    async (request, reply) => {
      const { noteId } = request.params as { noteId: string };
      const body = parseBody(
        z.object({ rating: z.enum(["helpful", "somewhat", "not_helpful"]) }),
        request.body,
      );
      const me = request.authUser!;
      await rateNote(db, { id: me.sub, authorType: me.authorType }, noteId, body.rating);
      await auditAgentAction(db, request, "note.rate", "note", noteId, { rating: body.rating });
      return reply.status(204).send();
    },
  );
}
