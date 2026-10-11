/**
 * Notification generation (DATA_MODEL §10.1) — one home for every insert
 * into `notifications`, so preference gates and dedupe apply uniformly.
 *
 * Rules (Phase 1 round 2):
 * - Never notify a user about their own action.
 * - `user_settings.notification_prefs[type] === false` suppresses the type.
 * - Mentions additionally honor `mention_policy` (everyone | followers | none).
 * - Dedupe: an identical (recipient, actor, type, subject) event inside a
 *   1-hour window folds into the existing row — `group_count` bumps and the
 *   row re-surfaces (created_at moves to the latest event).
 * - Vote milestones are exempt from the window: each threshold fires once.
 */
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db";
import {
  follows,
  notifications,
  postMentions,
  userSettings,
  users,
} from "../db/schema";
import { uuidv7 } from "../lib/ids";
import { publishToUser } from "../lib/realtime";
import type { PostRow } from "../lib/serializers";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything that can run queries: the Db handle or a transaction. */
export type Executor = Db | Tx;

export type NotificationType = (typeof notifications.$inferInsert)["type"];

export interface NotifyInput {
  recipientId: string;
  type: NotificationType;
  actorId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  payload?: Record<string, unknown>;
}

const DEDUPE_WINDOW_MS = 60 * 60 * 1000;

export const VOTE_MILESTONES = [10, 25, 100] as const;

export function groupKeyOf(input: NotifyInput): string {
  return [
    input.type,
    input.actorId ?? "system",
    input.subjectType ?? "-",
    input.subjectId ?? "-",
  ].join(":");
}

/** Whether the recipient's settings allow this notification type from this actor. */
export async function notificationAllowed(
  exec: Executor,
  recipientId: string,
  type: NotificationType,
  actorId: string | null,
): Promise<boolean> {
  const [settings] = await exec
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, recipientId))
    .limit(1);
  if (!settings) return true;
  const prefs = (settings.notificationPrefs ?? {}) as Record<string, unknown>;
  if (prefs[type] === false) return false;
  if (type === "mention" && actorId) {
    if (settings.mentionPolicy === "none") return false;
    if (settings.mentionPolicy === "followers") {
      const [edge] = await exec
        .select()
        .from(follows)
        .where(
          and(
            eq(follows.followerId, actorId),
            eq(follows.followeeId, recipientId),
          ),
        )
        .limit(1);
      if (!edge) return false;
    }
  }
  return true;
}

/**
 * Insert a notification, folding repeats inside the dedupe window into the
 * existing row. Returns the row id, or null when suppressed (self-action or
 * recipient preference).
 */
export async function notify(
  exec: Executor,
  input: NotifyInput,
): Promise<string | null> {
  if (input.actorId && input.actorId === input.recipientId) return null;
  const allowed = await notificationAllowed(
    exec,
    input.recipientId,
    input.type,
    input.actorId ?? null,
  );
  if (!allowed) return null;

  if (input.actorId && input.subjectId) {
    const since = new Date(Date.now() - DEDUPE_WINDOW_MS);
    const [existing] = await exec
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientId, input.recipientId),
          eq(notifications.type, input.type),
          eq(notifications.actorId, input.actorId),
          eq(notifications.subjectId, input.subjectId),
          gt(notifications.createdAt, since),
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(1);
    if (existing) {
      await exec
        .update(notifications)
        .set({
          groupCount: existing.groupCount + 1,
          payload: input.payload ?? existing.payload,
          createdAt: new Date(),
          // A folded repeat of an already-read notification re-unreads it:
          // the newest event has not been seen.
          readAt: null,
        })
        .where(eq(notifications.id, existing.id));
      publishToUser(input.recipientId, { type: "notification.created" });
      return existing.id;
    }
  }

  const id = uuidv7();
  await exec.insert(notifications).values({
    id,
    recipientId: input.recipientId,
    type: input.type,
    actorId: input.actorId ?? null,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    groupKey: groupKeyOf(input),
    payload: input.payload ?? {},
  });
  // Phase 5A (D-048): realtime badge ping — the client refetches counts,
  // so a ping that escapes a later rollback self-heals on the next fetch.
  publishToUser(input.recipientId, { type: "notification.created" });
  return id;
}

