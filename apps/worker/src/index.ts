/**
 * @gg/worker — BullMQ consumers: media intake/transcoding, counter
 * maintenance, notification fan-out/digests, trending, vote-anomaly scans,
 * webhook delivery, story expiry (docs/ARCHITECTURE.md §3).
 *
 * Importing this module never opens a Redis connection — connections are
 * created lazily inside startWorker() and every client carries an error
 * handler, so a down Redis degrades to log lines, never a crash.
 *
 * Phase 2 adds the real media consumers:
 *  - `gg-media`   — `media.process` jobs enqueued by the API on upload
 *                   completion; runs the @gg/media scan/rendition/
 *                   transcode pipeline and persists the outcome.
 *  - `gg-stories` — `story.sweep` (scheduled every 15 min): hard-purges
 *                   stories 7 days past their 24 h expiry.
 */
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { LocalStorageAdapter } from "@gg/media";
import { createWorkerDb } from "./db";
import { drizzleMediaRepo, runMediaJob } from "./media-job";
import {
  closeExpiredPolls,
  drizzleOpinionRepo,
  expireDebateTurns,
  publishDailyPulse,
} from "./opinion";
import { drizzleScheduledRepo, publishDueScheduledPosts } from "./scheduled";
import { drizzleStorySweepRepo, purgeExpiredStories } from "./story-sweep";
import { computeTrending, drizzleTrendingRepo } from "./trending";
import {
  WEBHOOK_DELIVER_JOB,
  WEBHOOK_QUEUE_NAME,
  WEBHOOK_SWEEP_JOB,
  drizzleWebhookRepo,
  emitDebateTurnState,
  emitMentionCreated,
  emitPollClosed,
  runWebhookDelivery,
  sweepPendingDeliveries,
  webhookKnobsFromEnv,
  type WebhookRepo,
} from "./webhooks";
import {
  EMBED_POST_JOB,
  EMBED_QUEUE_NAME,
  EMBED_SWEEP_JOB,
  createModelEmbedder,
  drizzleEmbeddingRepo,
  runEmbedPost,
  runEmbedSweep,
  type Embedder,
} from "./embeddings";
import {
  NOTIFY_QUEUE_NAME,
  PUSH_SWEEP_JOB,
  createWebPushSender,
  drizzlePushRepo,
  runPushSweep,
  type PushSender,
} from "./push";
import {
  DIGEST_DAILY_JOB,
  DIGEST_WEEKLY_JOB,
  drizzleDigestRepo,
  runDigest,
} from "./digest";
import { createWorkerMailer } from "./mailer";
import { fieldEncryptionKeyFromEnv } from "./secrets";
import {
  AUDIT_PRUNE_JOB,
  MAINTENANCE_QUEUE_NAME,
  auditPruneOptionsFromEnv,
  drizzleAuditPruneRepo,
  pruneAgentAuditLogs,
} from "./maintenance";

export const QUEUE_NAME = "gg-jobs";
export const MEDIA_QUEUE_NAME = "gg-media";
export const STORY_QUEUE_NAME = "gg-stories";
export const OPINION_QUEUE_NAME = "gg-opinion";
export const SOCIAL_QUEUE_NAME = "gg-social";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

