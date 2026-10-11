import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { AppConfig } from "../config";
import type { AppContext } from "../context";
import type { Db } from "../db";
import {
  debateParticipants,
  debateRounds,
  posts,
  users,
  webhookDeliveries,
  webhooks,
} from "../db/schema";
import { parseMentions } from "./notifications";
import type { PostRow } from "../lib/serializers";
import { generateWebhookSecret } from "../lib/api-keys";
import {
  decryptField,
  encryptField,
  encryptFieldIfKeyed,
  fieldEncryptionKey,
  isEncryptedField,
} from "../lib/secrets";
import { unprocessable } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { enqueueWebhookDelivery } from "../lib/queue";
import type { WebhookDeliveryRow, WebhookRow } from "../lib/serializers";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

/** The API_SPEC WebhookEvent enum (+ debate.challenge, Phase 4 delta D-042). */
export const WEBHOOK_EVENTS = [
  "mention.created",
  "reply.created",
  "debate.turn_due",
  "debate.closed",
  "debate.challenge",
  "poll.closed",
  "follow.created",
  "dm.received",
  "ping",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export function isWebhookEvent(value: string): value is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/**
 * Webhook URL policy (API_SPEC: "HTTPS only; SSRF-checked"). HTTPS is
 * required; plain HTTP is accepted only for loopback hosts and only
 * outside production, so local receivers can be developed/tested against
 * (D-042). Non-loopback private-range hosts are rejected outright.
 */
export function validateWebhookUrl(config: AppConfig, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw unprocessable("url is not a valid URI");
  }
  const host = url.hostname.toLowerCase();
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopback && config.NODE_ENV !== "production") {
    return url;
  }
  if (url.protocol === "http:" && isLoopback) {
    throw unprocessable("Loopback webhook URLs are only allowed outside production");
  }
  throw unprocessable("Webhook URL must use HTTPS");
}

export interface CreatedWebhook {
  row: WebhookRow;
  /** HMAC signing secret — returned exactly once. */
  secret: string;
}

export async function createWebhook(
  db: Db,
  config: AppConfig,
  input: { ownerId: string; url: string; events: string[] },
): Promise<CreatedWebhook> {
  const url = validateWebhookUrl(config, input.url);
  const secret = generateWebhookSecret();
  const [row] = await db
    .insert(webhooks)
    .values({
      id: uuidv7(),
      ownerId: input.ownerId,
      url: url.toString(),
      events: input.events,
      // Encrypted at rest when a field key is configured (D-065); the
      // plaintext secret is returned to the caller exactly once.
      secret: encryptFieldIfKeyed(fieldEncryptionKey(config), secret),
      isActive: true,
    })
    .returning();
  return { row: row!, secret };
}

/**
 * Backfill (D-065): rewrite legacy plaintext webhook secrets in their
 * encrypted form. Idempotent; a no-op when no key is configured. Called
 * at API boot and safe to call again — deliveries also decrypt legacy
 * rows transparently, so a missed row never breaks signing.
 */
export async function encryptLegacyWebhookSecrets(
  db: Db,
  config: AppConfig,
): Promise<number> {
  const key = fieldEncryptionKey(config);
  if (!key) return 0;
  const rows = await db.select().from(webhooks);
  let rewritten = 0;
  for (const row of rows) {
    const current = row.secret;
    if (isEncryptedField(current)) continue;
    const encrypted = encryptField(key, current);
    await db
      .update(webhooks)
      .set({ secret: encrypted, updatedAt: new Date() })
      .where(eq(webhooks.id, row.id));
    rewritten += 1;
  }
  return rewritten;
}

export async function listWebhooks(db: Db, ownerId: string): Promise<WebhookRow[]> {
  return db
    .select()
    .from(webhooks)
    .where(eq(webhooks.ownerId, ownerId))
    .orderBy(desc(webhooks.createdAt));
}

export async function getWebhook(db: Db, webhookId: string): Promise<WebhookRow | null> {
  const [row] = await db.select().from(webhooks).where(eq(webhooks.id, webhookId)).limit(1);
  return row ?? null;
}

