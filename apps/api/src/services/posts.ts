import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { AppContext } from "../context";
import type { Db } from "../db";
import {
  bookmarks,
  communities,
  media,
  postMedia,
  posts,
  reactions,
  voteAudit,
  votes,
} from "../db/schema";
import { forbidden, notFound, unprocessable } from "../lib/errors";
import { mediaForPosts } from "./media";
import { pathLabel, shortCode, uuidv7 } from "../lib/ids";
import { renderBodyHtml } from "../lib/render";
import {
  defaultViewerState,
  emptyBreakdown,
  postWire,
  type PostRow,
  type PostWire,
  type ViewerPostState,
  type VoteBreakdown,
} from "../lib/serializers";
import {
  checkVoteMilestone,
  notify,
  recordMentionsAndNotify,
} from "./notifications";
import { authorMap, communityMap } from "./users";
import { debateWiresForPosts } from "./debates";
import { pollWiresForPosts } from "./polls";
import { hotScore, voteDelta, voteWeight } from "../lib/vote-math";

export type CreatablePostType =
  | "TEXT"
  | "LINK"
  | "IMAGE"
  | "CAROUSEL"
  | "VIDEO"
  | "REEL";

export interface CreatePostInput {
  type: CreatablePostType;
  bodyMd: string;
  title?: string | null;
  linkUrl?: string | null;
  communityId?: string | null;
  parentId?: string | null;
  quotedPostId?: string | null;
  repostOfId?: string | null;
  /** Ordered media ids (API_SPEC PostCreate.media_ids, ≤ 10). */
  mediaIds?: string[];
  visibility?: PostRow["visibility"];
  isNsfw?: boolean;
  isSpoiler?: boolean;
  isLongForm?: boolean;
  /** Phase 5A (D-050): future publish time. While set, the post is author-only. */
  scheduledFor?: Date | null;
}

/**
 * Visibility predicate for list/feed queries:
 * - Phase 5A (D-050): a post with a future `scheduled_for` is visible only
 *   to its author.
 * - Phase 5B (AutoMod): a held post (`held_at` set) is visible only to its
 *   author; moderators work it from the mod queue, which reads posts
 *   directly and does not use this predicate.
 */
export function postPublishedCondition(viewerId: string | null): SQL {
  if (viewerId) {
    return sql`(${posts.scheduledFor} is null or ${posts.scheduledFor} <= now() or ${posts.authorId} = ${viewerId}::uuid) and (${posts.heldAt} is null or ${posts.authorId} = ${viewerId}::uuid)`;
  }
  return sql`(${posts.scheduledFor} is null or ${posts.scheduledFor} <= now()) and ${posts.heldAt} is null`;
}

/** Reels are capped at 3 minutes (API_SPEC UploadCreateRequest note). */
export const REEL_MAX_DURATION_MS = 180_000;

type MediaRowForAttach = typeof media.$inferSelect;

/**
 * Validate a media attachment set against the post type (Phase 2). Media
 * must exist, belong to the author, and be `ready` (scan-passed) — blocked
 * or in-flight media can never attach. TEXT/LINK posts may carry media as
 * attachments; the media types enforce their exact counts and kinds.
 */
export function validateMediaForPost(
  type: CreatablePostType,
  rows: MediaRowForAttach[],
  requestedIds: string[],
): void {
  if (rows.length !== requestedIds.length) {
    throw unprocessable("One or more media items were not found");
  }
  for (const row of rows) {
    if (row.status !== "ready") {
      throw unprocessable(
        `Media ${row.id} is not ready (status: ${row.status}); only scan-passed media can be attached`,
      );
    }
  }
  const images = rows.filter((r) => r.kind === "image" || r.kind === "gif");
  const videos = rows.filter((r) => r.kind === "video");
  switch (type) {
    case "IMAGE":
      if (rows.length !== 1 || images.length !== 1) {
        throw unprocessable("IMAGE posts require exactly one image");
      }
      break;
    case "CAROUSEL":
      if (rows.length < 2 || rows.length > 10 || images.length !== rows.length) {
        throw unprocessable("CAROUSEL posts require 2–10 images");
      }
      break;
    case "VIDEO":
      if (rows.length !== 1 || videos.length !== 1) {
        throw unprocessable("VIDEO posts require exactly one video");
      }
      break;
    case "REEL": {
      if (rows.length !== 1 || videos.length !== 1) {
        throw unprocessable("REEL posts require exactly one video");
      }
      const duration = videos[0]!.durationMs ?? 0;
      if (duration > REEL_MAX_DURATION_MS) {
        throw unprocessable("REEL videos are capped at 3 minutes");
      }
      break;
    }
    default:
      break; // TEXT / LINK: media rides along as attachments.
  }
}