function createConnection(): IORedis {
  const connection = new IORedis(REDIS_URL, {
    // BullMQ requires maxRetriesPerRequest to be null.
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
  connection.on("error", (error: Error) => {
    console.error("[gg-worker] redis connection error:", error.message);
  });
  return connection;
}

async function processor(job: Job): Promise<void> {
  // Phase 1 slice 1: the API maintains vote/follow/community counters
  // synchronously inside the write transaction (DECISIONS D-016), so the
  // only worker job wired so far is the counter reconciliation sweep —
  // still a logging stub here; the recompute-from-source implementation
  // lands with the ranking worker. Real media/notification processors
  // land with their features (Phase 2+).
  switch (job.name) {
    case "counter.reconcile":
      console.log(
        `[gg-worker] counter.reconcile requested (stub — counters are tx-maintained in slice 1)`,
        job.data,
      );
      return;
    default:
      console.log(`[gg-worker] job ${job.id ?? "?"} (${job.name})`, job.data);
  }
}

function createWebhookQueue(): Queue {
  const queue = new Queue(WEBHOOK_QUEUE_NAME, { connection: createConnection() });
  queue.on("error", (error: Error) => {
    console.error("[gg-worker] webhook queue error:", error.message);
  });
  return queue;
}

function webhookEnqueue(queue: Queue): (deliveryId: string, delayMs: number) => Promise<void> {
  return async (deliveryId, delayMs) => {
    await queue.add(
      WEBHOOK_DELIVER_JOB,
      { deliveryId },
      {
        delay: Math.max(0, delayMs),
        attempts: 1,
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    );
  };
}

/**
 * Phase 4 webhook delivery consumer (D-042): attempts `webhook.deliver`
 * jobs and runs the 60 s pending sweep that re-enqueues due deliveries
 * (the backstop for lost enqueues / worker downtime).
 */
function startWebhookConsumers(): { workers: Worker[] } | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.warn("[gg-worker] DATABASE_URL not set — webhook delivery disabled");
    return null;
  }
  const { db } = createWorkerDb(databaseUrl);
  const repo = drizzleWebhookRepo(db);
  const queue = createWebhookQueue();
  const enqueue = webhookEnqueue(queue);
  const knobs = webhookKnobsFromEnv();

  void queue
    .upsertJobScheduler("webhook-sweep", { every: 60 * 1000 }, { name: WEBHOOK_SWEEP_JOB, data: {} })
    .catch((error: Error) => {
      console.error("[gg-worker] webhook scheduler error:", error.message);
    });

  const worker = new Worker(
    WEBHOOK_QUEUE_NAME,
    async (job: Job) => {
      if (job.name === WEBHOOK_SWEEP_JOB) {
        return { enqueued: await sweepPendingDeliveries(repo, enqueue) };
      }
      if (job.name === WEBHOOK_DELIVER_JOB) {
        const deliveryId = String(
          (job.data as { deliveryId?: string } | undefined)?.deliveryId ?? "",
        );
        if (!deliveryId) return { outcome: "skipped" };
        return { outcome: await runWebhookDelivery(repo, deliveryId, { knobs, enqueueDelivery: enqueue, encryptionKey: fieldEncryptionKeyFromEnv() }) };
      }
      console.log(`[gg-worker] unknown webhook job ${job.name}`);
      return undefined;
    },
    { connection: createConnection(), concurrency: 4 },
  );
  worker.on("error", (error: Error) => {
    console.error("[gg-worker] webhook worker error:", error.message);
  });
  worker.on("failed", (job: Job | undefined, error: Error) => {
    console.error(`[gg-worker] webhook job ${job?.id ?? "?"} failed:`, error.message);
  });
  return { workers: [worker] };
}

/** Media pipeline + story sweep consumers (Phase 2). Needs DATABASE_URL. */
function startMediaConsumers(): { workers: Worker[] } | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.warn(
      "[gg-worker] DATABASE_URL not set — media pipeline and story sweep disabled",
    );
    return null;
  }
  const mediaDir = process.env.MEDIA_DIR ?? "./media-data";
  const store = new LocalStorageAdapter(mediaDir);
  const { db } = createWorkerDb(databaseUrl);
  const mediaRepo = drizzleMediaRepo(db);
  const sweepRepo = drizzleStorySweepRepo(db);

  const mediaWorker = new Worker(
    MEDIA_QUEUE_NAME,
    async (job: Job) => {
      const mediaId = String(
        (job.data as { mediaId?: string } | undefined)?.mediaId ?? "",
      );
      return { outcome: await runMediaJob(mediaRepo, store, mediaId) };
    },
    { connection: createConnection(), concurrency: 2 },
  );
  mediaWorker.on("error", (error: Error) => {
    console.error("[gg-worker] media worker error:", error.message);
  });
  mediaWorker.on("failed", (job: Job | undefined, error: Error) => {
    console.error(
      `[gg-worker] media job ${job?.id ?? "?"} failed:`,
      error.message,
    );
  });

  const sweepQueue = new Queue(STORY_QUEUE_NAME, {
    connection: createConnection(),
  });
  sweepQueue.on("error", (error: Error) => {
    console.error("[gg-worker] sweep queue error:", error.message);
  });
  void sweepQueue
    .upsertJobScheduler(
      "story-sweep",
      { every: 15 * 60 * 1000 },
      { name: "story.sweep", data: {} },
    )
    .catch((error: Error) => {
      console.error("[gg-worker] sweep scheduler error:", error.message);
    });
  const sweepWorker = new Worker(
    STORY_QUEUE_NAME,
    async () => purgeExpiredStories(sweepRepo, store),
    { connection: createConnection() },
  );
  sweepWorker.on("error", (error: Error) => {
    console.error("[gg-worker] sweep worker error:", error.message);
  });
  sweepWorker.on("completed", (_job, result) => {
    const r = result as { purged?: number } | undefined;
    if (r?.purged) console.log(`[gg-worker] story sweep purged ${r.purged}`);
  });

  return { workers: [mediaWorker, sweepWorker] };
}