export async function listDeliveries(
  db: Db,
  webhookId: string,
  limit: number,
  cursor: string | null,
): Promise<{ items: WebhookDeliveryRow[]; nextCursor: string | null }> {
  const rows = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.webhookId, webhookId))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(500);
  const start = cursor ? rows.findIndex((row) => row.id === cursor) + 1 : 0;
  const page = rows.slice(start, start + limit);
  return {
    items: page,
    nextCursor: start + limit < rows.length ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/**
 * Emit an event to every active webhook owned by `recipientUserId` that
 * subscribes to it. Delivery rows are written with the caller's executor
 * (so a rolled-back action emits nothing); the queue enqueue is
 * fire-and-forget — the worker's pending sweep is the backstop (D-042).
 */
export async function emitWebhookEvent(
  exec: Executor,
  config: AppConfig,
  recipientUserId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<void> {
  if (recipientUserId === "") return;
  const hooks = await exec
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.ownerId, recipientUserId), eq(webhooks.isActive, true)));
  const subscribed = hooks.filter((hook) =>
    ((hook.events as string[] | null) ?? []).includes(event),
  );
  if (subscribed.length === 0) return;
  const createdAt = new Date();
  for (const hook of subscribed) {
    const deliveryId = uuidv7();
    const payload = {
      id: deliveryId,
      event,
      created_at: createdAt.toISOString(),
      data,
    };
    await exec.insert(webhookDeliveries).values({
      id: deliveryId,
      webhookId: hook.id,
      event,
      payload,
      status: "pending",
      attempts: 0,
    });
    void enqueueWebhookDelivery(config, deliveryId);
  }
}

/** HMAC-SHA256 signature for a raw body, hex — the `sha256=` header value's payload. */
export function signWebhookPayload(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/** Verify a received signature header (`sha256=<hex>`) against a raw body. */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  header: string,
): boolean {
  const presented = header.startsWith("sha256=") ? header.slice("sha256=".length) : header;
  const expected = signWebhookPayload(secret, rawBody);
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type DeliveryOutcome =
  | "delivered"
  | "retry_scheduled"
  | "exhausted"
  | "failed"
  | "skipped";

/**
 * Perform ONE delivery attempt for a pending delivery row. This is the
 * API-side copy of the delivery engine; the worker runs its own copy
 * against the same rows (D-034 duplication precedent) — the copies must
 * agree on signature, headers, backoff and terminal states (D-042).
 */
export async function attemptWebhookDelivery(
  db: Db,
  config: AppConfig,
  deliveryId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryOutcome> {
  const [delivery] = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, deliveryId))
    .limit(1);
  if (!delivery || delivery.status !== "pending") return "skipped";
  const [hook] = await db
    .select()
    .from(webhooks)
    .where(eq(webhooks.id, delivery.webhookId))
    .limit(1);
  const now = new Date();
  if (!hook || !hook.isActive) {
    await db
      .update(webhookDeliveries)
      .set({ status: "failed", lastError: "Webhook deleted or inactive", updatedAt: now })
      .where(eq(webhookDeliveries.id, deliveryId));
    return "failed";
  }

  const rawBody = JSON.stringify(delivery.payload);
  // The stored secret is ciphertext when a field key is configured
  // (D-065); signing always uses the decrypted plaintext value.
  const signature = signWebhookPayload(
    decryptField(fieldEncryptionKey(config), hook.secret),
    rawBody,
  );
  const attempts = delivery.attempts + 1;
  let responseStatus: number | null = null;
  let errorMessage: string | null = null;
  try {
    const response = await fetchImpl(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "GG-Webhooks/1.0",
        "x-gg-event": delivery.event,
        "x-gg-delivery": delivery.id,
        "x-gg-signature": `sha256=${signature}`,
      },
      body: rawBody,
      signal: AbortSignal.timeout(config.WEBHOOK_TIMEOUT_MS),
    });
    responseStatus = response.status;
    if (response.status >= 200 && response.status < 300) {
      await db
        .update(webhookDeliveries)
        .set({
          status: "delivered",
          attempts,
          responseStatus,
          lastError: null,
          nextAttemptAt: null,
          updatedAt: now,
        })
        .where(eq(webhookDeliveries.id, deliveryId));
      if (hook.failureStreak !== 0) {
        await db
          .update(webhooks)
          .set({ failureStreak: 0, updatedAt: now })
          .where(eq(webhooks.id, hook.id));
      }
      return "delivered";
    }
    errorMessage = `HTTP ${response.status}`;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "Network error";
  }

  const retryable =
    responseStatus === null ||
    responseStatus === 408 ||
    responseStatus === 429 ||
    responseStatus >= 500;
  if (!retryable) {
    await db
      .update(webhookDeliveries)
      .set({ status: "failed", attempts, responseStatus, lastError: errorMessage, nextAttemptAt: null, updatedAt: now })
      .where(eq(webhookDeliveries.id, deliveryId));
    await db
      .update(webhooks)
      .set({ failureStreak: hook.failureStreak + 1, updatedAt: now })
      .where(eq(webhooks.id, hook.id));
    return "failed";
  }
  if (attempts >= config.WEBHOOK_MAX_ATTEMPTS) {
    await db
      .update(webhookDeliveries)
      .set({ status: "exhausted", attempts, responseStatus, lastError: errorMessage, nextAttemptAt: null, updatedAt: now })
      .where(eq(webhookDeliveries.id, deliveryId));
    await db
      .update(webhooks)
      .set({ failureStreak: hook.failureStreak + 1, updatedAt: now })
      .where(eq(webhooks.id, hook.id));
    return "exhausted";
  }
  const delayMs = config.WEBHOOK_RETRY_BASE_MS * 2 ** (attempts - 1);
  await db
    .update(webhookDeliveries)
    .set({
      status: "pending",
      attempts,
      responseStatus,
      lastError: errorMessage,
      nextAttemptAt: new Date(now.getTime() + delayMs),
      updatedAt: now,
    })
    .where(eq(webhookDeliveries.id, deliveryId));
  void enqueueWebhookDelivery(config, deliveryId, delayMs);
  return "retry_scheduled";
}

