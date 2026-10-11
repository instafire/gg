/**
 * Scheduled-post publisher (Phase 5A, D-050). Every minute the worker
 * claims due posts (scheduled_for <= now, not deleted) and publishes
 * them: clear the schedule, stamp published_at, then run the side
 * effects the API deferred at create time — community post counter and
 * mention records + notifications (mirroring the API's
 * recordMentionsAndNotify; the mention parser is duplicated here per
 * the worker's no-shared-code rule, D-034 precedent).
 */
import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { WorkerDb } from "./db";
import {
  communitiesTable,
  notificationsTable,
  postMentionsTable,
  postsTable,
  usersTable,
} from "./db";
import { uuidv7 } from "./opinion";

export interface DuePost {
  id: string;
  authorId: string | null;
  communityId: string | null;
  parentId: string | null;
  rootId: string | null;
  bodyMd: string | null;
}

export interface MentionTarget {
  id: string;
  handle: string;
  status: string;
  deletedAt: Date | null;
}

export interface ScheduledRepo {
  duePosts(now: Date, limit: number): Promise<DuePost[]>;
  /** Atomic claim: publish iff the post is still scheduled and due. */
  markPublished(postId: string, now: Date): Promise<boolean>;
  bumpCommunityPostCount(communityId: string): Promise<void>;
  usersByHandles(handles: string[]): Promise<MentionTarget[]>;
  insertMention(postId: string, userId: string, position: number): Promise<void>;
  notifyMention(recipientId: string, actorId: string, post: DuePost): Promise<void>;
}

const MENTION_RE = /@([a-z0-9_]{3,24})/gi;

/** Same extraction as the API's parseMentions (kept in sync by tests). */
export function parseMentions(body: string): Array<{ handle: string; position: number }> {
  const found: Array<{ handle: string; position: number }> = [];
  for (const match of body.matchAll(MENTION_RE)) {
    found.push({ handle: match[1]!.toLowerCase(), position: match.index ?? 0 });
  }
  return found;
}

export interface ScheduledPublishHooks {
  /** Fired once per notified mention (D-050: webhooks fire at publish). */
  onMention?: (post: DuePost, target: MentionTarget) => Promise<void>;
}

export async function publishDueScheduledPosts(
  repo: ScheduledRepo,
  now: Date,
  limit = 50,
  hooks?: ScheduledPublishHooks,
): Promise<{ published: number }> {
  const due = await repo.duePosts(now, limit);
  let published = 0;
  for (const post of due) {
    const claimed = await repo.markPublished(post.id, now);
    if (!claimed) continue;
    published += 1;
    if (post.communityId && !post.parentId) {
      await repo.bumpCommunityPostCount(post.communityId);
    }
    if (post.bodyMd && post.authorId) {
      const mentions = parseMentions(post.bodyMd);
      if (mentions.length > 0) {
        const handles = [...new Set(mentions.map((m) => m.handle))];
        const targets = await repo.usersByHandles(handles);
        const byHandle = new Map(targets.map((u) => [u.handle, u]));
        const notified = new Set<string>();
        for (const mention of mentions) {
          const target = byHandle.get(mention.handle);
          if (!target || target.id === post.authorId || target.deletedAt) continue;
          await repo.insertMention(post.id, target.id, mention.position);
          if (notified.has(target.id)) continue;
          if (target.status === "deactivated" || target.status === "banned") continue;
          notified.add(target.id);
          await repo.notifyMention(target.id, post.authorId, post);
          await hooks?.onMention?.(post, target).catch((error: Error) => {
            console.error("[gg-worker] scheduled mention webhook failed:", error.message);
          });
        }
      }
    }
  }
  return { published };
}

export function drizzleScheduledRepo(db: WorkerDb): ScheduledRepo {
  return {
    async duePosts(now, limit) {
      const rows = await db
        .select({
          id: postsTable.id,
          authorId: postsTable.authorId,
          communityId: postsTable.communityId,
          parentId: postsTable.parentId,
          rootId: postsTable.rootId,
          bodyMd: postsTable.bodyMd,
        })
        .from(postsTable)
        .where(
          and(
            isNotNull(postsTable.scheduledFor),
            lte(postsTable.scheduledFor, now),
            sql`${postsTable.deletedAt} is null`,
          ),
        )
        .orderBy(asc(postsTable.scheduledFor))
        .limit(limit);
      return rows;
    },
    async markPublished(postId, now) {
      const updated = await db
        .update(postsTable)
        .set({ scheduledFor: null, publishedAt: now, updatedAt: now })
        .where(
          and(
            eq(postsTable.id, postId),
            isNotNull(postsTable.scheduledFor),
            lte(postsTable.scheduledFor, now),
          ),
        )
        .returning({ id: postsTable.id });
      return updated.length > 0;
    },
    async bumpCommunityPostCount(communityId) {
      await db
        .update(communitiesTable)
        .set({ postCount: sql`${communitiesTable.postCount} + 1` })
        .where(eq(communitiesTable.id, communityId));
    },
    async usersByHandles(handles) {
      if (handles.length === 0) return [];
      const rows = await db
        .select({
          id: usersTable.id,
          handle: usersTable.handle,
          status: usersTable.status,
          deletedAt: usersTable.deletedAt,
        })
        .from(usersTable)
        .where(inArray(usersTable.handle, handles));
      return rows;
    },
    async insertMention(postId, userId, position) {
      await db
        .insert(postMentionsTable)
        .values({ postId, mentionedUserId: userId, position })
        .onConflictDoNothing();
    },
    async notifyMention(recipientId, actorId, post) {
      await db.insert(notificationsTable).values({
        id: uuidv7(),
        recipientId,
        type: "mention",
        actorId,
        subjectType: "post",
        subjectId: post.id,
        groupKey: `mention:${actorId}:post:${post.id}`,
        payload: {
          rootId: post.rootId,
          parentId: post.parentId,
          excerpt: (post.bodyMd ?? "").slice(0, 140),
        },
      });
    },
  };
}
