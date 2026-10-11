/**
 * Global search (API_SPEC: search, searchSuggest).
 *
 * Posts: Postgres FTS over the generated `posts.search_vector`
 * (title weight A, body weight B), ranked by ts_rank.
 * People/communities: pg_trgm similarity + substring match.
 * Deactivated accounts and their content never surface; private-community
 * posts surface only for members — the same visibility contract as feeds.
 */
import { and, desc, eq, ilike, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import {
  communities,
  communityMembers,
  postEmbeddings,
  posts,
  profiles,
  users,
} from "../db/schema";
import { optionalAuth } from "../lib/auth";
import { embedText, vectorLiteral } from "../lib/embeddings";
import { badRequest } from "../lib/errors";
import { decodeCursor, encodeCursor } from "../lib/pagination";
import {
  communityWire,
  pageEnvelope,
  profileWire,
  type CommunityRow,
  type PageEnvelope,
  type PostWire,
  type ProfileRow,
  type UserRow,
} from "../lib/serializers";
import { parseBody } from "../lib/validate";
import { hydratePosts, postPublishedCondition } from "../services/posts";
import { hiddenAuthorIds, hideAiAccounts } from "../services/visibility";

const searchQuerySchema = z.object({
  q: z.string().max(200).optional(),
  type: z
    .enum(["all", "posts", "people", "users", "communities", "hashtags", "debates"])
    .default("all"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** API_SPEC: use pgvector semantic matching in addition to full-text. */
  semantic: z.coerce.boolean().optional(),
});

const suggestQuerySchema = z.object({
  q: z.string().max(100).optional(),
});

/** Escape LIKE wildcards in user input. */
function likePattern(q: string): string {
  return `%${q.replace(/[%_\\]/g, "\\$&")}%`;
}

export async function registerSearchRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db } = ctx;

  /** Visibility conditions shared by the FTS and vector post searches. */
  async function postSearchConditions(viewerId: string | null) {
    const hidden = viewerId ? await hiddenAuthorIds(ctx, viewerId) : [];
    const memberVisible = viewerId
      ? sql`(
          c.visibility <> 'private'
          or exists (
            select 1 from community_members m
            where m.community_id = c.id and m.user_id = ${viewerId} and m.status = 'active'
          )
        )`
      : sql`c.visibility <> 'private'`;
    return and(
      isNull(posts.deletedAt),
      // Stories surface via rings only, never as search post cards.
      ne(posts.type, "STORY"),
      postPublishedCondition(viewerId),
      inArray(posts.visibility, ["public", "community"]),
      ne(users.status, "deactivated"),
      isNull(users.deletedAt),
      hidden.length > 0 ? notInArray(posts.authorId, hidden) : undefined,
      viewerId && (await hideAiAccounts(ctx, viewerId))
        ? eq(posts.authorType, "human")
        : undefined,
      sql`(
        ${posts.communityId} is null
        or exists (
          select 1 from communities c
          where c.id = ${posts.communityId} and c.deleted_at is null and ${memberVisible}
        )
      )`,
    );
  }

  async function searchPosts(
    q: string,
    viewerId: string | null,
    limit: number,
    offset: number,
  ) {
    const tsquery = sql`plainto_tsquery('english', ${q})`;
    const conditions = await postSearchConditions(viewerId);
    const rows = await db
      .select({ post: posts })
      .from(posts)
      .innerJoin(users, eq(posts.authorId, users.id))
      .where(and(conditions, sql`"posts"."search_vector" @@ ${tsquery}`))
      .orderBy(
        desc(sql<number>`ts_rank("posts"."search_vector", ${tsquery})`),
        desc(posts.createdAt),
        desc(posts.id),
      )
      .limit(limit + 1)
      .offset(offset);
    const pageRows = rows.slice(0, limit).map((r) => r.post);
    const wires = await hydratePosts(db, pageRows, viewerId);
    return pageEnvelope(
      wires,
      rows.length > limit ? encodeCursor({ offset: offset + limit }) : null,
    );
  }

  /**
   * Hybrid search (Phase 5B, D-061): FTS candidates and pgvector cosine
   * candidates (top 40 each, same visibility contract) are merged with a
   * documented blend — score = 0.6 · (ts_rank / max ts_rank) + 0.4 · cosine
   * similarity; a candidate missing from one side scores 0 there. This is
   * what lets a paraphrase with zero shared keywords still surface the
   * post (FTS side empty, cosine side carries it).
   */
  async function searchPostsHybrid(
    q: string,
    viewerId: string | null,
    limit: number,
    offset: number,
    queryEmbedding: number[],
  ) {
    const tsquery = sql`plainto_tsquery('english', ${q})`;
    const conditions = await postSearchConditions(viewerId);
    const literal = vectorLiteral(queryEmbedding);
    const [ftsRows, vectorRows] = await Promise.all([
      db
        .select({
          post: posts,
          rank: sql<number>`ts_rank("posts"."search_vector", ${tsquery})`,
        })
        .from(posts)
        .innerJoin(users, eq(posts.authorId, users.id))
        .where(and(conditions, sql`"posts"."search_vector" @@ ${tsquery}`))
        .orderBy(
          desc(sql<number>`ts_rank("posts"."search_vector", ${tsquery})`),
          desc(posts.id),
        )
        .limit(40),
      db
        .select({
          post: posts,
          cosine: sql<number>`1 - (${postEmbeddings.embedding} <=> ${literal}::vector)`,
        })
        .from(postEmbeddings)
        .innerJoin(posts, eq(postEmbeddings.postId, posts.id))
        .innerJoin(users, eq(posts.authorId, users.id))
        .where(
          and(
            conditions,
            sql`1 - (${postEmbeddings.embedding} <=> ${literal}::vector) > 0.2`,
          ),
        )
        .orderBy(sql`${postEmbeddings.embedding} <=> ${literal}::vector`)
        .limit(40),
    ]);
    const maxRank = Math.max(0, ...ftsRows.map((r) => Number(r.rank) || 0));
    const merged = new Map<
      string,
      { post: typeof posts.$inferSelect; score: number }
    >();
    for (const row of ftsRows) {
      const norm = maxRank > 0 ? (Number(row.rank) || 0) / maxRank : 0;
      merged.set(row.post.id, { post: row.post, score: 0.6 * norm });
    }
    for (const row of vectorRows) {
      const cosine = Math.max(0, Number(row.cosine) || 0);
      const existing = merged.get(row.post.id);
      if (existing) existing.score += 0.4 * cosine;
      else merged.set(row.post.id, { post: row.post, score: 0.4 * cosine });
    }
    const sorted = [...merged.values()].sort((a, b) => b.score - a.score);
    const pageRows = sorted.slice(offset, offset + limit).map((r) => r.post);
    const wires = await hydratePosts(db, pageRows, viewerId);
    return pageEnvelope(
      wires,
      sorted.length > offset + limit
        ? encodeCursor({ offset: offset + limit })
        : null,
    );
  }

  async function searchPeople(q: string, limit: number, offset: number) {
    const needle = q.toLowerCase();
    const rows = await db
      .select({ user: users, profile: profiles })
      .from(users)
      .leftJoin(profiles, eq(profiles.userId, users.id))
      .where(
        and(
          isNull(users.deletedAt),
          ne(users.status, "deactivated"),
          ne(users.status, "banned"),
          or(
            ilike(users.handle, likePattern(q)),
            ilike(profiles.displayName, likePattern(q)),
            sql`similarity(${users.handle}, ${needle}) > 0.25`,
            sql`similarity(${profiles.displayName}, ${needle}) > 0.25`,
          ),
        ),
      )
      .orderBy(
        sql`case when ${users.handle} = ${needle} then 0 else 1 end`,
        desc(
          sql<number>`greatest(similarity(${users.handle}, ${needle}), similarity(${profiles.displayName}, ${needle}))`,
        ),
        desc(users.followerCount),
      )
      .limit(limit + 1)
      .offset(offset);
    const pageRows = rows.slice(0, limit);
    return pageEnvelope(
      pageRows.map((r) => profileWire(r.user as UserRow, r.profile as ProfileRow | null)),
      rows.length > limit ? encodeCursor({ offset: offset + limit }) : null,
    );
  }

  async function searchCommunities(
    q: string,
    viewerId: string | null,
    limit: number,
    offset: number,
  ) {
    const needle = q.toLowerCase();
    const rows = await db
      .select()
      .from(communities)
      .where(
        and(
          isNull(communities.deletedAt),
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
          or(
            ilike(communities.slug, likePattern(q)),
            ilike(communities.name, likePattern(q)),
            ilike(communities.description, likePattern(q)),
            sql`similarity(${communities.slug}, ${needle}) > 0.25`,
            sql`similarity(${communities.name}, ${needle}) > 0.25`,
          ),
        ),
      )
      .orderBy(
        sql`case when ${communities.slug} = ${needle} then 0 else 1 end`,
        desc(
          sql<number>`greatest(similarity(${communities.slug}, ${needle}), similarity(${communities.name}, ${needle}))`,
        ),
        desc(communities.memberCount),
      )
      .limit(limit + 1)
      .offset(offset);
    const pageRows: CommunityRow[] = rows.slice(0, limit);
    return pageEnvelope(
      pageRows.map((row) => communityWire(row)),
      rows.length > limit ? encodeCursor({ offset: offset + limit }) : null,
    );
  }

  app.get(
    "/api/v1/search",
    { preHandler: optionalAuth(ctx) },
    async (request) => {
      const query = parseBody(searchQuerySchema, request.query);
      const q = (query.q ?? "").trim();
      if (q.length === 0) throw badRequest("Search query `q` must not be empty");
      const viewerId = request.authUser?.sub ?? null;
      const offset = decodeCursor<{ offset: number }>(query.cursor)?.offset ?? 0;
      const type = query.type === "users" ? "people" : query.type;
      const emptyPosts = pageEnvelope([], null);
      const emptyPeople = pageEnvelope([], null);
      const emptyCommunities = pageEnvelope([], null);

      // Semantic merge (D-061): explicit `semantic=true` always blends;
      // without the flag, a thin FTS result (< 5 posts on page one)
      // auto-blends so paraphrase queries still find their post. When the
      // embedding model is unavailable the FTS result stands and
      // `semantic_applied` reports false — no silent fiction.
      const wantPosts = type === "all" || type === "posts";
      const postsOffset = type === "posts" ? offset : 0;
      let semanticApplied = false;
      let postsPage: PageEnvelope<PostWire> = emptyPosts;
      if (wantPosts) {
        if (query.semantic === true) {
          const embedding = await embedText(ctx.config, q);
          if (embedding) {
            postsPage = await searchPostsHybrid(q, viewerId, query.limit, postsOffset, embedding);
            semanticApplied = true;
          } else {
            postsPage = await searchPosts(q, viewerId, query.limit, postsOffset);
          }
        } else {
          postsPage = await searchPosts(q, viewerId, query.limit, postsOffset);
          if (postsOffset === 0 && postsPage.data.length < 5) {
            const embedding = await embedText(ctx.config, q);
            if (embedding) {
              postsPage = await searchPostsHybrid(q, viewerId, query.limit, 0, embedding);
              semanticApplied = true;
            }
          }
        }
      }

      // The cursor pages the primary group; secondary groups return their
      // first page (the spec's SearchResults contract).
      const [peoplePage, communitiesPage] = await Promise.all([
        type === "all" || type === "people"
          ? searchPeople(q, query.limit, type === "people" ? offset : 0)
          : Promise.resolve(emptyPeople),
        type === "all" || type === "communities"
          ? searchCommunities(q, viewerId, query.limit, type === "communities" ? offset : 0)
          : Promise.resolve(emptyCommunities),
      ]);
      return {
        posts: postsPage,
        people: peoplePage,
        communities: communitiesPage,
        hashtags: [] as Array<{ tag: string; post_count: number }>,
        debates: [] as unknown[],
        semantic_applied: semanticApplied,
      };
    },
  );

  app.get(
    "/api/v1/search/suggest",
    { preHandler: optionalAuth(ctx) },
    async (request) => {
      const query = parseBody(suggestQuerySchema, request.query);
      const q = (query.q ?? "").trim();
      if (q.length === 0) throw badRequest("Search query `q` must not be empty");
      const [people, communitiesPage] = await Promise.all([
        searchPeople(q, 3, 0),
        searchCommunities(q, request.authUser?.sub ?? null, 3, 0),
      ]);
      const data = [
        ...people.data.map((p) => ({
          kind: "user" as const,
          label: p.display_name,
          id: p.handle,
        })),
        ...communitiesPage.data.map((c) => ({
          kind: "community" as const,
          label: c.name,
          id: c.slug,
        })),
      ];
      return { data };
    },
  );
}
