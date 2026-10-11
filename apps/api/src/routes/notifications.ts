/**
 * Notifications (API_SPEC: listNotifications, getUnreadCount,
 * markNotificationsRead) + the preferences surface (per-type toggles and
 * the quiet-hours / do-not-disturb window, stored on user_settings).
 */
import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { notifications, userSettings } from "../db/schema";
import { requireAuth } from "../lib/auth";
import { decodeCursor, encodeCursor } from "../lib/pagination";
import {
  notificationWire,
  pageEnvelope,
  type NotificationRow,
} from "../lib/serializers";
import { parseBody } from "../lib/validate";
import { dmUnreadCount } from "../services/conversations";
import { unreadNotificationCount } from "../services/notifications";
import { authorMap } from "../services/users";

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  unread_only: z.coerce.boolean().default(false),
  unreadOnly: z.coerce.boolean().optional(),
});

const readSchema = z.object({
  ids: z.array(z.string().uuid()).max(500).optional(),
  all_before: z.string().datetime().optional(),
  allBefore: z.string().datetime().optional(),
});

const NOTIFICATION_TYPES = [
  "reply",
  "mention",
  "follow",
  "vote_digest",
  "debate_challenge",
  "debate_turn",
  "poll_closing",
  "mod_action",
  "dm_request",
  "system",
] as const;

const quietHoursSchema = z
  .object({
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
  })
  .nullable();

const preferencesPatchSchema = z.object({
  notification_prefs: z.record(z.string(), z.boolean()).optional(),
  prefs: z.record(z.string(), z.boolean()).optional(),
  quiet_hours: quietHoursSchema.optional(),
  quietHours: quietHoursSchema.optional(),
});

type NotifCursor = { createdAt: string; id: string };

async function getOrCreateSettings(ctx: AppContext, userId: string) {
  const { db } = ctx;
  const [row] = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  if (row) return row;
  const [created] = await db
    .insert(userSettings)
    .values({ userId })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [again] = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  return again!;
}

export async function registerNotificationRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db } = ctx;

  app.get(
    "/api/v1/notifications",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const query = parseBody(listQuerySchema, request.query);
      const me = request.authUser!;
      const unreadOnly = query.unreadOnly ?? query.unread_only;
      const cursor = decodeCursor<NotifCursor>(query.cursor);
      const rows = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.recipientId, me.sub),
            unreadOnly ? isNull(notifications.readAt) : undefined,
            cursor
              ? or(
                  lt(notifications.createdAt, new Date(cursor.createdAt)),
                  and(
                    eq(notifications.createdAt, new Date(cursor.createdAt)),
                    lt(notifications.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(query.limit + 1);
      const pageRows: NotificationRow[] = rows.slice(0, query.limit);
      const last = pageRows[pageRows.length - 1];
      const actors = await authorMap(
        db,
        pageRows.map((r) => r.actorId).filter((id): id is string => id !== null),
      );
      const wires = pageRows.map((row) =>
        notificationWire(row, row.actorId ? (actors.get(row.actorId) ?? null) : null),
      );
      const envelope = pageEnvelope(
        wires,
        rows.length > query.limit && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
      );
      const unread = await unreadNotificationCount(db, me.sub);
      return { ...envelope, unread_count: unread };
    },
  );

  app.get(
    "/api/v1/notifications/unread-count",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const count = await unreadNotificationCount(db, request.authUser!.sub);
      // Phase 5A (D-053): additive dm_count — unread conversations
      // (muted excluded). `count` keeps its notifications-only meaning.
      const dmCount = await dmUnreadCount(db, request.authUser!.sub);
      return { count, dm_count: dmCount };
    },
  );

  app.post(
    "/api/v1/notifications/read",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      const body = parseBody(readSchema, request.body ?? {});
      const me = request.authUser!;
      const allBefore = body.all_before ?? body.allBefore;
      const now = new Date();
      if (body.ids && body.ids.length > 0) {
        await db
          .update(notifications)
          .set({ readAt: now })
          .where(
            and(
              eq(notifications.recipientId, me.sub),
              inArray(notifications.id, body.ids),
              isNull(notifications.readAt),
            ),
          );
      } else if (allBefore) {
        await db
          .update(notifications)
          .set({ readAt: now })
          .where(
            and(
              eq(notifications.recipientId, me.sub),
              isNull(notifications.readAt),
              lt(notifications.createdAt, new Date(allBefore)),
            ),
          );
      } else {
        // No ids and no cutoff = mark everything read (the spec's "all").
        await db
          .update(notifications)
          .set({ readAt: now })
          .where(
            and(
              eq(notifications.recipientId, me.sub),
              isNull(notifications.readAt),
            ),
          );
      }
      return reply.status(204).send();
    },
  );

  const prefsWire = (row: typeof userSettings.$inferSelect) => {
    const quiet = row.quietHours as { start: string; end: string } | null;
    return {
      notification_prefs: (row.notificationPrefs ?? {}) as Record<string, boolean>,
      quiet_hours:
        quiet && typeof quiet.start === "string" && typeof quiet.end === "string"
          ? { start: quiet.start, end: quiet.end }
          : null,
      types: [...NOTIFICATION_TYPES],
    };
  };

  app.get(
    "/api/v1/notifications/preferences",
    { preHandler: requireAuth(ctx) },
    async (request) => prefsWire(await getOrCreateSettings(ctx, request.authUser!.sub)),
  );

  app.patch(
    "/api/v1/notifications/preferences",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const body = parseBody(preferencesPatchSchema, request.body);
      const me = request.authUser!;
      const current = await getOrCreateSettings(ctx, me.sub);
      const patch: Partial<typeof userSettings.$inferInsert> = {};
      const prefs = body.notification_prefs ?? body.prefs;
      if (prefs !== undefined) {
        patch.notificationPrefs = {
          ...((current.notificationPrefs ?? {}) as Record<string, boolean>),
          ...prefs,
        };
      }
      const quiet = body.quiet_hours ?? body.quietHours;
      if (quiet !== undefined) patch.quietHours = quiet;
      if (Object.keys(patch).length > 0) {
        await db
          .update(userSettings)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(userSettings.userId, me.sub));
      }
      return prefsWire(await getOrCreateSettings(ctx, me.sub));
    },
  );
}
