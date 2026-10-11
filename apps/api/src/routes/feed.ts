import { and, desc, eq, inArray, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { communityMembers, follows, posts } from "../db/schema";
import { optionalAuth, requireAuth, requireScope } from "../lib/auth";
import { decodeCursor, encodeCursor } from "../lib/pagination";
import { pageEnvelope, type PostWire } from "../lib/serializers";
import { parseBody } from "../lib/validate";
import { HOT_EPOCH } from "../lib/vote-math";
import { hydratePosts, postPublishedCondition } from "../services/posts";
import { hiddenAuthorIds, hideAiAccounts } from "../services/visibility";
import { logEventSoon } from "../services/events";

const pageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  tab: z.enum(["for_you", "following"]).optional(),
});

interface FeedItem {
  post: PostWire;
  why: { source: string; reasons: string[] };
}

/** Reddit-style hot ordering expression (ARCHITECTURE §7.2). Shared with the community feed. */
export const HOT_EXPR = sql<number>`sign(${posts.score}) * log(greatest(abs(${posts.score}), 1)) + (extract(epoch from ${posts.createdAt}) - ${HOT_EPOCH}) / 45000`;

async function followedIds(ctx: AppContext, viewerId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ id: follows.followeeId })
    .from(follows)
    .where(eq(follows.followerId, viewerId));
  return rows.map((r) => r.id);
}

async function joinedCommunityIds(ctx: AppContext, viewerId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ id: communityMembers.communityId })
    .from(communityMembers)
    .where(
      and(eq(communityMembers.userId, viewerId), eq(communityMembers.status, "active")),
    );
  return rows.map((r) => r.id);
}

/**
 * Stories are posts rows (type STORY) with their media in the stories
 * extension — as feed cards they render as empty posts. No post-listing
 * surface may include them; rings/stories endpoints are the only readers.
 */
const notStory = () => ne(posts.type, "STORY");

