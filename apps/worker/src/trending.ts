/**
 * Trending computation (Phase 5A, D-052). Every 10 minutes the worker
 * snapshots the trailing 6 hours: hashtag counts (per post, once per
 * tag), post velocity (upvotes ×1 + replies ×2 from the vote audit
 * trail), community velocity (new posts ×1 + votes on their posts ×1),
 * and debate velocity (arguments ×1 + stance votes ×0.5). Stored as
 * one row per item in trending_snapshots (kind/key/score, D-054); the
 * API serves the latest computation batch — no per-request aggregation.
 */
import { sql } from "drizzle-orm";
import type { WorkerDb } from "./db";
import { trendingSnapshotsTable } from "./db";
import { uuidv7 } from "./opinion";

export const TRENDING_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface TrendingPayload {
  hashtags: { tag: string; post_count: number }[];
  posts: { id: string; velocity: number }[];
  communities: { id: string; velocity: number }[];
  debates: { id: string; velocity: number }[];
}

export interface TrendingRepo {
  windowPosts(since: Date, until: Date): Promise<Array<{ bodyMd: string | null }>>;
  postVelocity(since: Date, until: Date): Promise<Array<{ id: string; velocity: number }>>;
  communityVelocity(
    since: Date,
    until: Date,
  ): Promise<Array<{ id: string; velocity: number }>>;
  debateVelocity(since: Date, until: Date): Promise<Array<{ id: string; velocity: number }>>;
  insertSnapshot(windowStart: Date, windowEnd: Date, payload: TrendingPayload): Promise<void>;
}

const HASHTAG_RE = /#([a-z0-9_]{2,40})/gi;

/** Hashtags of one post body — each tag counted once per post. */
export function hashtagsOf(body: string | null): string[] {
  if (!body) return [];
  const tags = new Set<string>();
  for (const match of body.matchAll(HASHTAG_RE)) {
    tags.add(match[1]!.toLowerCase());
  }
  return [...tags];
}

export async function computeTrending(
  repo: TrendingRepo,
  now: Date,
): Promise<{ hashtags: number; posts: number; communities: number; debates: number }> {
  const since = new Date(now.getTime() - TRENDING_WINDOW_MS);

  const windowPosts = await repo.windowPosts(since, now);
  const tagCounts = new Map<string, number>();
  for (const post of windowPosts) {
    for (const tag of hashtagsOf(post.bodyMd)) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  const hashtags = [...tagCounts.entries()]
    .map(([tag, post_count]) => ({ tag, post_count }))
    .sort((a, b) => b.post_count - a.post_count || a.tag.localeCompare(b.tag))
    .slice(0, 10);

  const [postVel, communityVel, debateVel] = await Promise.all([
    repo.postVelocity(since, now),
    repo.communityVelocity(since, now),
    repo.debateVelocity(since, now),
  ]);
  const topScored = (
    rows: Array<{ id: string; velocity: number }>,
  ): { id: string; velocity: number }[] =>
    rows
      .filter((r) => r.velocity > 0)
      .sort((a, b) => b.velocity - a.velocity)
      .slice(0, 10);

  const payload: TrendingPayload = {
    hashtags,
    posts: topScored(postVel),
    communities: topScored(communityVel),
    debates: topScored(debateVel),
  };
  await repo.insertSnapshot(since, now, payload);
  return {
    hashtags: payload.hashtags.length,
    posts: payload.posts.length,
    communities: payload.communities.length,
    debates: payload.debates.length,
  };
}

interface RawVelocityRow {
  id: string;
  velocity: number | string;
}

function rowsOf(result: unknown): Array<{ id: string; velocity: number }> {
  const rows =
    (result as { rows?: RawVelocityRow[] }).rows ?? (result as RawVelocityRow[]);
  return rows.map((r) => ({ id: r.id, velocity: Number(r.velocity) }));
}

export function drizzleTrendingRepo(db: WorkerDb): TrendingRepo {
  return {
    async windowPosts(since, until) {
      return db.execute(sql`
        select body_md as "bodyMd" from posts
        where parent_id is null and deleted_at is null
          and created_at >= ${since.toISOString()} and created_at < ${until.toISOString()}
          and (scheduled_for is null or scheduled_for <= ${until.toISOString()})
      `) as unknown as Promise<Array<{ bodyMd: string | null }>>;
    },
    async postVelocity(since, until) {
      const result = await db.execute(sql`
        select p.id as id,
          (select count(*) from vote_audit va
             where va.target_type = 'post' and va.target_id = p.id
               and va.new_value = 1 and va.created_at >= ${since.toISOString()} and va.created_at < ${until.toISOString()}) * 1
          + (select count(*) from posts r
             where r.parent_id = p.id and r.deleted_at is null
               and r.created_at >= ${since.toISOString()} and r.created_at < ${until.toISOString()}) * 2
          as velocity
        from posts p
        where p.parent_id is null and p.deleted_at is null
          and (p.scheduled_for is null or p.scheduled_for <= ${until.toISOString()})
      `);
      return rowsOf(result);
    },
    async communityVelocity(since, until) {
      const result = await db.execute(sql`
        select c.id as id,
          (select count(*) from posts p
             where p.community_id = c.id and p.parent_id is null
               and p.deleted_at is null
               and p.created_at >= ${since.toISOString()} and p.created_at < ${until.toISOString()}) * 1
          + (select count(*) from vote_audit va
             join posts p2 on p2.id = va.target_id
             where va.target_type = 'post' and p2.community_id = c.id
               and va.new_value = 1
               and va.created_at >= ${since.toISOString()} and va.created_at < ${until.toISOString()}) * 1
          as velocity
        from communities c
        where c.deleted_at is null
      `);
      return rowsOf(result);
    },
    async debateVelocity(since, until) {
      const result = await db.execute(sql`
        select d.id as id,
          (select count(*) from arguments a
             where a.debate_id = d.id and a.deleted_at is null
               and a.created_at >= ${since.toISOString()} and a.created_at < ${until.toISOString()}) * 1
          + (select count(*) from stance_votes sv
             where sv.debate_id = d.id
               and sv.created_at >= ${since.toISOString()} and sv.created_at < ${until.toISOString()}) * 0.5
          as velocity
        from debates d
      `);
      return rowsOf(result);
    },
    async insertSnapshot(windowStart, windowEnd, payload) {
      // D-054: the table is one row per trending item (kind/key/score),
      // all rows of a computation sharing window + computed_at (= the
      // computation instant, so the API can read the batch by it).
      const rows = [
        ...payload.hashtags.map((h) => ({
          id: uuidv7(),
          kind: "hashtag",
          key: h.tag,
          score: h.post_count,
          payload: { post_count: h.post_count },
          windowStart,
          windowEnd,
          computedAt: windowEnd,
        })),
        ...payload.posts.map((p) => ({
          id: uuidv7(),
          kind: "post",
          key: p.id,
          score: p.velocity,
          payload: {},
          windowStart,
          windowEnd,
          computedAt: windowEnd,
        })),
        ...payload.communities.map((c) => ({
          id: uuidv7(),
          kind: "community",
          key: c.id,
          score: c.velocity,
          payload: {},
          windowStart,
          windowEnd,
          computedAt: windowEnd,
        })),
        ...payload.debates.map((d) => ({
          id: uuidv7(),
          kind: "debate",
          key: d.id,
          score: d.velocity,
          payload: {},
          windowStart,
          windowEnd,
          computedAt: windowEnd,
        })),
      ];
      if (rows.length > 0) await db.insert(trendingSnapshotsTable).values(rows);
    },
  };
}