/** Queue a signed `ping` test delivery for one webhook (test endpoint). */
export async function queueTestDelivery(
  db: Db,
  config: AppConfig,
  hook: WebhookRow,
): Promise<string> {
  const deliveryId = uuidv7();
  await db.insert(webhookDeliveries).values({
    id: deliveryId,
    webhookId: hook.id,
    event: "ping",
    payload: {
      id: deliveryId,
      event: "ping",
      created_at: new Date().toISOString(),
      data: { test: true, webhook_id: hook.id },
    },
    status: "pending",
    attempts: 0,
  });
  void enqueueWebhookDelivery(config, deliveryId);
  return deliveryId;
}

// ─── Event emitters (called by route handlers after a successful write) ────

/**
 * Post-created events: `reply.created` to the parent author and
 * `mention.created` to each mentioned user (excluding the author and the
 * parent author, mirroring the notification rules in notifications.ts).
 * Best-effort: a webhook failure never fails the post request.
 */
export async function emitPostWebhooks(ctx: AppContext, post: PostRow): Promise<void> {
  try {
    let parentAuthorId: string | null = null;
    if (post.parentId) {
      const [parent] = await ctx.db
        .select()
        .from(posts)
        .where(eq(posts.id, post.parentId))
        .limit(1);
      parentAuthorId = parent?.authorId ?? null;
      if (parent && parent.authorId !== post.authorId) {
        await emitWebhookEvent(ctx.db, ctx.config, parent.authorId, "reply.created", {
          post_id: post.id,
          parent_post_id: parent.id,
          root_id: post.rootId,
          actor_id: post.authorId,
        });
      }
    }
    if (post.bodyMd) {
      const handles = [...new Set(parseMentions(post.bodyMd).map((m) => m.handle))];
      if (handles.length > 0) {
        const mentioned = await ctx.db
          .select()
          .from(users)
          .where(inArray(users.handle, handles));
        for (const target of mentioned) {
          if (target.id === post.authorId || target.id === parentAuthorId) continue;
          if (target.deletedAt) continue;
          await emitWebhookEvent(ctx.db, ctx.config, target.id, "mention.created", {
            post_id: post.id,
            actor_id: post.authorId,
            mentioned_user_id: target.id,
            mentioned_handle: target.handle,
            excerpt: post.bodyMd.slice(0, 140),
          });
        }
      }
    }
  } catch (error) {
    console.error(
      "[gg-api] emitPostWebhooks failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

/** Emit `debate.turn_due` to whoever holds the active turn, if anyone does. */
export async function emitDebateTurnDue(ctx: AppContext, debateId: string): Promise<void> {
  try {
    const rounds = await ctx.db
      .select()
      .from(debateRounds)
      .where(eq(debateRounds.debateId, debateId));
    const active = rounds.find((r) => r.status === "active" && r.turnUserId);
    if (!active?.turnUserId) return;
    await emitWebhookEvent(ctx.db, ctx.config, active.turnUserId, "debate.turn_due", {
      debate_id: debateId,
      round_no: active.roundNo,
      deadline_at: active.deadlineAt?.toISOString() ?? null,
    });
  } catch (error) {
    console.error(
      "[gg-api] emitDebateTurnDue failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

/** Emit `debate.closed` to the host and all participants (minus `excludeUserId`). */
export async function emitDebateClosed(
  ctx: AppContext,
  debate: { id: string; hostId: string },
  excludeUserId?: string,
): Promise<void> {
  try {
    const participants = await ctx.db
      .select()
      .from(debateParticipants)
      .where(eq(debateParticipants.debateId, debate.id));
    const recipients = new Set<string>([debate.hostId]);
    for (const p of participants) recipients.add(p.userId);
    if (excludeUserId) recipients.delete(excludeUserId);
    for (const recipientId of recipients) {
      await emitWebhookEvent(ctx.db, ctx.config, recipientId, "debate.closed", {
        debate_id: debate.id,
      });
    }
  } catch (error) {
    console.error(
      "[gg-api] emitDebateClosed failed:",
      error instanceof Error ? error.message : error,
    );
  }
}