/**
 * Phase 3 opinion sweeps: Daily Pulse publish (00:05 ET), debate turn
 * expiry + poll auto-close (every 5 min), debate archive (daily). Same DB
 * gate as the media consumers; the API's lazy pulse creation is the
 * self-healing backstop if this worker is down at 00:05.
 */
function startOpinionConsumers(): { workers: Worker[] } | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  const { db } = createWorkerDb(databaseUrl);
  const repo = drizzleOpinionRepo(db, process.env.PULSE_AUTHOR_HANDLE ?? "gg_scout");
  const webhookRepo: WebhookRepo = drizzleWebhookRepo(db);
  const webhookEnqueueDelivery = webhookEnqueue(createWebhookQueue());
  const queue = new Queue(OPINION_QUEUE_NAME, { connection: createConnection() });
  queue.on("error", (error: Error) => {
    console.error("[gg-worker] opinion queue error:", error.message);
  });
  const schedulers: Array<Promise<unknown>> = [
    queue.upsertJobScheduler(
      "pulse-publish",
      { pattern: "5 0 * * *", tz: "America/Toronto" },
      { name: "pulse.publish", data: {} },
    ),
    queue.upsertJobScheduler(
      "debate-expire-turns",
      { every: 5 * 60 * 1000 },
      { name: "debate.expire-turns", data: {} },
    ),
    queue.upsertJobScheduler(
      "poll-close-expired",
      { every: 5 * 60 * 1000 },
      { name: "poll.close-expired", data: {} },
    ),
    queue.upsertJobScheduler(
      "debate-archive",
      { pattern: "17 3 * * *", tz: "America/Toronto" },
      { name: "debate.archive", data: {} },
    ),
  ];
  for (const pending of schedulers) {
    void pending.catch((error: Error) => {
      console.error("[gg-worker] opinion scheduler error:", error.message);
    });
  }
  const worker = new Worker(
    OPINION_QUEUE_NAME,
    async (job: Job) => {
      switch (job.name) {
        case "pulse.publish":
          return publishDailyPulse(repo, process.env.PULSE_AUTHOR_HANDLE ?? "gg_scout");
        case "debate.expire-turns":
          return expireDebateTurns(repo, new Date(), {
            onDebateTouched: (debateId) =>
              emitDebateTurnState(webhookRepo, webhookEnqueueDelivery, debateId).then(
                () => undefined,
              ),
          });
        case "poll.close-expired":
          return closeExpiredPolls(repo, new Date(), {
            onPollClosed: (pollId) =>
              emitPollClosed(webhookRepo, webhookEnqueueDelivery, pollId).then(
                () => undefined,
              ),
          });
        case "debate.archive":
          return {
            archived: await repo.archiveClosedBefore(
              new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
            ),
          };
        default:
          console.log(`[gg-worker] unknown opinion job ${job.name}`);
          return undefined;
      }
    },
    { connection: createConnection() },
  );
  worker.on("error", (error: Error) => {
    console.error("[gg-worker] opinion worker error:", error.message);
  });
  worker.on("failed", (job: Job | undefined, error: Error) => {
    console.error(`[gg-worker] opinion job ${job?.id ?? "?"} failed:`, error.message);
  });
  return { workers: [worker] };
}