export interface AuthorRef {
  id: string;
  authorType: "human" | "agent";
}

/** LINK posts carry a stub card in slice 1: {url, domain}. Real unfurl is Phase 2. */
export function linkCardStub(linkUrl: string): { url: string; domain: string } {
  return { url: linkUrl, domain: new URL(linkUrl).hostname };
}

/**
 * Create a post (top-level or reply) maintaining the ltree path, root_id,
 * depth and reply counters in one transaction (DATA_MODEL §5.1, D-007).
 */
export async function createPost(
  db: Db,
  author: AuthorRef,
  input: CreatePostInput,
): Promise<PostRow> {
  const id = uuidv7();
  const label = pathLabel(id);
  return db.transaction(async (tx) => {
    const isUnpublished = (row: PostRow): boolean =>
      Boolean(row.scheduledFor && row.scheduledFor.getTime() > Date.now());
    let parent: PostRow | null = null;
    if (input.parentId) {
      const [row] = await tx
        .select()
        .from(posts)
        .where(eq(posts.id, input.parentId))
        .limit(1);
      if (!row || row.deletedAt || isUnpublished(row)) throw notFound("Parent post not found");
      if (row.isLocked) throw forbidden("This thread is locked");
      parent = row;
    }
    // Quote / repost targets (API_SPEC PostCreate): must exist and be live.
    let quoted: PostRow | null = null;
    if (input.quotedPostId) {
      const [row] = await tx
        .select()
        .from(posts)
        .where(eq(posts.id, input.quotedPostId))
        .limit(1);
      if (!row || row.deletedAt || isUnpublished(row)) throw notFound("Quoted post not found");
      quoted = row;
    }
    let repostOf: PostRow | null = null;
    if (input.repostOfId) {
      const [row] = await tx
        .select()
        .from(posts)
        .where(eq(posts.id, input.repostOfId))
        .limit(1);
      if (!row || row.deletedAt || isUnpublished(row)) throw notFound("Reposted post not found");
      repostOf = row;
    }
    // Media attachments (Phase 2): own, ready (scan-passed) media only.
    const mediaIds = input.mediaIds ?? [];
    let attachRows: MediaRowForAttach[] = [];
    if (mediaIds.length > 0) {
      attachRows = await tx
        .select()
        .from(media)
        .where(inArray(media.id, mediaIds));
      for (const row of attachRows) {
        if (row.uploaderId !== author.id) {
          throw forbidden("You can only attach your own media");
        }
      }
      validateMediaForPost(input.type, attachRows, mediaIds);
    }
    const [created] = await tx
      .insert(posts)
      .values({
        id,
        shortCode: shortCode(),
        authorId: author.id,
        authorType: author.authorType,
        type: input.type,
        parentId: parent?.id ?? null,
        quotedPostId: quoted?.id ?? null,
        repostOfId: repostOf?.id ?? null,
        rootId: parent ? parent.rootId : id,
        path: parent ? `${parent.path}.${label}` : label,
        pathLabel: label,
        depth: parent ? parent.depth + 1 : 0,
        communityId: parent ? parent.communityId : (input.communityId ?? null),
        title: input.title ?? null,
        bodyMd: input.bodyMd,
        bodyHtml: renderBodyHtml(input.bodyMd),
        linkUrl: input.linkUrl ?? null,
        linkCard: input.linkUrl ? linkCardStub(input.linkUrl) : null,
        visibility:
          input.visibility ?? (input.communityId && !parent ? "community" : "public"),
        isNsfw: input.isNsfw ?? false,
        isSpoiler: input.isSpoiler ?? false,
        isLongForm: input.isLongForm ?? false,
        // Phase 5A (D-050): visibility keys off scheduled_for alone
        // (posts.published_at is NOT NULL/defaultNow and unused for
        // gating); side effects below are deferred to publish time.
        scheduledFor: input.scheduledFor ?? null,
      })
      .returning();
    const post = created!;

    if (attachRows.length > 0) {
      const byId = new Map(attachRows.map((r) => [r.id, r]));
      await tx.insert(postMedia).values(
        mediaIds.map((mediaId, position) => ({
          postId: post.id,
          mediaId: byId.get(mediaId)!.id,
          position,
        })),
      );
    }

    if (quoted) {
      await tx
        .update(posts)
        .set({ quoteCount: sql`${posts.quoteCount} + 1` })
        .where(eq(posts.id, quoted.id));
    }
    if (repostOf) {
      await tx
        .update(posts)
        .set({ repostCount: sql`${posts.repostCount} + 1` })
        .where(eq(posts.id, repostOf.id));
    }

    if (parent) {
      // reply_count = descendant count: every ancestor of the new reply
      // (the rows whose ltree path is a prefix of the parent's path) gains one.
      await tx
        .update(posts)
        .set({ replyCount: sql`${posts.replyCount} + 1` })
        .where(sql`${posts.path} @> ${parent.path}`);
      if (parent.authorId !== author.id) {
        await notify(tx, {
          recipientId: parent.authorId,
          type: "reply",
          actorId: author.id,
          subjectType: "post",
          subjectId: post.id,
          payload: { rootId: post.rootId, parentId: parent.id },
        });
      }
    } else if (input.communityId && !input.scheduledFor) {
      await tx
        .update(communities)
        .set({ postCount: sql`${communities.postCount} + 1` })
        .where(eq(communities.id, input.communityId));
    }
    // Mentions: post_mentions rows + one notification per mentioned user.
    // The parent author is covered by the "reply" notification above.
    if (!input.scheduledFor) {
      await recordMentionsAndNotify(tx, post, parent ? [parent.authorId] : []);
    }
    return post;
  });
}

