import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { communities, communityMembers, communityModerators, posts } from "../db/schema";
import { optionalAuth, requireAuth, requireScope } from "../lib/auth";
import { conflict, forbidden, notFound, unprocessable } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { decodeCursor, encodeCursor } from "../lib/pagination";
import { authorRef, communityWire, membershipWire, pageEnvelope } from "../lib/serializers";
import { parseBody } from "../lib/validate";
import { notify } from "../services/notifications";
import { hydratePosts, postPublishedCondition } from "../services/posts";
import { getProfile, getUserById } from "../services/users";
import { hiddenAuthorIds, hideAiAccounts } from "../services/visibility";
import { HOT_EXPR } from "./feed";

const SLUG_PATTERN = /^[a-z0-9_]{3,30}$/;

const createCommunitySchema = z.object({
  slug: z.string(),
  name: z.string().min(1).max(60),
  description: z.string().max(500).nullable().optional(),
  visibility: z.enum(["public", "restricted", "private"]).optional(),
  isNsfw: z.boolean().optional(),
  is_nsfw: z.boolean().optional(),
  topics: z.array(z.string().max(30)).max(5).optional(),
});

async function bySlug(ctx: AppContext, slug: string) {
  const [row] = await ctx.db
    .select()
    .from(communities)
    .where(eq(communities.slug, slug.toLowerCase()))
    .limit(1);
  if (!row || row.deletedAt) throw notFound("Community not found");
  return row;
}

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().max(100).optional(),
  topic: z.string().max(30).optional(),
});

const communityPostsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(["hot", "new", "top", "rising", "controversial"]).default("hot"),
  window: z.enum(["hour", "day", "week", "month", "year", "all"]).default("day"),
  flair_id: z.string().uuid().optional(),
});

const WINDOW_MS: Record<string, number | null> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
  year: 31_536_000_000,
  all: null,
};

