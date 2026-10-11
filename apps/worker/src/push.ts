/**
 * Web Push fan-out (Phase 5B) — queue `gg-notify`, job `push.sweep`.
 *
 * Every 30 s the sweep scans notifications from the last 15 minutes whose
 * recipient has push subscriptions, and attempts delivery per
 * (notification, subscription) pair that has no push_deliveries row yet.
 * Every outcome is recorded — sent / failed / gone (subscription deleted)
 * / skipped_pref / skipped_quiet_hours — so the delivery record is
 * complete and honest. A pair is attempted once: quiet-hours skips are
 * final for that notification (the in-app notification still exists;
 * push is best-effort, D-062).
 *
 * Gates, in order: notification_prefs[type] === false (the in-app pref —
 * though notify() already suppresses those rows, defense in depth) →
 * push_prefs[type] === false → quiet hours (America/Toronto, the
 * platform timezone; user_settings carries no per-user tz).
 */
import { and, eq, gte, sql } from "drizzle-orm";
import webpush from "web-push";
import type { WorkerDb } from "./db";
import {
  notificationsTable,
  pushDeliveriesTable,
  pushSubscriptionsTable,
  userSettingsTable,
  usersTable,
} from "./db";

export const NOTIFY_QUEUE_NAME = "gg-notify";
export const PUSH_SWEEP_JOB = "push.sweep";

