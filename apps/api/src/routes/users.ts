import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { blocks, bookmarks, follows, mutes, posts, users } from "../db/schema";
import { optionalAuth, requireAuth, requireScope } from "../lib/auth";
import { conflict, notFound } from "../lib/errors";
import { decodeCursor, encodeCursor } from "../lib/pagination";
import { pageEnvelope, profileWire } from "../lib/serializers";
import { parseBody } from "../lib/validate";
import { notify } from "../services/notifications";
import { auditAgentAction } from "../services/agent-audit";
import { emitWebhookEvent } from "../services/webhooks";
import { hydratePosts, postPublishedCondition } from "../services/posts";
import { logEvent } from "../services/events";
import { debateRecordMap, getProfile, getUserByHandle, profileMap } from "../services/users";

const pageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

type FollowCursor = {
  createdAt: string;
  userId: string;
};

/** Cursor-paged follower/following list (keyset on created_at + user id), ProfilePage envelope. */
async function listFollowPage(
  ctx: AppContext,
  direction: "followers" | "following",
  userId: string,
  cursor: FollowCursor | null,
  limit: number,
) {
  const { db } = ctx;
  const cursorFilter = cursor
    ? or(
        lt(follows.createdAt, new Date(cursor.createdAt)),
        and(
          eq(follows.createdAt, new Date(cursor.createdAt)),
          lt(direction === "followers" ? follows.followerId : follows.followeeId, cursor.userId),
        ),
      )
    : undefined;
  const rows = await db
    .select()
    .from(follows)
    .where(
      and(
        direction === "followers"
          ? eq(follows.followeeId, userId)
          : eq(follows.followerId, userId),
        cursorFilter,
      ),
    )
    .orderBy(desc(follows.createdAt), desc(direction === "followers" ? follows.followerId : follows.followeeId))
    .limit(limit + 1);
  const pageRows = rows.slice(0, limit);
  const otherIds = pageRows.map((r) =>
    direction === "followers" ? r.followerId : r.followeeId,
  );
  const profilesById = await profileMap(db, otherIds);
  const items = otherIds
    .map((id) => profilesById.get(id))
    .filter((dto): dto is NonNullable<typeof dto> => dto !== undefined);
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor({
          createdAt: last.createdAt.toISOString(),
          userId: direction === "followers" ? last.followerId : last.followeeId,
        } satisfies FollowCursor)
      : null;
  return pageEnvelope(items, nextCursor);
}

const HANDLE_PATTERN = /^[a-z0-9_]{3,24}$/;

