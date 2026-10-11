/**
 * Story routes (Phase 2, API_SPEC Stories + DATA_MODEL §7).
 *
 * A story is a STORY posts row plus a `stories` extension row; it expires
 * exactly 24 h after creation. Expiry is enforced in every query here (an
 * expired story 404s) and the worker's sweep hard-purges frames 7 days
 * after expiry. Audience `close_friends` is honored through the
 * close_friends table.
 */
import { and, count, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import type { Db } from "../db";
import {
  closeFriends,
  follows,
  posts,
  stories,
  storyViews,
} from "../db/schema";
import { forbidden, notFound, unprocessable } from "../lib/errors";
import { pathLabel, shortCode, uuidv7 } from "../lib/ids";
import { optionalAuth, requireAuth, requireScope } from "../lib/auth";
import { decodeCursor, encodeCursor } from "../lib/pagination";
import {
  mediaWire,
  pageEnvelope,
  storyWire,
  type StoryGroupWire,
  type StoryRow,
} from "../lib/serializers";
import { parseBody } from "../lib/validate";
import { getMediaById } from "../services/media";
import { authorRefFor, profileMap } from "../services/users";

export const STORY_TTL_MS = 24 * 60 * 60 * 1000;

const createStorySchema = z.object({
  media_id: z.string().uuid(),
  audience: z.enum(["everyone", "close_friends"]).default("everyone"),
  stickers: z
    .array(
      z.object({
        kind: z.enum(["poll", "question", "vote", "text", "mention", "link"]),
        poll_id: z.string().uuid().optional(),
        text: z.string().max(120).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
      }),
    )
    .max(10)
    .default([]),
});

type StoryWithAuthor = { story: StoryRow; authorId: string };

/** Can `viewerId` see this story right now (exists, unexpired, audience)? */
async function visibleStory(
  db: Db,
  storyId: string,
  viewerId: string | null,
): Promise<StoryWithAuthor | null> {
  const [row] = await db
    .select({ story: stories, authorId: posts.authorId })
    .from(stories)
    .innerJoin(posts, eq(posts.id, stories.postId))
    .where(
      and(
        eq(stories.postId, storyId),
        gt(stories.expiresAt, new Date()),
        sql`${posts.deletedAt} is null`,
      ),
    )
    .limit(1);
  if (!row) return null;
  if (row.story.audience === "close_friends" && viewerId !== row.authorId) {
    if (!viewerId) return null;
    const [friend] = await db
      .select()
      .from(closeFriends)
      .where(
        and(
          eq(closeFriends.ownerId, row.authorId),
          eq(closeFriends.friendId, viewerId),
        ),
      )
      .limit(1);
    if (!friend) return null;
  }
  return row;
}

async function storyWireFor(
  db: Db,
  row: StoryWithAuthor,
  viewerId: string | null,
) {
  const author = await authorRefFor(db, row.authorId);
  const mediaRow = await getMediaById(db, row.story.mediaId);
  if (!author || !mediaRow) throw notFound("Story not found");
  const isAuthor = viewerId === row.authorId;
  const [viewCountRow] = isAuthor
    ? await db
        .select({ value: count() })
        .from(storyViews)
        .where(eq(storyViews.storyId, row.story.postId))
    : [{ value: 0 }];
  let seen = false;
  if (viewerId && !isAuthor) {
    const [view] = await db
      .select()
      .from(storyViews)
      .where(
        and(
          eq(storyViews.storyId, row.story.postId),
          eq(storyViews.viewerId, viewerId),
        ),
      )
      .limit(1);
    seen = Boolean(view);
  }
  return storyWire(row.story, author, mediaWire(mediaRow), {
    viewCount: viewCountRow?.value ?? 0,
    viewerHasSeen: isAuthor ? true : seen,
  });
}

export async function registerStoryRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db } = ctx;

  // ── Create (201 Story) ──────────────────────────────────────────────────
  app.post(
    "/api/v1/stories",
    { preHandler: [requireAuth(ctx), requireScope("write:post")] },
    async (request, reply) => {
      const body = parseBody(createStorySchema, request.body);
      const me = request.authUser!;
      const mediaRow = await getMediaById(db, body.media_id);
      if (!mediaRow) throw notFound("Media not found");
      if (mediaRow.uploaderId !== me.sub) {
        throw forbidden("You can only post stories with your own media");
      }
      if (mediaRow.status !== "ready") {
        throw unprocessable(`Media is not ready (status: ${mediaRow.status})`);
      }
      const postId = uuidv7();
      const label = pathLabel(postId);
      const now = new Date();
      // Reuse the author's open group so consecutive frames ring together.
      const [openStory] = await db
        .select()
        .from(stories)
        .innerJoin(posts, eq(posts.id, stories.postId))
        .where(
          and(
            eq(posts.authorId, me.sub),
            gt(stories.expiresAt, now),
            sql`${posts.deletedAt} is null`,
          ),
        )
        .orderBy(desc(stories.createdAt))
        .limit(1);
      const groupId = openStory?.stories.storyGroupId ?? uuidv7();
      await db.transaction(async (tx) => {
        await tx.insert(posts).values({
          id: postId,
          shortCode: shortCode(),
          authorId: me.sub,
          authorType: me.authorType,
          type: "STORY",
          rootId: postId,
          path: label,
          pathLabel: label,
          depth: 0,
          visibility: body.audience === "close_friends" ? "close_friends" : "public",
        });
        await tx.insert(stories).values({
          postId,
          mediaId: mediaRow.id,
          storyGroupId: groupId,
          audience: body.audience,
          stickers: body.stickers,
          expiresAt: new Date(now.getTime() + STORY_TTL_MS),
        });
      });
      const created = await visibleStory(db, postId, me.sub);
      const wire = await storyWireFor(db, created!, me.sub);
      return reply.status(201).send(wire);
    },
  );

  // ── Feed: rings for followed accounts + own, unseen first ──────────────
  app.get(
    "/api/v1/stories/feed",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const me = request.authUser!;
      const now = new Date();
      const followeeRows = await db
        .select({ id: follows.followeeId })
        .from(follows)
        .where(eq(follows.followerId, me.sub));
      const authorIds = [...new Set([me.sub, ...followeeRows.map((r) => r.id)])];
      const rows = await db
        .select({ story: stories, authorId: posts.authorId })
        .from(stories)
        .innerJoin(posts, eq(posts.id, stories.postId))
        .where(
          and(
            inArray(posts.authorId, authorIds),
            gt(stories.expiresAt, now),
            sql`${posts.deletedAt} is null`,
          ),
        )
        .orderBy(desc(stories.createdAt));
      // Close-friends frames only surface for the author's close friends.
      const friendOf = new Set<string>();
      const cfRows = await db
        .select()
        .from(closeFriends)
        .where(
          and(
            inArray(closeFriends.ownerId, authorIds),
            eq(closeFriends.friendId, me.sub),
          ),
        );
      for (const row of cfRows) friendOf.add(row.ownerId);
      const visible = rows.filter(
        (r) =>
          r.story.audience !== "close_friends" ||
          r.authorId === me.sub ||
          friendOf.has(r.authorId),
      );
      const groups = new Map<string, StoryWithAuthor[]>();
      for (const row of visible) {
        const list = groups.get(row.authorId) ?? [];
        list.push(row);
        groups.set(row.authorId, list);
      }
      const groupWires: StoryGroupWire[] = [];
      for (const [authorId, list] of groups) {
        const author = await authorRefFor(db, authorId);
        if (!author) continue;
        const wires = [];
        for (const item of list) wires.push(await storyWireFor(db, item, me.sub));
        groupWires.push({
          author,
          stories: wires,
          has_unseen: wires.some((w) => !w.viewer_has_seen),
        });
      }
      // Own ring first, then unseen rings, then by most recent frame.
      groupWires.sort((a, b) => {
        if (a.author.id === me.sub) return -1;
        if (b.author.id === me.sub) return 1;
        if (a.has_unseen !== b.has_unseen) return a.has_unseen ? -1 : 1;
        const aLatest = a.stories[0]?.created_at ?? "";
        const bLatest = b.stories[0]?.created_at ?? "";
        return bLatest.localeCompare(aLatest);
      });
      return { data: groupWires };
    },
  );

  // ── Single story ────────────────────────────────────────────────────────
  app.get(
    "/api/v1/stories/:storyId",
    { preHandler: optionalAuth(ctx) },
    async (request) => {
      const { storyId } = request.params as { storyId: string };
      const row = await visibleStory(db, storyId, request.authUser?.sub ?? null);
      if (!row) throw notFound("Story not found");
      return storyWireFor(db, row, request.authUser?.sub ?? null);
    },
  );

  // ── Delete own story early (204) ────────────────────────────────────────
  app.delete(
    "/api/v1/stories/:storyId",
    { preHandler: [requireAuth(ctx), requireScope("write:post")] },
    async (request, reply) => {
      const { storyId } = request.params as { storyId: string };
      const me = request.authUser!;
      const [post] = await db
        .select()
        .from(posts)
        .where(eq(posts.id, storyId))
        .limit(1);
      if (!post || post.type !== "STORY" || post.deletedAt) {
        throw notFound("Story not found");
      }
      if (post.authorId !== me.sub) throw forbidden("You can only delete your own stories");
      await db
        .update(posts)
        .set({ deletedAt: new Date() })
        .where(eq(posts.id, storyId));
      return reply.status(204).send();
    },
  );

  // ── Record a view (204) ─────────────────────────────────────────────────
  app.post(
    "/api/v1/stories/:storyId/view",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      const { storyId } = request.params as { storyId: string };
      const me = request.authUser!;
      const row = await visibleStory(db, storyId, me.sub);
      if (!row) throw notFound("Story not found");
      if (row.authorId !== me.sub) {
        await db
          .insert(storyViews)
          .values({ storyId, viewerId: me.sub })
          .onConflictDoNothing();
      }
      return reply.status(204).send();
    },
  );

  // ── Viewers (author only, ProfilePage) ──────────────────────────────────
  const viewersQuerySchema = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  });

  app.get(
    "/api/v1/stories/:storyId/viewers",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const { storyId } = request.params as { storyId: string };
      const query = parseBody(viewersQuerySchema, request.query);
      const me = request.authUser!;
      const [post] = await db
        .select()
        .from(posts)
        .where(eq(posts.id, storyId))
        .limit(1);
      if (!post || post.type !== "STORY") throw notFound("Story not found");
      if (post.authorId !== me.sub) {
        throw forbidden("Only the author can see a story's viewers");
      }
      const cursor = decodeCursor<{ viewedAt: string; viewerId: string }>(query.cursor);
      const rows = await db
        .select()
        .from(storyViews)
        .where(
          and(
            eq(storyViews.storyId, storyId),
            cursor
              ? or(
                  lt(storyViews.viewedAt, new Date(cursor.viewedAt)),
                  and(
                    eq(storyViews.viewedAt, new Date(cursor.viewedAt)),
                    lt(storyViews.viewerId, cursor.viewerId),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(storyViews.viewedAt), desc(storyViews.viewerId))
        .limit(query.limit + 1);
      const pageRows = rows.slice(0, query.limit);
      const profiles = await profileMap(
        db,
        pageRows.map((r) => r.viewerId),
      );
      const last = pageRows[pageRows.length - 1];
      return pageEnvelope(
        pageRows
          .map((r) => profiles.get(r.viewerId))
          .filter((p): p is NonNullable<typeof p> => Boolean(p)),
        rows.length > query.limit && last
          ? encodeCursor({
              viewedAt: last.viewedAt.toISOString(),
              viewerId: last.viewerId,
            })
          : null,
      );
    },
  );
}