/**
 * Phase 5A (D-050): publish a scheduled post — clear the schedule, stamp
 * published_at, and run the side effects deferred at create time
 * (community counter + mention records/notifications). The worker's
 * publisher mirrors this flow for due posts; webhook emission stays at
 * the route layer (see routes/posts.ts PATCH publish-now).
 */
export async function publishScheduledPost(db: Db, post: PostRow): Promise<PostRow> {
  const now = new Date();
  const [updated] = await db
    .update(posts)
    .set({ scheduledFor: null, publishedAt: now, updatedAt: now })
    .where(eq(posts.id, post.id))
    .returning();
  const fresh = updated!;
  if (fresh.communityId && !fresh.parentId) {
    await db
      .update(communities)
      .set({ postCount: sql`${communities.postCount} + 1` })
      .where(eq(communities.id, fresh.communityId));
  }
  await recordMentionsAndNotify(db, fresh, []);
  return fresh;
}

export async function getPostByIdOrCode(db: Db, idOrCode: string): Promise<PostRow | null> {
  const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrCode);
  const [row] = await db
    .select()
    .from(posts)
    .where(byId ? eq(posts.id, idOrCode) : eq(posts.shortCode, idOrCode))
    .limit(1);
  return row ?? null;
}

/** The viewer's active (non-voided) votes on a set of posts. */
export async function viewerVotes(
  db: Db,
  voterId: string,
  postIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (postIds.length === 0) return map;
  const rows = await db
    .select()
    .from(votes)
    .where(
      and(
        eq(votes.voterId, voterId),
        eq(votes.targetType, "post"),
        inArray(votes.targetId, postIds),
      ),
    );
  for (const row of rows) {
    if (!row.voidedAt) map.set(row.targetId, row.value);
  }
  return map;
}

/**
 * Human/agent split tallies for a set of posts (D-012: the split is always
 * displayable even though both weights are 1.0). Voided votes excluded.
 */