export async function registerFeedRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db } = ctx;

  // ── Following: reverse-chronological, followed accounts + own posts ──────
  const followingHandler = async (request: FastifyRequest) => {
    const query = parseBody(pageQuerySchema, request.query);
    const me = request.authUser!;
    const cursor = decodeCursor<{ createdAt: string; id: string }>(query.cursor);
    const hidden = await hiddenAuthorIds(ctx, me.sub);
    const rows = await db
      .select()
      .from(posts)
      .where(
        and(
          isNull(posts.deletedAt),
          isNull(posts.parentId),
          notStory(),
          postPublishedCondition(me.sub),
          hidden.length > 0 ? notInArray(posts.authorId, hidden) : undefined,
          or(
            eq(posts.authorId, me.sub),
            inArray(
              posts.authorId,
              db
                .select({ id: follows.followeeId })
                .from(follows)
                .where(eq(follows.followerId, me.sub)),
            ),
          ),
          cursor
            ? or(
                lt(posts.createdAt, new Date(cursor.createdAt)),
                and(eq(posts.createdAt, new Date(cursor.createdAt)), lt(posts.id, cursor.id)),
              )
            : undefined,
          (await hideAiAccounts(ctx, me.sub)) ? eq(posts.authorType, "human") : undefined,
        ),
      )
      .orderBy(desc(posts.createdAt), desc(posts.id))
      .limit(query.limit + 1);
    const pageRows = rows.slice(0, query.limit);
    const last = pageRows[pageRows.length - 1];
    const wires = await hydratePosts(db, pageRows, me.sub);
    const items: FeedItem[] = wires.map((post) => ({
      post,
      why: {
        source: "followed",
        reasons: [
          post.author.id === me.sub
            ? "Your post"
            : `From @${post.author.handle}, who you follow`,
        ],
      },
    }));
    logEventSoon(
      db,
      {
        userId: me.sub,
        type: "feed.impression",
        props: { tab: "following", post_ids: pageRows.map((r) => r.id) },
      },
      request.log,
    );
    return pageEnvelope(
      items,
      rows.length > query.limit && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
    );
  };

  // ── For You — Ranking v2 (Phase 5B, D-058) ─────────────────────────────
  // Documented scoring function over real signals. Candidates: top-level,
  // visible posts from the last 7 days reachable by the viewer (public ∪
  // followed authors ∪ joined communities), pre-scored in SQL, finalized
  // in TS with an author-diversity penalty:
  //
  //   score = hot + relationship + recency + velocity
  //   hot          = sign(score)·log10(1+|score|)            (raw approval)
  //   relationship = +3.0 followed author, +2.0 joined community (cap +4)
  //   recency      = 2.5 · exp(−age_hours / 30)              (≈30 h half-life-ish decay)
  //   velocity     = 1.2 · ln(1 + (up + 2·replies + quotes + reposts)
  //                            / (age_hours + 2)^1.15)        (engagement/hour, damped)
  //
  // Diversity: walking the pre-scored list in order, each post by an
  // author already placed k times in this ranking is demoted: its score
  // is multiplied by 0.75^k and the list is re-sorted greedily (one pass,
  // MMR-lite). "Following" and "Latest" feeds are untouched by v2. The
  // hide-AI setting and hidden-author list apply exactly as in v1.
  // Impressions: every served page writes ONE feed.impression event with
  // the served post ids (unsampled — one insert per page, not per post).
  const FOR_YOU_POOL = 300;
  const forYouHandler = async (request: FastifyRequest) => {
    const query = parseBody(pageQuerySchema, request.query);
    const me = request.authUser!;
    const offset = decodeCursor<{ offset: number }>(query.cursor)?.offset ?? 0;
    const hidden = await hiddenAuthorIds(ctx, me.sub);
    const [followed, joined] = await Promise.all([
      followedIds(ctx, me.sub),
      joinedCommunityIds(ctx, me.sub),
    ]);
    const candidateSources = [eq(posts.visibility, "public")];
    if (followed.length > 0) candidateSources.push(inArray(posts.authorId, followed));
    if (joined.length > 0) candidateSources.push(inArray(posts.communityId, joined));
    const followedArr = followed.length > 0 ? followed : ["00000000-0000-0000-0000-000000000000"];
    const joinedArr = joined.length > 0 ? joined : ["00000000-0000-0000-0000-000000000000"];
    // Age in hours as float8: extract(epoch) is NUMERIC in Postgres and
    // power(numeric, numeric) is arbitrary-precision — measured 55 ms for
    // ~1.5k candidates vs ~2 ms on the float path (same math, D-058).
    const ageHours = sql<number>`(extract(epoch from (now() - ${posts.createdAt})) / 3600.0)::float8`;
    const rankScore = sql<number>`
      sign(${posts.score}) * (ln(1 + abs(${posts.score})) / ln(10))
      + least(
          (case when ${posts.authorId} in (${sql.join(
            followedArr.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}) then 3.0 else 0 end)
          + (case when ${posts.communityId} in (${sql.join(
            joinedArr.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}) then 2.0 else 0 end),
          4.0
        )
      + 2.5 * exp(-(${ageHours}) / 30.0)
      + 1.2 * ln(1 + ((${posts.upCount} + 2 * ${posts.replyCount} + ${posts.quoteCount} + ${posts.repostCount})::float)
          / power(${ageHours} + 2, 1.15))
    `;
    // The pool query stays narrow (id + author + rank only): pulling 300
    // full post rows (bodies, HTML, link-card JSON) just to rank them
    // measured ~50 ms of transfer/mapping per request. The page slice is
    // fetched in full afterwards.
    const rows = await db
      .select({ id: posts.id, authorId: posts.authorId, rank: rankScore })
      .from(posts)
      .where(
        and(
          isNull(posts.deletedAt),
          isNull(posts.parentId),
          notStory(),
          postPublishedCondition(me.sub),
          sql`${posts.createdAt} > now() - interval '7 days'`,
          hidden.length > 0 ? notInArray(posts.authorId, hidden) : undefined,
          or(...candidateSources),
          (await hideAiAccounts(ctx, me.sub)) ? eq(posts.authorType, "human") : undefined,
        ),
      )
      .orderBy(desc(rankScore), desc(posts.id))
      .limit(FOR_YOU_POOL);
    // Author-diversity pass: greedy re-rank with a 0.75^k demotion.
    const placedByAuthor = new Map<string, number>();
    const selected: typeof rows = [];
    const pool = [...rows];
    while (pool.length > 0) {
      let bestIdx = 0;
      let bestScore = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const k = placedByAuthor.get(pool[i]!.authorId) ?? 0;
        const adjusted = pool[i]!.rank * Math.pow(0.75, k);
        if (adjusted > bestScore) {
          bestScore = adjusted;
          bestIdx = i;
        }
      }
      const [picked] = pool.splice(bestIdx, 1);
      selected.push(picked!);
      placedByAuthor.set(
        picked!.authorId,
        (placedByAuthor.get(picked!.authorId) ?? 0) + 1,
      );
      if (selected.length >= offset + query.limit + 1) break;
    }
    const pageRows = selected.slice(offset, offset + query.limit);
    const pagePosts =
      pageRows.length > 0
        ? await db
            .select()
            .from(posts)
            .where(
              inArray(
                posts.id,
                pageRows.map((r) => r.id),
              ),
            )
        : [];
    const postById = new Map(pagePosts.map((p) => [p.id, p]));
    const wires = await hydratePosts(
      db,
      pageRows.map((r) => postById.get(r.id)!).filter(Boolean),
      me.sub,
    );
    const followedSet = new Set(followed);
    const joinedSet = new Set(joined);
    const rankById = new Map(pageRows.map((r) => [r.id, r.rank]));
    const items: FeedItem[] = wires.map((post) => {
      const reasons: string[] = [];
      if (post.community && joinedSet.has(post.community.id)) {
        reasons.push(`From g/${post.community.slug}, which you joined`);
      }
      if (followedSet.has(post.author.id)) {
        reasons.push(`From @${post.author.handle}, who you follow`);
      }
      if (post.author.id === me.sub) reasons.push("Your post");
      if (reasons.length === 0) {
        reasons.push(
          (rankById.get(post.id) ?? 0) > 3
            ? "Active on GG right now"
            : "Popular on GG right now",
        );
        return { post, why: { source: "exploration", reasons } };
      }
      return {
        post,
        why: {
          source:
            post.community && joinedSet.has(post.community.id)
              ? "community"
              : "followed",
          reasons,
        },
      };
    });
    logEventSoon(
      db,
      {
        userId: me.sub,
        type: "feed.impression",
        props: {
          tab: "for_you",
          ranking: "v2",
          post_ids: pageRows.map((r) => r.id),
        },
      },
      request.log,
    );
    return pageEnvelope(
      items,
      selected.length > offset + query.limit
        ? encodeCursor({ offset: offset + query.limit })
        : null,
    );
  };

  // ── Explore: public top-level posts, hot-ordered (anonymous allowed) ────
  const exploreHandler = async (request: FastifyRequest) => {
    const query = parseBody(pageQuerySchema, request.query);
    const viewerId = request.authUser?.sub ?? null;
    const offset = decodeCursor<{ offset: number }>(query.cursor)?.offset ?? 0;
    const hidden = viewerId ? await hiddenAuthorIds(ctx, viewerId) : [];
    const rows = await db
      .select()
      .from(posts)
      .where(
        and(
          isNull(posts.deletedAt),
          isNull(posts.parentId),
          notStory(),
          postPublishedCondition(viewerId),
          eq(posts.visibility, "public"),
          hidden.length > 0 ? notInArray(posts.authorId, hidden) : undefined,
          viewerId && (await hideAiAccounts(ctx, viewerId))
            ? eq(posts.authorType, "human")
            : undefined,
        ),
      )
      .orderBy(desc(HOT_EXPR), desc(posts.id))
      .limit(query.limit + 1)
      .offset(offset);
    const pageRows = rows.slice(0, query.limit);
    const wires = await hydratePosts(db, pageRows, viewerId);
    logEventSoon(
      db,
      {
        userId: viewerId,
        type: "feed.impression",
        props: { tab: "explore", post_ids: pageRows.map((r) => r.id) },
      },
      request.log,
    );
    const items: FeedItem[] = wires.map((post) => ({
      post,
      why: { source: "trending", reasons: ["Trending on GG"] },
    }));
    return pageEnvelope(
      items,
      rows.length > query.limit ? encodeCursor({ offset: offset + query.limit }) : null,
    );
  };

  // Spec-canonical routes (API_SPEC getFeed / getExplore).
  app.get("/api/v1/feed", { preHandler: [requireAuth(ctx), requireScope("read:feed")] }, async (request) => {
    const tab = (request.query as { tab?: string }).tab ?? "for_you";
    return tab === "following" ? followingHandler(request) : forYouHandler(request);
  });
  app.get("/api/v1/explore", { preHandler: optionalAuth(ctx) }, exploreHandler);

  // Aliases kept from the original brief.
  app.get("/api/v1/feed/home", { preHandler: [requireAuth(ctx), requireScope("read:feed")] }, followingHandler);
  app.get("/api/v1/feed/explore", { preHandler: optionalAuth(ctx) }, exploreHandler);
}
