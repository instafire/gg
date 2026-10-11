/**
 * Worker-side webhook delivery (Phase 4, D-042). The worker owns the
 * `gg-webhooks` queue in production: the API inserts `webhook_deliveries`
 * rows and enqueues best-effort; this module attempts delivery with the
 * exact semantics of the API-side copy (signature, headers, retry policy,
 * terminal states — the D-034 duplication precedent; the two copies MUST
 * agree). A periodic sweep re-enqueues pending rows past their
 * `next_attempt_at`, so a lost enqueue or a down worker self-heals.
 *
 * Worker-originated events: poll auto-close (poll.closed) and debate turn
 * expiry (debate.turn_due / debate.closed) are emitted from here via the
 * opinion sweep hooks in index.ts.
 */
import { createHmac, randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import type { WorkerDb } from "./db";
import { decryptField } from "./secrets";
import {
  debatesTable,
  debateParticipantsTable,
  debateRoundsTable,
  pollsTable,
  postsTable,
  webhookDeliveriesTable,
  webhooksTable,
} from "./db";

export const WEBHOOK_QUEUE_NAME = "gg-webhooks";
export const WEBHOOK_DELIVER_JOB = "webhook.deliver";
export const WEBHOOK_SWEEP_JOB = "webhook.sweep";

export interface WebhookKnobs {
  maxAttempts: number;
  retryBaseMs: number;
  timeoutMs: number;
}

export function webhookKnobsFromEnv(env: NodeJS.ProcessEnv = process.env): WebhookKnobs {
  const int = (value: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    maxAttempts: int(env.WEBHOOK_MAX_ATTEMPTS, 5),
    retryBaseMs: int(env.WEBHOOK_RETRY_BASE_MS, 30_000),
    timeoutMs: int(env.WEBHOOK_TIMEOUT_MS, 10_000),
  };
}

/** HMAC-SHA256 hex over the exact raw body — identical to the API copy. */
export function signWebhookPayload(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

// ─── Repo seam (unit tests drive a fake; production uses drizzle) ────────────

export interface WebhookRow {
  id: string;
  ownerId: string;
  url: string;
  events: unknown;
  secret: string;
  isActive: boolean;
  failureStreak: number;
}

export interface WebhookDeliveryRow {
  id: string;
  webhookId: string;
  event: string;
  payload: unknown;
  status: string;
  attempts: number;
}

export interface WebhookRepo {
  deliveryById(id: string): Promise<WebhookDeliveryRow | null>;
  webhookById(id: string): Promise<WebhookRow | null>;
  updateDelivery(id: string, patch: Record<string, unknown>): Promise<void>;
  setFailureStreak(webhookId: string, streak: number): Promise<void>;
  insertDelivery(row: {
    id: string;
    webhookId: string;
    event: string;
    payload: unknown;
  }): Promise<void>;
  hooksForRecipient(recipientUserId: string, event: string): Promise<WebhookRow[]>;
  duePendingIds(now: Date, limit: number): Promise<string[]>;
  postAuthorId(postId: string): Promise<string | null>;
  pollById(pollId: string): Promise<{ id: string; postId: string; question: string } | null>;
  debateState(debateId: string): Promise<{
    status: string;
    hostId: string;
    participantIds: string[];
    activeTurnUserId: string | null;
    activeRoundNo: number | null;
  } | null>;
}

export function drizzleWebhookRepo(db: WorkerDb): WebhookRepo {
  return {
    async deliveryById(id) {
      const [row] = await db
        .select()
        .from(webhookDeliveriesTable)
        .where(eq(webhookDeliveriesTable.id, id))
        .limit(1);
      return (row as WebhookDeliveryRow | undefined) ?? null;
    },
    async webhookById(id) {
      const [row] = await db
        .select()
        .from(webhooksTable)
        .where(eq(webhooksTable.id, id))
        .limit(1);
      return (row as WebhookRow | undefined) ?? null;
    },
    async updateDelivery(id, patch) {
      await db
        .update(webhookDeliveriesTable)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(webhookDeliveriesTable.id, id));
    },
    async setFailureStreak(webhookId, streak) {
      await db
        .update(webhooksTable)
        .set({ failureStreak: streak, updatedAt: new Date() })
        .where(eq(webhooksTable.id, webhookId));
    },
    async insertDelivery(row) {
      const now = new Date();
      await db.insert(webhookDeliveriesTable).values({
        id: row.id,
        webhookId: row.webhookId,
        event: row.event,
        payload: row.payload,
        status: "pending",
        attempts: 0,
        responseStatus: null,
        lastError: null,
        nextAttemptAt: null,
        createdAt: now,
        updatedAt: now,
      });
    },
    async hooksForRecipient(recipientUserId, event) {
      const rows = await db
        .select()
        .from(webhooksTable)
        .where(
          and(eq(webhooksTable.ownerId, recipientUserId), eq(webhooksTable.isActive, true)),
        );
      return (rows as WebhookRow[]).filter((hook) => {
        const events = Array.isArray(hook.events) ? (hook.events as string[]) : [];
        return events.includes(event);
      });
    },
    async duePendingIds(now, limit) {
      const rows = await db
        .select({ id: webhookDeliveriesTable.id })
        .from(webhookDeliveriesTable)
        .where(
          and(
            eq(webhookDeliveriesTable.status, "pending"),
            or(
              isNull(webhookDeliveriesTable.nextAttemptAt),
              lte(webhookDeliveriesTable.nextAttemptAt, now),
            ),
          ),
        )
        .orderBy(asc(webhookDeliveriesTable.createdAt))
        .limit(limit);
      return rows.map((r) => r.id);
    },
    async postAuthorId(postId) {
      const [row] = await db
        .select({ authorId: postsTable.authorId })
        .from(postsTable)
        .where(eq(postsTable.id, postId))
        .limit(1);
      return row?.authorId ?? null;
    },
    async pollById(pollId) {
      const [row] = await db
        .select({
          id: pollsTable.id,
          postId: pollsTable.postId,
          question: pollsTable.question,
        })
        .from(pollsTable)
        .where(eq(pollsTable.id, pollId))
        .limit(1);
      return row ?? null;
    },
    async debateState(debateId) {
      const [debate] = await db
        .select({ status: debatesTable.status, hostId: debatesTable.hostId })
        .from(debatesTable)
        .where(eq(debatesTable.id, debateId))
        .limit(1);
      if (!debate) return null;
      const participants = await db
        .select({ userId: debateParticipantsTable.userId })
        .from(debateParticipantsTable)
        .where(eq(debateParticipantsTable.debateId, debateId));
      const rounds = await db
        .select({
          roundNo: debateRoundsTable.roundNo,
          turnUserId: debateRoundsTable.turnUserId,
          status: debateRoundsTable.status,
        })
        .from(debateRoundsTable)
        .where(eq(debateRoundsTable.debateId, debateId));
      const active = rounds
        .filter((r) => r.status === "active")
        .sort((a, b) => a.roundNo - b.roundNo)[0];
      return {
        status: debate.status,
        hostId: debate.hostId,
        participantIds: participants.map((p) => p.userId),
        activeTurnUserId: active?.turnUserId ?? null,
        activeRoundNo: active?.roundNo ?? null,
      };
    },
  };
}

// ─── Delivery engine (mirror of the API copy — keep in lockstep, D-042) ─────

export type DeliveryOutcome =
  | "delivered"
  | "retry_scheduled"
  | "exhausted"
  | "failed"
  | "skipped";

export interface DeliveryDeps {
  knobs: WebhookKnobs;
  enqueueDelivery: (deliveryId: string, delayMs: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /**
   * Field-encryption key for webhook secrets at rest (D-065). When a
   * hook's stored secret is `enc:v1:…`, it is decrypted before signing;
   * legacy plaintext passes through. Null = no key configured.
   */
  encryptionKey?: Buffer | null;
}

export async function runWebhookDelivery(
  repo: WebhookRepo,
  deliveryId: string,
  deps: DeliveryDeps,
): Promise<DeliveryOutcome> {
  const delivery = await repo.deliveryById(deliveryId);
  if (!delivery || delivery.status !== "pending") return "skipped";
  const hook = await repo.webhookById(delivery.webhookId);
  const now = (deps.now ?? (() => new Date()))();
  if (!hook || !hook.isActive) {
    await repo.updateDelivery(deliveryId, {
      status: "failed",
      lastError: "Webhook deleted or inactive",
    });
    return "failed";
  }

  const rawBody = JSON.stringify(delivery.payload);
  const signature = signWebhookPayload(
    decryptField(deps.encryptionKey ?? null, hook.secret),
    rawBody,
  );
  const attempts = delivery.attempts + 1;
  let responseStatus: number | null = null;
  let errorMessage: string | null = null;
  try {
    const response = await (deps.fetchImpl ?? fetch)(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "GG-Webhooks/1.0",
        "x-gg-event": delivery.event,
        "x-gg-delivery": delivery.id,
        "x-gg-signature": `sha256=${signature}`,
      },
      body: rawBody,
      signal: AbortSignal.timeout(deps.knobs.timeoutMs),
    });
    responseStatus = response.status;
    if (response.status >= 200 && response.status < 300) {
      await repo.updateDelivery(deliveryId, {
        status: "delivered",
        attempts,
        responseStatus,
        lastError: null,
        nextAttemptAt: null,
      });
      if (hook.failureStreak !== 0) {
        await repo.setFailureStreak(hook.id, 0);
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
    await repo.updateDelivery(deliveryId, {
      status: "failed",
      attempts,
      responseStatus,
      lastError: errorMessage,
      nextAttemptAt: null,
    });
    await repo.setFailureStreak(hook.id, hook.failureStreak + 1);
    return "failed";
  }
  if (attempts >= deps.knobs.maxAttempts) {
    await repo.updateDelivery(deliveryId, {
      status: "exhausted",
      attempts,
      responseStatus,
      lastError: errorMessage,
      nextAttemptAt: null,
    });
    await repo.setFailureStreak(hook.id, hook.failureStreak + 1);
    return "exhausted";
  }
  const delayMs = deps.knobs.retryBaseMs * 2 ** (attempts - 1);
  await repo.updateDelivery(deliveryId, {
    status: "pending",
    attempts,
    responseStatus,
    lastError: errorMessage,
    nextAttemptAt: new Date(now.getTime() + delayMs),
  });
  await deps.enqueueDelivery(deliveryId, delayMs).catch((error: Error) => {
    // The sweep is the backstop — a lost enqueue self-heals within a minute.
    console.error("[gg-worker] webhook enqueue failed:", error.message);
  });
  return "retry_scheduled";
}

// ─── Emitters (worker-originated events) ─────────────────────────────────────

async function emit(
  repo: WebhookRepo,
  enqueueDelivery: DeliveryDeps["enqueueDelivery"],
  recipientUserId: string,
  event: string,
  data: Record<string, unknown>,
): Promise<number> {
  const hooks = await repo.hooksForRecipient(recipientUserId, event);
  let created = 0;
  for (const hook of hooks) {
    const deliveryId = randomUUID();
    await repo.insertDelivery({
      id: deliveryId,
      webhookId: hook.id,
      event,
      payload: {
        id: deliveryId,
        event,
        created_at: new Date().toISOString(),
        data,
      },
    });
    created += 1;
    await enqueueDelivery(deliveryId, 0).catch((error: Error) => {
      console.error("[gg-worker] webhook enqueue failed:", error.message);
    });
  }
  return created;
}

/**
 * mention.created for a mention that landed when a scheduled post was
 * published by the sweep (recipient: the mentioned user). Payload shape
 * matches the API's emitPostWebhooks mention payload exactly.
 */
export async function emitMentionCreated(
  repo: WebhookRepo,
  enqueueDelivery: DeliveryDeps["enqueueDelivery"],
  recipientId: string,
  data: {
    post_id: string;
    actor_id: string;
    mentioned_user_id: string;
    mentioned_handle: string;
    excerpt: string;
  },
): Promise<number> {
  return emit(repo, enqueueDelivery, recipientId, "mention.created", { ...data });
}

/** poll.closed for a poll the sweep just closed (recipient: host author). */
export async function emitPollClosed(
  repo: WebhookRepo,
  enqueueDelivery: DeliveryDeps["enqueueDelivery"],
  pollId: string,
): Promise<number> {
  const poll = await repo.pollById(pollId);
  if (!poll) return 0;
  const authorId = await repo.postAuthorId(poll.postId);
  if (!authorId) return 0;
  return emit(repo, enqueueDelivery, authorId, "poll.closed", {
    poll_id: poll.id,
    post_id: poll.postId,
    question: poll.question,
  });
}

/**
 * After a turn-expiry pass touched a debate: if it closed, emit
 * debate.closed to host + participants; otherwise, if a round is active,
 * emit debate.turn_due to its holder (their turn became due because the
 * previous holder's expired).
 */
export async function emitDebateTurnState(
  repo: WebhookRepo,
  enqueueDelivery: DeliveryDeps["enqueueDelivery"],
  debateId: string,
): Promise<number> {
  const state = await repo.debateState(debateId);
  if (!state) return 0;
  if (state.status === "closed" || state.status === "archived") {
    const recipients = new Set<string>([state.hostId, ...state.participantIds]);
    let created = 0;
    for (const recipient of recipients) {
      created += await emit(repo, enqueueDelivery, recipient, "debate.closed", {
        debate_id: debateId,
      });
    }
    return created;
  }
  if (state.activeTurnUserId) {
    return emit(repo, enqueueDelivery, state.activeTurnUserId, "debate.turn_due", {
      debate_id: debateId,
      round_no: state.activeRoundNo,
      turn_user_id: state.activeTurnUserId,
    });
  }
  return 0;
}

/** Re-enqueue every due pending delivery (the self-healing backstop). */
export async function sweepPendingDeliveries(
  repo: WebhookRepo,
  enqueueDelivery: DeliveryDeps["enqueueDelivery"],
  now: Date = new Date(),
  limit = 200,
): Promise<number> {
  const ids = await repo.duePendingIds(now, limit);
  for (const id of ids) {
    await enqueueDelivery(id, 0).catch((error: Error) => {
      console.error("[gg-worker] webhook sweep enqueue failed:", error.message);
    });
  }
  return ids.length;
}