export async function voteBreakdowns(
  db: Db,
  postIds: string[],
): Promise<Map<string, VoteBreakdown>> {
  const map = new Map<string, VoteBreakdown>();
  if (postIds.length === 0) return map;
  const rows = await db
    .select({
      targetId: votes.targetId,
      authorType: votes.authorType,
      value: votes.value,
      count: sql<number>`count(*)::int`,
    })
    .from(votes)
    .where(
      and(
        eq(votes.targetType, "post"),
        inArray(votes.targetId, postIds),
        isNull(votes.voidedAt),
      ),
    )
    .groupBy(votes.targetId, votes.authorType, votes.value);
  for (const row of rows) {
    const breakdown = map.get(row.targetId) ?? emptyBreakdown();
    const bucket = breakdown[row.authorType];
    if (row.value === 1) bucket.up = row.count;
    else bucket.down = row.count;
    map.set(row.targetId, breakdown);
  }
  return map;
}

/** The viewer's vote + bookmark + reactions across a set of posts (viewer_state). */
export async function viewerPostStates(
  db: Db,
  viewerId: string,
  postIds: string[],
): Promise<Map<string, ViewerPostState>> {
  const map = new Map<string, ViewerPostState>();
  if (postIds.length === 0) return map;
  const stateFor = (id: string): ViewerPostState => {
    const existing = map.get(id);
    if (existing) return existing;
    const fresh = defaultViewerState();
    map.set(id, fresh);
    return fresh;
  };
  const voteRows = await db
    .select()
    .from(votes)
    .where(
      and(
        eq(votes.voterId, viewerId),
        eq(votes.targetType, "post"),
        inArray(votes.targetId, postIds),
      ),
    );
  for (const row of voteRows) {
    if (!row.voidedAt) stateFor(row.targetId).vote = row.value === 1 ? "up" : "down";
  }
  const bookmarkRows = await db
    .select()
    .from(bookmarks)
    .where(and(eq(bookmarks.userId, viewerId), inArray(bookmarks.postId, postIds)));
  for (const row of bookmarkRows) stateFor(row.postId).bookmarked = true;
  const reactionRows = await db
    .select()
    .from(reactions)
    .where(
      and(
        eq(reactions.userId, viewerId),
        eq(reactions.targetType, "post"),
        inArray(reactions.targetId, postIds),
      ),
    );
  for (const row of reactionRows) stateFor(row.targetId).reactions.push(row.kind);
  return map;
}

/** Hydrate post rows to spec Post wires (authors, communities, breakdowns, viewer state). */
export async function hydratePosts(
  db: Db,
  rows: PostRow[],
  viewerId: string | null,
): Promise<PostWire[]> {
  if (rows.length === 0) return [];
  const [authors, communitiesById, breakdowns, states, mediaByPost, pollWires, debateWires] =
    await Promise.all([
      authorMap(db, rows.map((r) => r.authorId)),
      communityMap(db, rows.map((r) => r.communityId)),
      voteBreakdowns(db, rows.map((r) => r.id)),
      viewerId
        ? viewerPostStates(db, viewerId, rows.map((r) => r.id))
        : Promise.resolve(new Map<string, ViewerPostState>()),
      mediaForPosts(db, rows.map((r) => r.id)),
      // Phase 3: POLL / DEBATE host posts embed their poll/debate wire.
      pollWiresForPosts(db, rows, viewerId),
      debateWiresForPosts(db, rows, viewerId),
    ]);
  return rows.map((row) =>
    postWire(row, authors.get(row.authorId)!, {
      viewerId,
      viewerState: states.get(row.id) ?? defaultViewerState(),
      breakdown: breakdowns.get(row.id) ?? emptyBreakdown(),
      community: row.communityId ? (communitiesById.get(row.communityId) ?? null) : null,
      media: mediaByPost.get(row.id) ?? [],
      poll: pollWires.get(row.id) ?? null,
      debate: debateWires.get(row.id) ?? null,
    }),
  );
}

export interface VoteSummary {
  upCount: number;
  downCount: number;
  score: number;
  viewerVote: number | null;
}