/**
 * Phase 5A consumers (queue `gg-social`): the scheduled-post publisher
 * (every minute) and the trending snapshot job (every 10 minutes).
 */
function startSocialConsumers(): { workers: Worker[] } | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  const { db } = createWorkerDb(databaseUrl);
  const scheduledRepo = drizzleScheduledRepo(db);
  const trendingRepo = drizzleTrendingRepo(db);
  const webhookRepo: WebhookRepo = drizzleWebhookRepo(db);
  const webhookEnqueueDelivery = webhookEnqueue(createWebhookQueue());
  const queue = new Queue(SOCIAL_QUEUE_NAME, { connection: createConnection() });
  queue.on("error", (error: Error) => {
    console.error("[gg-worker] social queue error:", error.message);
  });
  const schedulers: Array<Promise<unknown>> = [
    queue.upsertJobScheduler(
      "posts-publish-scheduled",
      { every: 60 * 1000 },
      { name: "posts.publish-scheduled", data: {} },
    ),
    queue.upsertJobScheduler(
      "trending-compute",
      { every: 10 * 60 * 1000 },
      { name: "trending.compute", data: {} },
    ),
  ];
  for (const pending of schedulers) {
    void pending.catch((error: Error) => {
      console.error("[gg-worker] social scheduler error:", error.message);
    });
  }
  const worker = new Worker(
    SOCIAL_QUEUE_NAME,
    async (job: Job) => {
      switch (job.name) {
        case "posts.publish-scheduled":
          return publishDueScheduledPosts(scheduledRepo, new Date(), 50, {
            onMention: async (post, target) => {
              await emitMentionCreated(webhookRepo, webhookEnqueueDelivery, target.id, {
                post_id: post.id,
                actor_id: post.authorId!,
                mentioned_user_id: target.id,
                mentioned_handle: target.handle,
                excerpt: (post.bodyMd ?? "").slice(0, 140),
              });
            },
          });
        case "trending.compute":
          return computeTrending(trendingRepo, new Date());
        default:
          console.log(`[gg-worker] unknown social job ${job.name}`);
          return undefined;
      }
    },
    { connection: createConnection() },
  );
  worker.on("error", (error: Error) => {
    console.error("[gg-worker] social worker error:", error.message);
  });
  worker.on("failed", (job: Job | undefined, error: Error) => {
    console.error(`[gg-worker] social job ${job?.id ?? "?"} failed:`, error.message);
  });
  return { workers: [worker] };
}

/**
 * Phase 5B embedding consumers (queue `gg-embed`): `post.embed` jobs
 * from the API + a 10-minute sweep for posts missing embeddings.
 * Disabled (with a log line) when EMBEDDINGS_MODEL_PATH is unset.
 */