export async function registerUserRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db } = ctx;

  // Handle availability (register form + onboarding). Static segment —
  // Fastify routes it ahead of /users/:handle.
  app.get("/api/v1/users/handle-available", async (request) => {
    const query = parseBody(
      z.object({ handle: z.string().optional() }),
      request.query,
    );
    const handle = (query.handle ?? "").toLowerCase();
    if (!HANDLE_PATTERN.test(handle)) {
      return { handle, available: false, reason: "invalid" as const };
    }
    const existing = await getUserByHandle(db, handle);
    return existing
      ? { handle, available: false, reason: "taken" as const }
      : { handle, available: true, reason: null };
  });

  app.get(
    "/api/v1/users/:handle",
    { preHandler: optionalAuth(ctx) },
    async (request) => {
      const { handle } = request.params as { handle: string };
      const user = await getUserByHandle(db, handle);
      if (!user || user.deletedAt) throw notFound("User not found");
      const records = await debateRecordMap(db, [user.id]);
      const wire = profileWire(
        user,
        await getProfile(db, user.id),
        {},
        records.get(user.id) ?? null,
      );
      const viewer = request.authUser;
      if (!viewer) return wire;
      // viewer_state (API_SPEC Profile.viewer_state)
      const [following] = await db
        .select()
        .from(follows)
        .where(and(eq(follows.followerId, viewer.sub), eq(follows.followeeId, user.id)))
        .limit(1);
      const [followedBy] = await db
        .select()
        .from(follows)
        .where(and(eq(follows.followerId, user.id), eq(follows.followeeId, viewer.sub)))
        .limit(1);
      const [blocked] = await db
        .select()
        .from(blocks)
        .where(and(eq(blocks.blockerId, viewer.sub), eq(blocks.blockedId, user.id)))
        .limit(1);
      const [muted] = await db
        .select()
        .from(mutes)
        .where(and(eq(mutes.muterId, viewer.sub), eq(mutes.mutedId, user.id)))
        .limit(1);
      return {
        ...wire,
        viewer_state: {
          is_self: viewer.sub === user.id,
          is_following: following !== undefined,
          is_followed_by: followedBy !== undefined,
          is_blocked: blocked !== undefined,
          is_muted: muted !== undefined,
          is_close_friend: false,
        },
      };
    },
  );

  app.post(
    "/api/v1/users/:handle/follow",
    { preHandler: [requireAuth(ctx), requireScope("write:post")] },
    async (request, reply) => {
      const { handle } = request.params as { handle: string };
      const me = request.authUser!;
      const target = await getUserByHandle(db, handle);
      if (!target || target.deletedAt) throw notFound("User not found");
      if (target.id === me.sub) throw conflict("You cannot follow yourself");
      let followedNew = false;
      await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(follows)
          .values({ followerId: me.sub, followeeId: target.id })
          .onConflictDoNothing()
          .returning();
        if (inserted.length === 0) return; // already following — idempotent
        await tx
          .update(users)
          .set({ followingCount: sql`${users.followingCount} + 1` })
          .where(eq(users.id, me.sub));
        await tx
          .update(users)
          .set({ followerCount: sql`${users.followerCount} + 1` })
          .where(eq(users.id, target.id));
        followedNew = true;
        await notify(tx, {
          recipientId: target.id,
          type: "follow",
          actorId: me.sub,
          subjectType: "user",
          subjectId: me.sub,
          payload: { handle: me.handle },
        });
      });
      await auditAgentAction(db, request, "user.follow", "user", target.id);
      if (followedNew) {
        await emitWebhookEvent(db, ctx.config, target.id, "follow.created", {
          actor_id: me.sub,
          actor_handle: me.handle,
        });
        await logEvent(db, {
          userId: me.sub,
          type: "follow",
          subjectType: "user",
          subjectId: target.id,
        });
      }
      return reply.status(204).send();
    },
  );

  app.delete(
    "/api/v1/users/:handle/follow",
    { preHandler: [requireAuth(ctx), requireScope("write:post")] },
    async (request, reply) => {
      const { handle } = request.params as { handle: string };
      const me = request.authUser!;
      const target = await getUserByHandle(db, handle);
      if (!target) throw notFound("User not found");
      const deleted = await db
        .delete(follows)
        .where(and(eq(follows.followerId, me.sub), eq(follows.followeeId, target.id)))
        .returning();
      if (deleted.length > 0) {
        await db.transaction(async (tx) => {
          await tx
            .update(users)
            .set({ followingCount: sql`greatest(${users.followingCount} - 1, 0)` })
            .where(eq(users.id, me.sub));
          await tx
            .update(users)
            .set({ followerCount: sql`greatest(${users.followerCount} - 1, 0)` })
            .where(eq(users.id, target.id));
        });
      }
      await auditAgentAction(db, request, "user.unfollow", "user", target.id);
      return reply.status(204).send();
    },
  );

  // ── Block / unblock (API_SPEC blockUser; the write side lands with
  // Phase 5A — reads + visibility effects existed since Phase 1).
  // Blocking severs follows in both directions.
  app.post(
    "/api/v1/users/:handle/block",
    { preHandler: [requireAuth(ctx), requireScope("write:post")] },
    async (request, reply) => {
      const { handle } = request.params as { handle: string };
      const me = request.authUser!;
      const target = await getUserByHandle(db, handle);
      if (!target || target.deletedAt) throw notFound("User not found");
      if (target.id === me.sub) throw conflict("You cannot block yourself");
      await db.transaction(async (tx) => {
        await tx
          .insert(blocks)
          .values({ blockerId: me.sub, blockedId: target.id })
          .onConflictDoNothing();
        const removed = await tx
          .delete(follows)
          .where(
            or(
              and(eq(follows.followerId, me.sub), eq(follows.followeeId, target.id)),
              and(eq(follows.followerId, target.id), eq(follows.followeeId, me.sub)),
            ),
          )
          .returning();
        for (const row of removed) {
          await tx
            .update(users)
            .set({ followingCount: sql`greatest(${users.followingCount} - 1, 0)` })
            .where(eq(users.id, row.followerId));
          await tx
            .update(users)
            .set({ followerCount: sql`greatest(${users.followerCount} - 1, 0)` })
            .where(eq(users.id, row.followeeId));
        }
      });
      await auditAgentAction(db, request, "user.block", "user", target.id);
      return reply.status(204).send();
    },
  );

  app.delete(
    "/api/v1/users/:handle/block",
    { preHandler: [requireAuth(ctx), requireScope("write:post")] },
    async (request, reply) => {
      const { handle } = request.params as { handle: string };
      const me = request.authUser!;
      const target = await getUserByHandle(db, handle);
      if (!target) throw notFound("User not found");
      await db
        .delete(blocks)
        .where(and(eq(blocks.blockerId, me.sub), eq(blocks.blockedId, target.id)));
      await auditAgentAction(db, request, "user.unblock", "user", target.id);
      return reply.status(204).send();
    },
  );

  app.get("/api/v1/users/:handle/followers", async (request) => {
    const { handle } = request.params as { handle: string };
    const query = parseBody(pageQuerySchema, request.query);
    const user = await getUserByHandle(db, handle);
    if (!user) throw notFound("User not found");
    return listFollowPage(
      ctx,
      "followers",
      user.id,
      decodeCursor<FollowCursor>(query.cursor),
      query.limit,
    );
  });

  app.get("/api/v1/users/:handle/following", async (request) => {
    const { handle } = request.params as { handle: string };
    const query = parseBody(pageQuerySchema, request.query);
    const user = await getUserByHandle(db, handle);
    if (!user) throw notFound("User not found");
    return listFollowPage(
      ctx,
      "following",
      user.id,
      decodeCursor<FollowCursor>(query.cursor),
      query.limit,
    );
  });

  // ── Profile post tabs (API_SPEC listUserPosts) ──────────────────────────
  const userPostsQuerySchema = pageQuerySchema.extend({
    tab: z.enum(["posts", "replies", "media", "debates"]).default("posts"),
  });

  app.get(
    "/api/v1/users/:handle/posts",
    { preHandler: optionalAuth(ctx) },
    async (request) => {
      const { handle } = request.params as { handle: string };
      const query = parseBody(userPostsQuerySchema, request.query);
      const user = await getUserByHandle(db, handle);
      if (!user || user.deletedAt) throw notFound("User not found");
      const viewerId = request.authUser?.sub ?? null;
      const isSelf = viewerId === user.id;
      const cursor = decodeCursor<{ createdAt: string; id: string }>(query.cursor);
      const tabFilter =
        query.tab === "replies"
          ? isNotNull(posts.parentId)
          : query.tab === "media"
            ? inArray(posts.type, ["IMAGE", "CAROUSEL", "VIDEO", "REEL"])
            : query.tab === "debates"
              ? eq(posts.type, "DEBATE")
              : isNull(posts.parentId);
      const rows = await db
        .select()
        .from(posts)
        .where(
          and(
            eq(posts.authorId, user.id),
            isNull(posts.deletedAt),
            postPublishedCondition(viewerId),
            tabFilter,
            isSelf
              ? undefined
              : inArray(posts.visibility, ["public", "community"]),
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
      const last = pageRows[pageRows.length - 1];
      const wires = await hydratePosts(db, pageRows, viewerId);
      return pageEnvelope(
        wires,
        rows.length > query.limit && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
      );
    },
  );

  // ── My bookmarks (API_SPEC listMyBookmarks) ─────────────────────────────
  const bookmarksQuerySchema = pageQuerySchema.extend({
    collection_id: z.string().uuid().optional(),
    collectionId: z.string().uuid().optional(),
  });

  app.get(
    "/api/v1/users/me/bookmarks",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const query = parseBody(bookmarksQuerySchema, request.query);
      const me = request.authUser!;
      const collectionId = query.collection_id ?? query.collectionId;
      const cursor = decodeCursor<{ createdAt: string; postId: string }>(query.cursor);
      const rows = await db
        .select({ post: posts, savedAt: bookmarks.createdAt })
        .from(bookmarks)
        .innerJoin(posts, eq(bookmarks.postId, posts.id))
        .where(
          and(
            eq(bookmarks.userId, me.sub),
            isNull(posts.deletedAt),
            collectionId ? eq(bookmarks.collectionId, collectionId) : undefined,
            cursor
              ? or(
                  lt(bookmarks.createdAt, new Date(cursor.createdAt)),
                  and(
                    eq(bookmarks.createdAt, new Date(cursor.createdAt)),
                    lt(bookmarks.postId, cursor.postId),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(bookmarks.createdAt), desc(bookmarks.postId))
        .limit(query.limit + 1);
      const pageRows = rows.slice(0, query.limit);
      const last = pageRows[pageRows.length - 1];
      const wires = await hydratePosts(
        db,
        pageRows.map((r) => r.post),
        me.sub,
      );
      return pageEnvelope(
        wires,
        rows.length > query.limit && last
          ? encodeCursor({
              createdAt: last.savedAt.toISOString(),
              postId: last.post.id,
            })
          : null,
      );
    },
  );
}
