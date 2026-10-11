/**
 * Web Push subscriptions (Phase 5B, API_SPEC listPushSubscriptions /
 * createPushSubscription / deletePushSubscription / getVapidPublicKey).
 *
 * The API only stores subscriptions; the worker sends (services there
 * own the VAPID private key — it is never served or logged here beyond
 * the public half, which is public by design).
 */
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { pushSubscriptions } from "../db/schema";
import { requireAuth } from "../lib/auth";
import { notFound } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { parseBody } from "../lib/validate";

const createSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
});

type SubscriptionRow = typeof pushSubscriptions.$inferSelect;

function subscriptionWire(row: SubscriptionRow) {
  return {
    id: row.id,
    endpoint: row.endpoint,
    user_agent: row.userAgent,
    created_at: row.createdAt.toISOString(),
  };
}

export async function registerPushRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db } = ctx;

  // The VAPID public key is configuration, not a secret.
  app.get("/api/v1/push/vapid-public-key", async () => {
    return { public_key: ctx.config.VAPID_PUBLIC_KEY ?? null };
  });

  app.get(
    "/api/v1/me/push-subscriptions",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const me = request.authUser!;
      const rows = await db
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, me.sub))
        .orderBy(desc(pushSubscriptions.createdAt));
      return { data: rows.map(subscriptionWire) };
    },
  );

  app.post(
    "/api/v1/me/push-subscriptions",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      const body = parseBody(createSchema, request.body);
      const me = request.authUser!;
      const userAgent =
        typeof request.headers["user-agent"] === "string"
          ? request.headers["user-agent"].slice(0, 300)
          : null;
      // Upsert by endpoint: re-subscribing (possibly by a new owner of
      // the browser profile) refreshes keys + ownership.
      const [row] = await db
        .insert(pushSubscriptions)
        .values({
          id: uuidv7(),
          userId: me.sub,
          endpoint: body.endpoint,
          p256dh: body.keys.p256dh,
          auth: body.keys.auth,
          userAgent,
        })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: {
            userId: me.sub,
            p256dh: body.keys.p256dh,
            auth: body.keys.auth,
            userAgent,
            updatedAt: new Date(),
          },
        })
        .returning();
      return reply.status(201).send(subscriptionWire(row!));
    },
  );

  app.delete(
    "/api/v1/me/push-subscriptions/:subscriptionId",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      const { subscriptionId } = request.params as { subscriptionId: string };
      const me = request.authUser!;
      const deleted = await db
        .delete(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.id, subscriptionId),
            eq(pushSubscriptions.userId, me.sub),
          ),
        )
        .returning({ id: pushSubscriptions.id });
      if (deleted.length === 0) throw notFound("Push subscription not found");
      return reply.status(204).send();
    },
  );
}