export async function registerCommunityRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db } = ctx;

  // ── Discovery list (API_SPEC listCommunities): ranked by membership, ────
  // private communities surface only for their own members.
  app.get(
    "/api/v1/communities",
    { preHandler: optionalAuth(ctx) },
    async (request) => {
      const query = parseBody(listQuerySchema, request.query);
      const viewerId = request.authUser?.sub ?? null;
      const cursor = decodeCursor<{ memberCount: number; id: string }>(query.cursor);
      const rows = await db
        .select()
        .from(communities)
        .where(
          and(
            isNull(communities.deletedAt),
            query.q
              ? or(
                  ilike(communities.name, `%${query.q}%`),
                  ilike(communities.slug, `%${query.q}%`),
                  ilike(communities.description, `%${query.q}%`),
                )
              : undefined,
            query.topic
              ? sql`${query.topic} = ANY(${communities.topics})`
              : undefined,
            viewerId
              ? or(
                  ne(communities.visibility, "private"),
                  inArray(
                    communities.id,
                    db
                      .select({ id: communityMembers.communityId })
                      .from(communityMembers)
                      .where(
                        and(
                          eq(communityMembers.userId, viewerId),
                          eq(communityMembers.status, "active"),
                        ),
                      ),
                  ),
                )
              : ne(communities.visibility, "private"),
            cursor
              ? or(
                  lt(communities.memberCount, cursor.memberCount),
                  and(
                    eq(communities.memberCount, cursor.memberCount),
                    lt(communities.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(communities.memberCount), desc(communities.id))
        .limit(query.limit + 1);
      const pageRows = rows.slice(0, query.limit);
      const last = pageRows[pageRows.length - 1];
      return pageEnvelope(
        pageRows.map((row) => communityWire(row)),
        rows.length > query.limit && last
          ? encodeCursor({ memberCount: last.memberCount, id: last.id })
          : null,
      );
    },
  );

  app.post(
    "/api/v1/communities",
    { preHandler: [requireAuth(ctx), requireScope("write:post")] },
    async (request, reply) => {
      const body = parseBody(createCommunitySchema, request.body);
      const me = request.authUser!;
      const slug = body.slug.toLowerCase();
      if (!SLUG_PATTERN.test(slug)) {
        throw unprocessable("slug must be 3–30 chars of [a-z0-9_]");
      }
      const [existing] = await db
        .select({ id: communities.id })
        .from(communities)
        .where(eq(communities.slug, slug))
        .limit(1);
      if (existing) throw conflict("A community with this slug already exists");
      const communityId = uuidv7();
      const community = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(communities)
          .values({
            id: communityId,
            slug,
            name: body.name,
            description: body.description ?? null,
            creatorId: me.sub,
            visibility: body.visibility ?? "public",
            isNsfw: body.isNsfw ?? body.is_nsfw ?? false,
            topics: body.topics ?? [],
            memberCount: 1,
          })
          .returning();
        await tx.insert(communityMembers).values({
          communityId,
          userId: me.sub,
          role: "owner",
          status: "active",
        });
        await tx.insert(communityModerators).values({
          communityId,
          userId: me.sub,
          grantedBy: me.sub,
        });
        return row!;
      });
      return reply.status(201).send(communityWire(community));
    },
  );

  app.get(
    "/api/v1/communities/:slug",
    { preHandler: optionalAuth(ctx) },
    async (request) => {
      const { slug } = request.params as { slug: string };
      const community = await bySlug(ctx, slug);
      const dto = communityWire(community);
      if (request.authUser) {
        const [membership] = await db
          .select()
          .from(communityMembers)
          .where(
            and(
              eq(communityMembers.communityId, community.id),
              eq(communityMembers.userId, request.authUser.sub),
            ),
          )
          .limit(1);
        const viewer = await getUserById(db, request.authUser.sub);
        return {
          ...dto,
          viewer_membership: membership && viewer
            ? membershipWire(membership, authorRef(viewer, await getProfile(db, viewer.id)))
            : null,
        };
      }
      return { ...dto, viewer_membership: null };
    },
  );

  // ── Community feed (API_SPEC listCommunityPosts): top-level posts only, ─
  // Reddit-style sorts, PostPage envelope (hydration carries vote_breakdown).
  app.get(
    "/api/v1/communities/:slug/posts",
    { preHandler: optionalAuth(ctx) },
    async (request) => {
      const { slug } = request.params as { slug: string };
      const query = parseBody(communityPostsQuerySchema, request.query);
      const community = await bySlug(ctx, slug);
      const viewerId = request.authUser?.sub ?? null;

      if (community.visibility === "private") {
        const [membership] = viewerId
          ? await db
              .select()
              .from(communityMembers)
              .where(
                and(
                  eq(communityMembers.communityId, community.id),
                  eq(communityMembers.userId, viewerId),
                  eq(communityMembers.status, "active"),
                ),
              )
              .limit(1)
          : [];
        if (!membership) throw forbidden("This community is private");
      }

      const hidden = viewerId ? await hiddenAuthorIds(ctx, viewerId) : [];
      const base = [
        eq(posts.communityId, community.id),
        isNull(posts.parentId),
        isNull(posts.deletedAt),
        postPublishedCondition(viewerId),
        query.flair_id ? eq(posts.flairId, query.flair_id) : undefined,
        hidden.length > 0 ? notInArray(posts.authorId, hidden) : undefined,
        viewerId && (await hideAiAccounts(ctx, viewerId))
          ? eq(posts.authorType, "human")
          : undefined,
      ];

      // Phase 5B sticky posts: pinned posts (≤2, mod-set) float to the
      // top of the FIRST page of every sort and are excluded from the
      // main stream so they never repeat. Later pages are unaffected.
      let pinnedRows: (typeof posts.$inferSelect)[] = [];
      if (!query.cursor && !query.flair_id) {
        pinnedRows = await db
          .select()
          .from(posts)
          .where(
            and(
              eq(posts.communityId, community.id),
              eq(posts.isPinned, true),
              isNull(posts.parentId),
              isNull(posts.deletedAt),
              postPublishedCondition(viewerId),
              hidden.length > 0 ? notInArray(posts.authorId, hidden) : undefined,
              viewerId && (await hideAiAccounts(ctx, viewerId))
                ? eq(posts.authorType, "human")
                : undefined,
            ),
          )
          .orderBy(desc(posts.createdAt))
          .limit(2);
        if (pinnedRows.length > 0) {
          base.push(notInArray(posts.id, pinnedRows.map((p) => p.id)));
        }
      }

      let rows;
      let nextCursor: string | null = null;
      if (query.sort === "new") {
        const cursor = decodeCursor<{ createdAt: string; id: string }>(query.cursor);
        rows = await db
          .select()
          .from(posts)
          .where(
            and(
              ...base,
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
        nextCursor =
          rows.length > query.limit && last
            ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
            : null;
        rows = pageRows;
      } else if (query.sort === "top") {
        const cursor = decodeCursor<{ score: number; id: string }>(query.cursor);
        const windowMs = WINDOW_MS[query.window];
        rows = await db
          .select()
          .from(posts)
          .where(
            and(
              ...base,
              windowMs !== null && windowMs !== undefined
                ? sql`${posts.createdAt} >= ${new Date(Date.now() - windowMs)}`
                : undefined,
              cursor
                ? or(
                    lt(posts.score, cursor.score),
                    and(eq(posts.score, cursor.score), lt(posts.id, cursor.id)),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(posts.score), desc(posts.id))
          .limit(query.limit + 1);
        const pageRows = rows.slice(0, query.limit);
        const last = pageRows[pageRows.length - 1];
        nextCursor =
          rows.length > query.limit && last
            ? encodeCursor({ score: last.score, id: last.id })
            : null;
        rows = pageRows;
      } else {
        // hot / rising / controversial: score-derived orderings page by
        // offset, matching the explore feed (the ordering key is time-varying).
        const offset = decodeCursor<{ offset: number }>(query.cursor)?.offset ?? 0;
        const order =
          query.sort === "controversial"
            ? [desc(sql<number>`coalesce(${posts.controversyRank}, 0)`), desc(posts.id)]
            : [desc(HOT_EXPR), desc(posts.id)];
        rows = await db
          .select()
          .from(posts)
          .where(
            and(
              ...base,
              query.sort === "rising"
                ? sql`${posts.createdAt} >= ${new Date(Date.now() - 48 * 3_600_000)}`
                : undefined,
            ),
          )
          .orderBy(...order)
          .limit(query.limit + 1)
          .offset(offset);
        nextCursor =
          rows.length > query.limit
            ? encodeCursor({ offset: offset + query.limit })
            : null;
        rows = rows.slice(0, query.limit);
      }

      if (pinnedRows.length > 0) rows = [...pinnedRows, ...rows];
      const wires = await hydratePosts(db, rows, viewerId);
      return pageEnvelope(wires, nextCursor);
    },
  );

  const join = async (request: FastifyRequest) => {
    const { slug } = request.params as { slug: string };
    const me = request.authUser!;
    const community = await bySlug(ctx, slug);
    const status = community.visibility === "private" ? "pending" : "active";
    const membership = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(communityMembers)
        .where(
          and(
            eq(communityMembers.communityId, community.id),
            eq(communityMembers.userId, me.sub),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.status === "banned") throw conflict("You are banned from this community");
        return existing;
      }
      const [row] = await tx
        .insert(communityMembers)
        .values({ communityId: community.id, userId: me.sub, role: "member", status })
        .returning();
      if (status === "active") {
        await tx
          .update(communities)
          .set({ memberCount: sql`${communities.memberCount} + 1` })
          .where(eq(communities.id, community.id));
      }
      if (status === "pending") {
        // Join request on a private community: notify the mod team. The
        // approval surface (spec mod membership-requests) is a later slice;
        // the request itself is the event the schema supports today.
        const mods = await tx
          .select()
          .from(communityMembers)
          .where(
            and(
              eq(communityMembers.communityId, community.id),
              inArray(communityMembers.role, ["owner", "admin", "moderator"]),
              eq(communityMembers.status, "active"),
            ),
          );
        for (const mod of mods) {
          await notify(tx, {
            recipientId: mod.userId,
            type: "system",
            actorId: me.sub,
            subjectType: "community",
            subjectId: community.id,
            payload: {
              kind: "join_request",
              community_slug: community.slug,
              community_name: community.name,
              handle: me.handle,
            },
          });
        }
      }
      return row!;
    });
    const me2 = await getUserById(db, me.sub);
    return membershipWire(
      membership,
      authorRef(me2!, await getProfile(db, me.sub)),
    );
  };

  app.post("/api/v1/communities/:slug/join", { preHandler: [requireAuth(ctx), requireScope("write:post")] }, join);

  const leave = async (request: FastifyRequest, reply: FastifyReply) => {
    const { slug } = request.params as { slug: string };
    const me = request.authUser!;
    const community = await bySlug(ctx, slug);
    const [membership] = await db
      .select()
      .from(communityMembers)
      .where(
        and(
          eq(communityMembers.communityId, community.id),
          eq(communityMembers.userId, me.sub),
        ),
      )
      .limit(1);
    if (membership?.role === "owner") {
      throw conflict("The owner cannot leave; transfer ownership first");
    }
    if (membership) {
      await db.transaction(async (tx) => {
        await tx
          .delete(communityMembers)
          .where(
            and(
              eq(communityMembers.communityId, community.id),
              eq(communityMembers.userId, me.sub),
            ),
          );
        if (membership.status === "active") {
          await tx
            .update(communities)
            .set({ memberCount: sql`greatest(${communities.memberCount} - 1, 0)` })
            .where(eq(communities.id, community.id));
        }
      });
    }
    return reply.status(204).send();
  };

  app.post("/api/v1/communities/:slug/leave", { preHandler: [requireAuth(ctx), requireScope("write:post")] }, leave);
  app.delete("/api/v1/communities/:slug/join", { preHandler: [requireAuth(ctx), requireScope("write:post")] }, leave);
}