export interface PushSubscriptionRow {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface NotificationRow {
  id: string;
  recipientId: string;
  type: string;
  actorId: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface PushRepo {
  listCandidateNotifications(since: Date, limit: number): Promise<NotificationRow[]>;
  getSubscriptions(userId: string): Promise<PushSubscriptionRow[]>;
  getSettings(
    userId: string,
  ): Promise<{
    notificationPrefs: Record<string, unknown>;
    pushPrefs: Record<string, unknown>;
    quietHours: { start: string; end: string } | null;
  } | null>;
  getHandle(userId: string): Promise<string | null>;
  listDeliveredPairs(notificationIds: string[]): Promise<Set<string>>;
  recordDelivery(row: {
    notificationId: string;
    subscriptionId: string;
    userId: string;
    status: string;
    responseStatus?: number | null;
    error?: string | null;
  }): Promise<void>;
  deleteSubscription(id: string): Promise<void>;
}

export function drizzlePushRepo(db: WorkerDb): PushRepo {
  return {
    async listCandidateNotifications(since, limit) {
      const rows = await db
        .select({
          id: notificationsTable.id,
          recipientId: notificationsTable.recipientId,
          type: notificationsTable.type,
          actorId: notificationsTable.actorId,
          payload: notificationsTable.payload,
          createdAt: notificationsTable.createdAt,
        })
        .from(notificationsTable)
        .where(
          and(
            gte(notificationsTable.createdAt, since),
            sql`exists (select 1 from push_subscriptions s where s.user_id = ${notificationsTable.recipientId})`,
          ),
        )
        .orderBy(notificationsTable.createdAt)
        .limit(limit);
      return rows.map((r) => ({
        ...r,
        payload: (r.payload ?? {}) as Record<string, unknown>,
      }));
    },
    async getSubscriptions(userId) {
      return db
        .select({
          id: pushSubscriptionsTable.id,
          userId: pushSubscriptionsTable.userId,
          endpoint: pushSubscriptionsTable.endpoint,
          p256dh: pushSubscriptionsTable.p256dh,
          auth: pushSubscriptionsTable.auth,
        })
        .from(pushSubscriptionsTable)
        .where(eq(pushSubscriptionsTable.userId, userId));
    },
    async getSettings(userId) {
      const [row] = await db
        .select()
        .from(userSettingsTable)
        .where(eq(userSettingsTable.userId, userId))
        .limit(1);
      if (!row) return null;
      const quiet = row.quietHours as { start?: unknown; end?: unknown } | null;
      return {
        notificationPrefs: (row.notificationPrefs ?? {}) as Record<string, unknown>,
        pushPrefs: (row.pushPrefs ?? {}) as Record<string, unknown>,
        quietHours:
          quiet && typeof quiet.start === "string" && typeof quiet.end === "string"
            ? { start: quiet.start, end: quiet.end }
            : null,
      };
    },
    async getHandle(userId) {
      const [row] = await db
        .select({ handle: usersTable.handle })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);
      return row?.handle ?? null;
    },
    async listDeliveredPairs(notificationIds) {
      if (notificationIds.length === 0) return new Set();
      const rows = await db
        .select({
          notificationId: pushDeliveriesTable.notificationId,
          subscriptionId: pushDeliveriesTable.subscriptionId,
        })
        .from(pushDeliveriesTable)
        .where(
          sql`${pushDeliveriesTable.notificationId} in (${sql.join(
            notificationIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
        );
      return new Set(
        rows.map((r) => `${r.notificationId}:${r.subscriptionId}`),
      );
    },
    async recordDelivery(row) {
      await db
        .insert(pushDeliveriesTable)
        .values({
          id: crypto.randomUUID(),
          notificationId: row.notificationId,
          subscriptionId: row.subscriptionId,
          userId: row.userId,
          status: row.status,
          responseStatus: row.responseStatus ?? null,
          error: row.error ?? null,
        })
        .onConflictDoNothing();
    },
    async deleteSubscription(id) {
      await db
        .delete(pushSubscriptionsTable)
        .where(eq(pushSubscriptionsTable.id, id));
    },
  };
}

const TYPE_TITLES: Record<string, string> = {
  reply: "New reply",
  mention: "New mention",
  follow: "New follower",
  vote_digest: "Your post is moving",
  debate_challenge: "Debate challenge",
  debate_turn: "Your turn to argue",
  poll_closing: "Poll closing soon",
  mod_action: "Moderation update",
  dm_request: "Message request",
  system: "GG",
};

export function buildPushPayload(
  notification: NotificationRow,
  actorHandle: string | null,
  appBaseUrl: string,
): string {
  const title = TYPE_TITLES[notification.type] ?? "GG";
  const who = actorHandle ? `@${actorHandle} · ` : "";
  const excerpt =
    typeof notification.payload.excerpt === "string"
      ? notification.payload.excerpt
      : typeof notification.payload.action === "string"
        ? `Action: ${notification.payload.action}`
        : "Open GG to see what happened.";
  const url =
    notification.type === "dm_request"
      ? `${appBaseUrl}/messages`
      : `${appBaseUrl}/notifications`;
  return JSON.stringify({ title, body: `${who}${excerpt}`, url });
}

function parseHHMM(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Minutes since midnight in America/Toronto for an instant. */
export function torontoMinutesOfDay(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

export function isQuietHours(
  quiet: { start: string; end: string } | null,
  now: Date,
): boolean {
  if (!quiet) return false;
  const start = parseHHMM(quiet.start);
  const end = parseHHMM(quiet.end);
  if (start === end) return false;
  const current = torontoMinutesOfDay(now);
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

export type PushSender = (
  subscription: PushSubscriptionRow,
  payload: string,
) => Promise<{ statusCode: number }>;

export function createWebPushSender(vapid: {
  publicKey: string;
  privateKey: string;
  subject: string;
}): PushSender {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  return async (subscription, payload) => {
    try {
      const result = await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        payload,
      );
      return { statusCode: result.statusCode };
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (typeof statusCode === "number") return { statusCode };
      throw error;
    }
  };
}

export interface PushSweepResult {
  sent: number;
  failed: number;
  skipped: number;
  gone: number;
  candidates: number;
}

export async function runPushSweep(
  repo: PushRepo,
  sender: PushSender,
  opts: { now: Date; windowMinutes?: number; appBaseUrl: string; limit?: number },
): Promise<PushSweepResult> {
  const since = new Date(opts.now.getTime() - (opts.windowMinutes ?? 15) * 60_000);
  const notifications = await repo.listCandidateNotifications(since, opts.limit ?? 200);
  const delivered = await repo.listDeliveredPairs(notifications.map((n) => n.id));
  const result: PushSweepResult = {
    sent: 0,
    failed: 0,
    skipped: 0,
    gone: 0,
    candidates: notifications.length,
  };
  const settingsCache = new Map<string, Awaited<ReturnType<PushRepo["getSettings"]>>>();
  const subsCache = new Map<string, PushSubscriptionRow[]>();
  const handleCache = new Map<string, string | null>();

  for (const notification of notifications) {
    const userId = notification.recipientId;
    if (!subsCache.has(userId)) {
      subsCache.set(userId, await repo.getSubscriptions(userId));
    }
    const subscriptions = subsCache.get(userId)!;
    if (subscriptions.length === 0) continue;
    if (!settingsCache.has(userId)) {
      settingsCache.set(userId, await repo.getSettings(userId));
    }
    const settings = settingsCache.get(userId);
    const prefsOff =
      settings?.notificationPrefs[notification.type] === false ||
      settings?.pushPrefs[notification.type] === false;
    const quiet = isQuietHours(settings?.quietHours ?? null, opts.now);

    let payload: string | null = null;
    for (const subscription of subscriptions) {
      const pairKey = `${notification.id}:${subscription.id}`;
      if (delivered.has(pairKey)) continue;
      if (prefsOff) {
        await repo.recordDelivery({
          notificationId: notification.id,
          subscriptionId: subscription.id,
          userId,
          status: "skipped_pref",
        });
        result.skipped += 1;
        continue;
      }
      if (quiet) {
        await repo.recordDelivery({
          notificationId: notification.id,
          subscriptionId: subscription.id,
          userId,
          status: "skipped_quiet_hours",
        });
        result.skipped += 1;
        continue;
      }
      if (!payload) {
        let actorHandle: string | null = null;
        if (notification.actorId) {
          if (!handleCache.has(notification.actorId)) {
            handleCache.set(
              notification.actorId,
              await repo.getHandle(notification.actorId),
            );
          }
          actorHandle = handleCache.get(notification.actorId) ?? null;
        }
        payload = buildPushPayload(notification, actorHandle, opts.appBaseUrl);
      }
      try {
        const { statusCode } = await sender(subscription, payload);
        if (statusCode === 404 || statusCode === 410) {
          await repo.recordDelivery({
            notificationId: notification.id,
            subscriptionId: subscription.id,
            userId,
            status: "gone",
            responseStatus: statusCode,
          });
          await repo.deleteSubscription(subscription.id);
          result.gone += 1;
        } else if (statusCode >= 200 && statusCode < 300) {
          await repo.recordDelivery({
            notificationId: notification.id,
            subscriptionId: subscription.id,
            userId,
            status: "sent",
            responseStatus: statusCode,
          });
          result.sent += 1;
        } else {
          await repo.recordDelivery({
            notificationId: notification.id,
            subscriptionId: subscription.id,
            userId,
            status: "failed",
            responseStatus: statusCode,
          });
          result.failed += 1;
        }
      } catch (error) {
        await repo.recordDelivery({
          notificationId: notification.id,
          subscriptionId: subscription.id,
          userId,
          status: "failed",
          error: error instanceof Error ? error.message.slice(0, 300) : String(error),
        });
        result.failed += 1;
      }
    }
  }
  return result;
}