const MENTION_RE = /@([a-z0-9_]{3,24})/gi;

/** Extract @handle mentions with their character offsets, in body order. */
export function parseMentions(body: string): Array<{ handle: string; position: number }> {
  const found: Array<{ handle: string; position: number }> = [];
  for (const match of body.matchAll(MENTION_RE)) {
    found.push({ handle: match[1]!.toLowerCase(), position: match.index ?? 0 });
  }
  return found;
}

/**
 * Persist post_mentions rows for a freshly created post and notify each
 * mentioned user once. `coveredRecipientIds` are users already receiving a
 * notification for this same post (the parent author gets a "reply", not a
 * duplicate "mention").
 */
export async function recordMentionsAndNotify(
  exec: Executor,
  post: PostRow,
  coveredRecipientIds: string[] = [],
): Promise<void> {
  if (!post.bodyMd) return;
  const mentions = parseMentions(post.bodyMd);
  if (mentions.length === 0) return;
  const handles = [...new Set(mentions.map((m) => m.handle))];
  const mentionedUsers = await exec
    .select()
    .from(users)
    .where(inArray(users.handle, handles));
  const byHandle = new Map(mentionedUsers.map((u) => [u.handle, u]));
  const covered = new Set(coveredRecipientIds);
  const excerpt = post.bodyMd.slice(0, 140);

  for (const mention of mentions) {
    const target = byHandle.get(mention.handle);
    if (!target || target.id === post.authorId || target.deletedAt) continue;
    await exec
      .insert(postMentions)
      .values({
        postId: post.id,
        mentionedUserId: target.id,
        position: mention.position,
      })
      .onConflictDoNothing();
  }

  const notified = new Set<string>();
  for (const mention of mentions) {
    const target = byHandle.get(mention.handle);
    if (!target || target.id === post.authorId || target.deletedAt) continue;
    if (covered.has(target.id) || notified.has(target.id)) continue;
    if (target.status === "deactivated" || target.status === "banned") continue;
    notified.add(target.id);
    await notify(exec, {
      recipientId: target.id,
      type: "mention",
      actorId: post.authorId,
      subjectType: "post",
      subjectId: post.id,
      payload: { rootId: post.rootId, parentId: post.parentId, excerpt },
    });
  }
}

/**
 * Vote milestones (10/25/100 upvotes): fire a `vote_digest` to the author
 * exactly once per threshold per post — checked against the notifications
 * table itself, so re-crossing a threshold after downvotes never re-fires.
 */
export async function checkVoteMilestone(
  exec: Executor,
  post: { id: string; authorId: string },
  oldUpCount: number,
  newUpCount: number,
  actorId: string,
): Promise<void> {
  for (const milestone of VOTE_MILESTONES) {
    if (oldUpCount >= milestone || newUpCount < milestone) continue;
    const [existing] = await exec
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientId, post.authorId),
          eq(notifications.type, "vote_digest"),
          eq(notifications.subjectId, post.id),
          sql`${notifications.payload} ->> 'milestone' = ${String(milestone)}`,
        ),
      )
      .limit(1);
    if (existing) continue;
    if (!(await notificationAllowed(exec, post.authorId, "vote_digest", actorId))) {
      continue;
    }
    await exec.insert(notifications).values({
      id: uuidv7(),
      recipientId: post.authorId,
      type: "vote_digest",
      actorId,
      subjectType: "post",
      subjectId: post.id,
      groupKey: `vote_digest:post:${post.id}:${milestone}`,
      payload: { milestone, up_count: newUpCount },
    });
  }
}

/** Unread count for one user (badge endpoint + list envelope). */
export async function unreadNotificationCount(
  exec: Executor,
  userId: string,
): Promise<number> {
  const [row] = await exec
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(eq(notifications.recipientId, userId), isNull(notifications.readAt)),
    );
  return row?.count ?? 0;
}