function summaryOf(post: PostRow, viewerVote: number | null): VoteSummary {
  return {
    upCount: post.upCount,
    downCount: post.downCount,
    score: Math.round(post.score),
    viewerVote,
  };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** vote_audit insert — one home for the audit row shape (§11.2). */
async function insertVoteAudit(
  tx: Tx,
  row: {
    voteId: string;
    voterId: string;
    targetId: string;
    oldValue: number | null;
    newValue: number | null;
    changeKind: string;
  },
): Promise<void> {
  await tx.insert(voteAudit).values({
    voteId: row.voteId,
    voterId: row.voterId,
    targetType: "post",
    targetId: row.targetId,
    oldValue: row.oldValue,
    newValue: row.newValue,
    changeKind: row.changeKind,
  });
}

/**
 * Process-local Idempotency-Key replay cache (slice 1; a shared store lands
 * with the Redis rate-limit slice — vote set-semantics are idempotent by
 * construction regardless, this only suppresses duplicate audit writes on
 * client retries carrying the same key).
 */
const idempotencyCache = new Map<string, { at: number; summary: VoteSummary }>();
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

/**
 * Cast/change/retract a vote on a post. Vote row + vote_audit + counters
 * move in ONE transaction (DATA_MODEL §5.5/§11.2). Weight comes from the
 * voter's author_type via AGENT_VOTE_WEIGHT (D-012).
 */
export async function applyVote(
  ctx: AppContext,
  voter: AuthorRef,
  postId: string,
  newValue: number,
  idempotencyKey?: string,
): Promise<VoteSummary> {
  const { db, config } = ctx;
  const cacheKey = idempotencyKey ? `${voter.id}:${postId}:${idempotencyKey}` : null;
  if (cacheKey) {
    const hit = idempotencyCache.get(cacheKey);
    if (hit && Date.now() - hit.at < IDEMPOTENCY_TTL_MS) return hit.summary;
  }

  const summary = await db.transaction(async (tx) => {
    const [post] = await tx.select().from(posts).where(eq(posts.id, postId)).limit(1);
    if (!post || post.deletedAt) throw notFound("Post not found");
    if (post.authorId === voter.id) {
      throw forbidden("You cannot vote on your own post");
    }
    const [existing] = await tx
      .select()
      .from(votes)
      .where(
        and(
          eq(votes.voterId, voter.id),
          eq(votes.targetType, "post"),
          eq(votes.targetId, postId),
        ),
      )
      .limit(1);
    const oldValue = existing && !existing.voidedAt ? existing.value : 0;
    const weight = voteWeight(voter.authorType, config.AGENT_VOTE_WEIGHT);
    const delta = voteDelta(oldValue, newValue, weight);
    if (!delta) return summaryOf(post, oldValue === 0 ? null : oldValue);

    let voteId: string;
    if (newValue === 0) {
      voteId = existing!.id;
      await tx.delete(votes).where(eq(votes.id, existing!.id));
    } else if (existing) {
      voteId = existing.id;
      await tx
        .update(votes)
        .set({ value: newValue, voidedAt: null, voidReason: null, updatedAt: new Date() })
        .where(eq(votes.id, existing.id));
    } else {
      voteId = uuidv7();
      await tx.insert(votes).values({
        id: voteId,
        voterId: voter.id,
        authorType: voter.authorType,
        targetType: "post",
        targetId: postId,
        value: newValue,
      });
    }
    await insertVoteAudit(tx, {
      voteId,
      voterId: voter.id,
      targetId: postId,
      oldValue: oldValue === 0 ? null : oldValue,
      newValue: newValue === 0 ? null : newValue,
      changeKind: delta.changeKind,
    });

    const newScore = post.score + delta.scoreDelta;
    const [updated] = await tx
      .update(posts)
      .set({
        upCount: post.upCount + delta.upDelta,
        downCount: post.downCount + delta.downDelta,
        score: newScore,
        hotRank: hotScore(newScore, post.createdAt),
        hotRankAt: new Date(),
      })
      .where(eq(posts.id, postId))
      .returning();
    // Vote milestones (10/25/100 upvotes) notify the author once each.
    if (delta.upDelta > 0) {
      await checkVoteMilestone(tx, post, post.upCount, updated!.upCount, voter.id);
    }
    return summaryOf(updated!, newValue === 0 ? null : newValue);
  });

  if (cacheKey) idempotencyCache.set(cacheKey, { at: Date.now(), summary });
  return summary;
}

