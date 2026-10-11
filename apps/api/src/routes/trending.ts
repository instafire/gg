/**
 * Trending route (API_SPEC GET /trending; Phase 5A, D-052/D-054). Serves
 * the latest worker computation batch from trending_snapshots — one row
 * per item (kind/key/score), all rows of a batch sharing computed_at —
 * instead of computing per-request. The `posts` array is a spec delta.
 * When no computation exists yet, an empty (but valid) result returns.
 */
import { desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { communities, debates, posts, trendingSnapshots } from "../db/schema";
import { optionalAuth } from "../lib/auth";
import { communityRef } from "../lib/serializers";
import { parseBody } from "../lib/validate";
import { debateWireFor } from "../services/debates";
import { hydratePosts } from "../services/posts";

const querySchema = z.object({
  region: z.string().max(40).optional(),
});

export async function registerTrendingRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db } = ctx;

  app.get(
    "/api/v1/trending",
    { preHandler: optionalAuth(ctx) },
    async (request) => {
      parseBody(querySchema, request.query ?? {});
      const viewerId = request.authUser?.sub ?? null;
      const [latest] = await db
        .select({ computedAt: trendingSnapshots.computedAt })
        .from(trendingSnapshots)
        .orderBy(desc(trendingSnapshots.computedAt))
        .limit(1);
      const batch = latest
        ? await db
            .select()
            .from(trendingSnapshots)
            .where(eq(trendingSnapshots.computedAt, latest.computedAt))
        : [];
      const byKind = (kind: string) =>
        batch
          .filter((r) => r.kind === kind)
          .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));

      const hashtags = byKind("hashtag").map((r) => ({
        tag: r.key,
        post_count:
          (r.payload as { post_count?: number } | null)?.post_count ??
          Math.round(r.score),
      }));

      const postIds = byKind("post").map((r) => r.key);
      const postRows =
        postIds.length > 0
          ? await db.select().from(posts).where(inArray(posts.id, postIds))
          : [];
      const postById = new Map(postRows.map((p) => [p.id, p]));
      const orderedPosts = postIds
        .map((id) => postById.get(id))
        .filter((p): p is NonNullable<typeof p> => Boolean(p) && !p!.deletedAt);
      const postWires = await hydratePosts(db, orderedPosts, viewerId);

      const communityIds = byKind("community").map((r) => r.key);
      const communityRows =
        communityIds.length > 0
          ? await db
              .select()
              .from(communities)
              .where(inArray(communities.id, communityIds))
          : [];
      const communityById = new Map(communityRows.map((c) => [c.id, c]));
      const communityRefs = communityIds
        .map((id) => communityById.get(id))
        .filter((c): c is NonNullable<typeof c> => Boolean(c))
        .map((c) => communityRef(c));

      const debateIds = byKind("debate").map((r) => r.key);
      const debateRows =
        debateIds.length > 0
          ? await db.select().from(debates).where(inArray(debates.id, debateIds))
          : [];
      const debateById = new Map(debateRows.map((d) => [d.id, d]));
      const debateWires = [];
      for (const id of debateIds) {
        const row = debateById.get(id);
        if (row) debateWires.push(await debateWireFor(db, row, viewerId));
      }

      return {
        hashtags,
        communities: communityRefs,
        debates: debateWires,
        posts: postWires,
        computed_at: latest ? latest.computedAt.toISOString() : null,
        window: "trailing_6h",
      };
    },
  );
}