function startEmbedConsumers(): { workers: Worker[] } | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  const modelPath = process.env.EMBEDDINGS_MODEL_PATH;
  if (!modelPath) {
    console.warn(
      "[gg-worker] EMBEDDINGS_MODEL_PATH not set — semantic-search embeddings disabled",
    );
    return null;
  }
  const { db } = createWorkerDb(databaseUrl);
  const repo = drizzleEmbeddingRepo(db);
  let embedderPromise: Promise<Embedder | null> | null = null;
  const getEmbedder = (): Promise<Embedder | null> => {
    embedderPromise ??= createModelEmbedder(modelPath).catch((error: Error) => {
      console.error("[gg-worker] embedding model failed to load:", error.message);
      return null;
    });
    return embedderPromise;
  };
  const queue = new Queue(EMBED_QUEUE_NAME, { connection: createConnection() });
  queue.on("error", (error: Error) => {
    console.error("[gg-worker] embed queue error:", error.message);
  });
  void queue
    .upsertJobScheduler(
      "embed-sweep",
      { every: 10 * 60 * 1000 },
      { name: EMBED_SWEEP_JOB, data: {} },
    )
    .catch((error: Error) => {
      console.error("[gg-worker] embed scheduler error:", error.message);
    });
  const worker = new Worker(
    EMBED_QUEUE_NAME,
    async (job: Job) => {
      const embedder = await getEmbedder();
      if (!embedder) return { outcome: "model_unavailable" };
      if (job.name === EMBED_SWEEP_JOB) {
        return runEmbedSweep(repo, embedder);
      }
      if (job.name === EMBED_POST_JOB) {
        const postId = String(
          (job.data as { postId?: string } | undefined)?.postId ?? "",
        );
        if (!postId) return { outcome: "skipped" };
        return runEmbedPost(repo, embedder, postId);
      }
      console.log(`[gg-worker] unknown embed job ${job.name}`);
      return undefined;
    },
    { connection: createConnection(), concurrency: 2 },
  );
  worker.on("error", (error: Error) => {
    console.error("[gg-worker] embed worker error:", error.message);
  });
  worker.on("failed", (job: Job | undefined, error: Error) => {
    console.error(`[gg-worker] embed job ${job?.id ?? "?"} failed:`, error.message);
  });
  return { workers: [worker] };
}

/**
 * Phase 5B notification consumers (queue `gg-notify`): the web-push
 * sweep (every 30 s) and the email digests (daily 12:00 ET-ish /
 * weekly Mon, scheduled in UTC: 17:00 UTC ≈ noon ET). Push is disabled
 * when the VAPID env trio is incomplete; digests always run (the
 * LogMailer is the staging mailer, D-062).
 */
function startNotifyConsumers(): { workers: Worker[] } | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  const { db } = createWorkerDb(databaseUrl);
  const pushRepo = drizzlePushRepo(db);
  const digestRepo = drizzleDigestRepo(db);
  const mailer = createWorkerMailer(process.env);
  const appBaseUrl = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");

  let sender: PushSender | null = null;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (publicKey && privateKey) {
    sender = createWebPushSender({
      publicKey,
      privateKey,
      subject: process.env.VAPID_SUBJECT ?? "mailto:hello@genznewz.com",
    });
  } else {
    console.warn(
      "[gg-worker] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — web push sending disabled",
    );
  }

  const queue = new Queue(NOTIFY_QUEUE_NAME, { connection: createConnection() });
  queue.on("error", (error: Error) => {
    console.error("[gg-worker] notify queue error:", error.message);
  });
  const schedulers: Array<Promise<unknown>> = [
    queue.upsertJobScheduler(
      "digest-daily",
      { pattern: "0 17 * * *", tz: "UTC" },
      { name: DIGEST_DAILY_JOB, data: {} },
    ),
    queue.upsertJobScheduler(
      "digest-weekly",
      { pattern: "5 17 * * 1", tz: "UTC" },
      { name: DIGEST_WEEKLY_JOB, data: {} },
    ),
  ];
  if (sender) {
    schedulers.push(
      queue.upsertJobScheduler(
        "push-sweep",
        { every: 30 * 1000 },
        { name: PUSH_SWEEP_JOB, data: {} },
      ),
    );
  }
  for (const pending of schedulers) {
    void pending.catch((error: Error) => {
      console.error("[gg-worker] notify scheduler error:", error.message);
    });
  }
  const worker = new Worker(
    NOTIFY_QUEUE_NAME,
    async (job: Job) => {
      switch (job.name) {
        case PUSH_SWEEP_JOB:
          if (!sender) return { skipped: "vapid_unset" };
          return runPushSweep(pushRepo, sender, { now: new Date(), appBaseUrl });
        case DIGEST_DAILY_JOB:
          return runDigest(digestRepo, mailer, "daily", new Date(), appBaseUrl);
        case DIGEST_WEEKLY_JOB:
          return runDigest(digestRepo, mailer, "weekly", new Date(), appBaseUrl);
        default:
          console.log(`[gg-worker] unknown notify job ${job.name}`);
          return undefined;
      }
    },
    { connection: createConnection(), concurrency: 2 },
  );
  worker.on("error", (error: Error) => {
    console.error("[gg-worker] notify worker error:", error.message);
  });
  worker.on("failed", (job: Job | undefined, error: Error) => {
    console.error(`[gg-worker] notify job ${job?.id ?? "?"} failed:`, error.message);
  });
  return { workers: [worker] };
}

