/**
 * Reels feed (Phase 2): REEL posts with ready media, newest first.
 * Added to API_SPEC.yaml this phase (the spec had no dedicated reels path;
 * PLAN Phase 2 requires a reels feed). Cursor = the shared keyset over
 * (created_at, id) used by the profile/bookmark lists.
 */
import { and, desc, eq, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { posts } from "../db/schema";
import { optionalAuth } from "../lib/auth";
import { decodeCursor, encodeCursor } from "../lib/pagination";
import { pageEnvelope } from "../lib/serializers";
import { parseBody } from "../lib/validate";
import { hydratePosts, postPublishedCondition } from "../services/posts";
import { hiddenAuthorIds, hideAiAccounts } from "../services/visibility";

const reelsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function registerReelRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db } = ctx;

  app.get(
    "/api/v1/reels",
    { preHandler: optionalAuth(ctx) },
    async (request) => {
      const query = parseBody(reelsQuerySchema, request.query);
      const viewerId = request.authUser?.sub ?? null;
      const cursor = decodeCursor<{ createdAt: string; id: string }>(query.cursor);
      const hidden = viewerId ? await hiddenAuthorIds(ctx, viewerId) : [];
      const hideAi = viewerId ? await hideAiAccounts(ctx, viewerId) : false;
      const rows = await db
        .select()
        .from(posts)
        .where(
          and(
            eq(posts.type, "REEL"),
            isNull(posts.deletedAt),
            isNull(posts.parentId),
            postPublishedCondition(viewerId),
            eq(posts.visibility, "public"),
            hidden.length > 0 ? notInArray(posts.authorId, hidden) : undefined,
            hideAi ? eq(posts.authorType, "human") : undefined,
            // Only reels whose media finished the pipeline (ready) can play.
            sql`exists (
              select 1 from post_media pm
              join media m on m.id = pm.media_id
              where pm.post_id = ${posts.id} and m.status = 'ready'
            )`,
            cursor
              ? or(
                  lt(posts.createdAt, new Date(cursor.createdAt)),
                  and(
                    eq(posts.createdAt, new Date(cursor.createdAt)),
                    lt(posts.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(posts.createdAt), desc(posts.id))
        .limit(query.limit + 1);
      const pageRows = rows.slice(0, query.limit);
      const wires = await hydratePosts(db, pageRows, viewerId);
      const last = pageRows[pageRows.length - 1];
      return pageEnvelope(
        wires,
        rows.length > query.limit && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
      );
    },
  );
}
