/**
 * Media processing queue (BullMQ, ARCHITECTURE §10). The API only ever
 * enqueues; apps/worker consumes. Enqueue failures never fail the upload
 * request — the media row stays in `processing` and the error is logged
 * (a stuck row is visible in the DB; a lost 202 would not be).
 */
import { Queue } from "bullmq";
import IORedis from "ioredis";
import type { AppConfig } from "../config";

export const MEDIA_QUEUE_NAME = "gg-media";
export const MEDIA_PROCESS_JOB = "media.process";
export const WEBHOOK_QUEUE_NAME = "gg-webhooks";
export const WEBHOOK_DELIVER_JOB = "webhook.deliver";
/** Phase 5B: semantic-search embedding jobs (worker, D-060). */
export const EMBED_QUEUE_NAME = "gg-embed";
export const EMBED_POST_JOB = "post.embed";

let cached: { redisUrl: string; queue: Queue } | null = null;

function getQueue(config: AppConfig): Queue {
  if (!cached || cached.redisUrl !== config.REDIS_URL) {
    const connection = new IORedis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    connection.on("error", (error: Error) => {
      console.error("[gg-api] media queue redis error:", error.message);
    });
    cached = {
      redisUrl: config.REDIS_URL,
      queue: new Queue(MEDIA_QUEUE_NAME, { connection }),
    };
    cached.queue.on("error", (error: Error) => {
      console.error("[gg-api] media queue error:", error.message);
    });
  }
  return cached.queue;
}

let webhookCached: { redisUrl: string; queue: Queue } | null = null;

function getWebhookQueue(config: AppConfig): Queue {
  if (!webhookCached || webhookCached.redisUrl !== config.REDIS_URL) {
    const connection = new IORedis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    connection.on("error", (error: Error) => {
      console.error("[gg-api] webhook queue redis error:", error.message);
    });
    webhookCached = {
      redisUrl: config.REDIS_URL,
      queue: new Queue(WEBHOOK_QUEUE_NAME, { connection }),
    };
    webhookCached.queue.on("error", (error: Error) => {
      console.error("[gg-api] webhook queue error:", error.message);
    });
  }
  return webhookCached.queue;
}

/**
 * Enqueue one webhook delivery attempt. Best-effort like media: a lost
 * enqueue is recovered by the worker's pending-delivery sweep (D-042),
 * which re-enqueues anything pending past its next_attempt_at.
 */
export async function enqueueWebhookDelivery(
  config: AppConfig,
  deliveryId: string,
  delayMs = 0,
): Promise<void> {
  try {
    await getWebhookQueue(config).add(
      WEBHOOK_DELIVER_JOB,
      { deliveryId },
      {
        jobId: `webhook-${deliveryId}-${Date.now()}`,
        delay: Math.max(0, delayMs),
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
  } catch (error) {
    console.error(
      `[gg-api] failed to enqueue webhook delivery ${deliveryId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

let embedCached: { redisUrl: string; queue: Queue } | null = null;

function getEmbedQueue(config: AppConfig): Queue {
  if (!embedCached || embedCached.redisUrl !== config.REDIS_URL) {
    const connection = new IORedis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    connection.on("error", (error: Error) => {
      console.error("[gg-api] embed queue redis error:", error.message);
    });
    embedCached = {
      redisUrl: config.REDIS_URL,
      queue: new Queue(EMBED_QUEUE_NAME, { connection }),
    };
    embedCached.queue.on("error", (error: Error) => {
      console.error("[gg-api] embed queue error:", error.message);
    });
  }
  return embedCached.queue;
}

/**
 * Enqueue a post-embedding job (Phase 5B). Best-effort like the other
 * queues: a lost enqueue is recovered by the worker's missing-embedding
 * sweep, which embeds any post that has no post_embeddings row.
 */
export async function enqueuePostEmbedding(
  config: AppConfig,
  postId: string,
): Promise<void> {
  try {
    await getEmbedQueue(config).add(
      EMBED_POST_JOB,
      { postId },
      {
        jobId: `embed-${postId}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
  } catch (error) {
    console.error(
      `[gg-api] failed to enqueue embedding for post ${postId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

export async function enqueueMediaProcess(
  config: AppConfig,
  mediaId: string,
): Promise<void> {
  try {
    await getQueue(config).add(
      MEDIA_PROCESS_JOB,
      { mediaId },
      {
        jobId: `media-${mediaId}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
  } catch (error) {
    console.error(
      `[gg-api] failed to enqueue media processing for ${mediaId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}
