/**
 * Phase 4 — worker webhook delivery engine (D-042). Fake repo + fake
 * fetch: no DB, no network. Pins the semantics shared with the API copy:
 * signature format, retry/backoff, non-retryable 4xx, exhaustion, sweep.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  emitPollClosed,
  runWebhookDelivery,
  signWebhookPayload,
  sweepPendingDeliveries,
  type WebhookDeliveryRow,
  type WebhookRepo,
  type WebhookRow,
} from "../src/webhooks";

const KNOBS = { maxAttempts: 5, retryBaseMs: 1000, timeoutMs: 500 };

function fakeRepo(overrides: Partial<WebhookRepo> = {}): {
  repo: WebhookRepo;
  deliveries: Map<string, WebhookDeliveryRow & Record<string, unknown>>;
  hooks: Map<string, WebhookRow>;
  streaks: Map<string, number>;
} {
  const deliveries = new Map<string, WebhookDeliveryRow & Record<string, unknown>>();
  const hooks = new Map<string, WebhookRow>();
  const streaks = new Map<string, number>();
  const repo: WebhookRepo = {
    async deliveryById(id) {
      return deliveries.get(id) ?? null;
    },
    async webhookById(id) {
      return hooks.get(id) ?? null;
    },
    async updateDelivery(id, patch) {
      const row = deliveries.get(id);
      if (row) Object.assign(row, patch);
    },
    async setFailureStreak(webhookId, streak) {
      streaks.set(webhookId, streak);
      const hook = hooks.get(webhookId);
      if (hook) hook.failureStreak = streak;
    },
    async insertDelivery(row) {
      deliveries.set(row.id, {
        ...row,
        status: "pending",
        attempts: 0,
      } as WebhookDeliveryRow & Record<string, unknown>);
    },
    async hooksForRecipient() {
      return [];
    },
    async duePendingIds() {
      return [];
    },
    async postAuthorId() {
      return null;
    },
    async pollById() {
      return null;
    },
    async debateState() {
      return null;
    },
    ...overrides,
  };
  return { repo, deliveries, hooks, streaks };
}

function seed(
  ctx: ReturnType<typeof fakeRepo>,
  opts: { status?: number | "throw"; attempts?: number } = {},
): { deliveryId: string; secret: string } {
  const secret = "ggwh_testsecret";
  ctx.hooks.set("hook-1", {
    id: "hook-1",
    ownerId: "user-1",
    url: "https://example.test/hook",
    events: ["ping"],
    secret,
    isActive: true,
    failureStreak: 2,
  });
  ctx.deliveries.set("del-1", {
    id: "del-1",
    webhookId: "hook-1",
    event: "ping",
    payload: { id: "del-1", event: "ping", created_at: "2026-10-11T00:00:00.000Z", data: { test: true } },
    status: "pending",
    attempts: opts.attempts ?? 0,
  });
  return { deliveryId: "del-1", secret };
}

function fetchReturning(status: number | "throw", capture?: (init: unknown) => void) {
  return (async (_url: string, init: unknown) => {
    capture?.(init);
    if (status === "throw") throw new Error("connection refused");
    return { status } as Response;
  }) as unknown as typeof fetch;
}

const noEnqueue = async (): Promise<void> => undefined;

describe("signWebhookPayload", () => {
  it("matches the API copy's HMAC-SHA256 hex over the raw body", () => {
    const body = JSON.stringify({ id: "d1", event: "ping", data: { a: 1 } });
    const expected = createHmac("sha256", "ggwh_x").update(body, "utf8").digest("hex");
    expect(signWebhookPayload("ggwh_x", body)).toBe(expected);
  });
});

describe("runWebhookDelivery", () => {
  it("2xx → delivered, signed headers, failure streak reset", async () => {
    const ctx = fakeRepo();
    const { deliveryId, secret } = seed(ctx);
    let sentInit: { headers: Record<string, string>; body: string } | undefined;
    const outcome = await runWebhookDelivery(ctx.repo, deliveryId, {
      knobs: KNOBS,
      enqueueDelivery: noEnqueue,
      fetchImpl: fetchReturning(200, (init) => {
        sentInit = init as typeof sentInit;
      }),
    });
    expect(outcome).toBe("delivered");
    const row = ctx.deliveries.get(deliveryId)!;
    expect(row.status).toBe("delivered");
    expect(row.attempts).toBe(1);
    expect(ctx.streaks.get("hook-1")).toBe(0);
    const expectedSig =
      "sha256=" + createHmac("sha256", secret).update(sentInit!.body).digest("hex");
    expect(sentInit!.headers["x-gg-signature"]).toBe(expectedSig);
    expect(sentInit!.headers["x-gg-event"]).toBe("ping");
    expect(sentInit!.headers["x-gg-delivery"]).toBe(deliveryId);
  });

  it("5xx → retry scheduled with exponential backoff + re-enqueue", async () => {
    const ctx = fakeRepo();
    const { deliveryId } = seed(ctx);
    const enqueued: Array<{ id: string; delay: number }> = [];
    const t0 = new Date("2026-10-11T00:00:00.000Z");
    const outcome = await runWebhookDelivery(ctx.repo, deliveryId, {
      knobs: KNOBS,
      enqueueDelivery: async (id, delay) => {
        enqueued.push({ id, delay });
      },
      fetchImpl: fetchReturning(503),
      now: () => t0,
    });
    expect(outcome).toBe("retry_scheduled");
    const row = ctx.deliveries.get(deliveryId)!;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect((row.nextAttemptAt as Date).getTime()).toBe(t0.getTime() + 1000);
    expect(enqueued).toEqual([{ id: deliveryId, delay: 1000 }]);
  });

  it("network error is retryable; 4xx (not 408/429) fails immediately", async () => {
    const ctxNet = fakeRepo();
    const a = seed(ctxNet);
    expect(
      await runWebhookDelivery(ctxNet.repo, a.deliveryId, {
        knobs: KNOBS,
        enqueueDelivery: noEnqueue,
        fetchImpl: fetchReturning("throw"),
      }),
    ).toBe("retry_scheduled");

    const ctx4xx = fakeRepo();
    const b = seed(ctx4xx);
    expect(
      await runWebhookDelivery(ctx4xx.repo, b.deliveryId, {
        knobs: KNOBS,
        enqueueDelivery: noEnqueue,
        fetchImpl: fetchReturning(404),
      }),
    ).toBe("failed");
    expect(ctx4xx.deliveries.get(b.deliveryId)!.status).toBe("failed");
    expect(ctx4xx.streaks.get("hook-1")).toBe(3);
  });

  it("attempts reaching the cap → exhausted", async () => {
    const ctx = fakeRepo();
    const { deliveryId } = seed(ctx, { attempts: KNOBS.maxAttempts - 1 });
    const outcome = await runWebhookDelivery(ctx.repo, deliveryId, {
      knobs: KNOBS,
      enqueueDelivery: noEnqueue,
      fetchImpl: fetchReturning(500),
    });
    expect(outcome).toBe("exhausted");
    expect(ctx.deliveries.get(deliveryId)!.status).toBe("exhausted");
  });

  it("non-pending rows are skipped; inactive hooks fail the delivery", async () => {
    const ctx = fakeRepo();
    const { deliveryId } = seed(ctx);
    ctx.deliveries.get(deliveryId)!.status = "delivered";
    expect(
      await runWebhookDelivery(ctx.repo, deliveryId, {
        knobs: KNOBS,
        enqueueDelivery: noEnqueue,
        fetchImpl: fetchReturning(200),
      }),
    ).toBe("skipped");

    const ctx2 = fakeRepo();
    const second = seed(ctx2);
    ctx2.hooks.get("hook-1")!.isActive = false;
    expect(
      await runWebhookDelivery(ctx2.repo, second.deliveryId, {
        knobs: KNOBS,
        enqueueDelivery: noEnqueue,
        fetchImpl: fetchReturning(200),
      }),
    ).toBe("failed");
  });
});

describe("sweep + emitters", () => {
  it("sweep re-enqueues every due pending delivery", async () => {
    const ctx = fakeRepo({
      async duePendingIds() {
        return ["a", "b", "c"];
      },
    });
    const enqueued: string[] = [];
    const count = await sweepPendingDeliveries(ctx.repo, async (id) => {
      enqueued.push(id);
    });
    expect(count).toBe(3);
    expect(enqueued).toEqual(["a", "b", "c"]);
  });

  it("emitPollClosed targets the host post's author with poll data", async () => {
    const inserted: Array<{ event: string; payload: unknown }> = [];
    const ctx = fakeRepo({
      async pollById() {
        return { id: "poll-1", postId: "post-1", question: "Q?" };
      },
      async postAuthorId() {
        return "author-1";
      },
      async hooksForRecipient(recipient, event) {
        expect(recipient).toBe("author-1");
        expect(event).toBe("poll.closed");
        return [
          {
            id: "hook-9",
            ownerId: "author-1",
            url: "https://example.test/h",
            events: ["poll.closed"],
            secret: "ggwh_s",
            isActive: true,
            failureStreak: 0,
          },
        ];
      },
      async insertDelivery(row) {
        inserted.push({ event: row.event, payload: row.payload });
      },
    });
    const enqueued: string[] = [];
    const created = await emitPollClosed(ctx.repo, async (id) => {
      enqueued.push(id);
    }, "poll-1");
    expect(created).toBe(1);
    expect(enqueued).toHaveLength(1);
    const payload = inserted[0]!.payload as { event: string; data: { poll_id: string } };
    expect(payload.event).toBe("poll.closed");
    expect(payload.data.poll_id).toBe("poll-1");
  });
});