/**
 * Hardening maintenance consumer (D-071): daily agent audit-log pruning
 * on its own queue (`gg-maintenance`), scheduled via a BullMQ repeatable
 * job. Dry-run and retention are env knobs (AUDIT_PRUNE_DRY_RUN /
 * AUDIT_PRUNE_RETENTION_MONTHS).
 */
function startMaintenanceConsumers(): { workers: Worker[] } | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.warn("[gg-worker] DATABASE_URL not set — maintenance disabled");
    return null;
  }
  const { db } = createWorkerDb(databaseUrl);
  const repo = drizzleAuditPruneRepo(db);
  const queue = new Queue(MAINTENANCE_QUEUE_NAME, {
    connection: createConnection(),
  });
  queue.on("error", (error: Error) => {
    console.error("[gg-worker] maintenance queue error:", error.message);
  });
  void queue
    .upsertJobScheduler(
      "audit-prune-daily",
      { every: 24 * 60 * 60 * 1000 },
      { name: AUDIT_PRUNE_JOB, data: {} },
    )
    .catch((error: Error) => {
      console.error("[gg-worker] maintenance scheduler error:", error.message);
    });

  const worker = new Worker(
    MAINTENANCE_QUEUE_NAME,
    async (job: Job) => {
      if (job.name === AUDIT_PRUNE_JOB) {
        return pruneAgentAuditLogs(repo, auditPruneOptionsFromEnv());
      }
      console.log(`[gg-worker] unknown maintenance job ${job.name}`);
      return undefined;
    },
    { connection: createConnection(), concurrency: 1 },
  );
  worker.on("error", (error: Error) => {
    console.error("[gg-worker] maintenance worker error:", error.message);
  });
  return { workers: [worker] };
}

export function startWorker(): { queue: Queue; worker: Worker } {
  const queue = new Queue(QUEUE_NAME, { connection: createConnection() });
  queue.on("error", (error: Error) => {
    console.error("[gg-worker] queue error:", error.message);
  });

  const parsed = Number.parseInt(process.env.WORKER_CONCURRENCY ?? "5", 10);
  const worker = new Worker(QUEUE_NAME, processor, {
    connection: createConnection(),
    concurrency: Number.isNaN(parsed) ? 5 : parsed,
  });
  worker.on("error", (error: Error) => {
    console.error("[gg-worker] worker error:", error.message);
  });
  worker.on("failed", (job: Job | undefined, error: Error) => {
    console.error(`[gg-worker] job ${job?.id ?? "?"} failed:`, error.message);
  });

  startMediaConsumers();
  startOpinionConsumers();
  startWebhookConsumers();
  startSocialConsumers();
  startEmbedConsumers();
  startNotifyConsumers();
  startMaintenanceConsumers();

  return { queue, worker };
}

if (require.main === module) {
  const { worker } = startWorker();
  console.log(`[gg-worker] listening on queue "${QUEUE_NAME}"`);

  const shutdown = (signal: string): void => {
    console.log(`[gg-worker] ${signal} received, shutting down`);
    worker
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
