/**
 * Phase 5B worker jobs: embeddings, web push, email digests.
 *
 * Unit tests run against fake repos (the pattern of media-job.test.ts).
 * Three honest end-to-end checks are env-gated:
 * - EMBEDDINGS_MODEL_PATH: the real MiniLM model embeds a paraphrase pair.
 * - TEST_DATABASE_URL: the drizzle digest/push repos run against gg_test.
 * The web-push sender test always runs: a local HTTPS server (self-signed)
 * stands in for the push service, with a real ECDH subscription keypair.
 */
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import webpush from "web-push";
import { createWorkerDb } from "../src/db";
import {
  buildDigest,
  digestPeriodKey,
  renderDigestHtml,
  runDigest,
  drizzleDigestRepo,
  type DigestRepo,
} from "../src/digest";
import {
  createModelEmbedder,
  embeddingTextOf,
  runEmbedPost,
  runEmbedSweep,
  type EmbeddingRepo,
} from "../src/embeddings";
import {
  createWebPushSender,
  isQuietHours,
  runPushSweep,
  torontoMinutesOfDay,
  type NotificationRow,
  type PushRepo,
  type PushSubscriptionRow,
} from "../src/push";

// ─── Embeddings (fake repo) ─────────────────────────────────────────────────

function fakeEmbeddingRepo(posts: Record<string, { title: string | null; bodyMd: string | null; deletedAt: Date | null }>) {
  const upserts = new Map<string, number[]>();
  const repo: EmbeddingRepo = {
    async getPostText(postId) {
      const post = posts[postId];
      return post ? { id: postId, ...post } : null;
    },
    async upsertEmbedding(postId, embedding) {
      upserts.set(postId, embedding);
    },
    async listMissingEmbeddings(limit) {
      return Object.entries(posts)
        .filter(([id, p]) => !upserts.has(id) && !p.deletedAt)
        .slice(0, limit)
        .map(([id, p]) => ({ id, ...p }));
    },
  };
  return { repo, upserts };
}

const fakeEmbedder = async (text: string): Promise<number[]> => {
  const vector = new Array<number>(384).fill(0);
  vector[0] = text.length / 1000;
  vector[1] = 1;
  return vector;
};

describe("embeddings", () => {
  it("embeds a live post and skips deleted ones", async () => {
    const { repo, upserts } = fakeEmbeddingRepo({
      "p-1": { title: "Hello", bodyMd: "world", deletedAt: null },
      "p-2": { title: "Gone", bodyMd: "deleted", deletedAt: new Date() },
    });
    const one = await runEmbedPost(repo, fakeEmbedder, "p-1");
    expect(one.outcome).toBe("embedded");
    expect(upserts.get("p-1")?.length).toBe(384);
    const two = await runEmbedPost(repo, fakeEmbedder, "p-2");
    expect(two.outcome).toBe("skipped_deleted");
    const missing = await runEmbedPost(repo, fakeEmbedder, "nope");
    expect(missing.outcome).toBe("missing");
  });

  it("sweep embeds only the missing live posts", async () => {
    const { repo, upserts } = fakeEmbeddingRepo({
      "p-1": { title: "One", bodyMd: "a", deletedAt: null },
      "p-2": { title: "Two", bodyMd: "b", deletedAt: null },
    });
    const result = await runEmbedSweep(repo, fakeEmbedder);
    expect(result).toEqual({ embedded: 2, scanned: 2 });
    expect(upserts.size).toBe(2);
  });

  it("strips markdown noise from the embedded text", () => {
    const text = embeddingTextOf({
      title: "A **bold** claim",
      bodyMd: "## Heading\n\nSome `code` and [a link](https://x.example) here.",
    });
    expect(text).not.toContain("**");
    expect(text).not.toContain("##");
    expect(text).not.toContain("`");
    expect(text).toContain("bold");
    expect(text).toContain("a link");
  });
});

describe.skipIf(!process.env.EMBEDDINGS_MODEL_PATH)(
  "embeddings (real MiniLM model)",
  () => {
    it("gives paraphrases a much higher cosine than unrelated text", async () => {
      const embedder = await createModelEmbedder(process.env.EMBEDDINGS_MODEL_PATH);
      expect(embedder).not.toBeNull();
      const a = await embedder!("The city council voted to fund the new public library");
      const b = await embedder!("Municipal leaders approved money for a public reading hall");
      const c = await embedder!("The quarterback threw three touchdowns in the playoff win");
      expect(a.length).toBe(384);
      const cos = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * (y[i] ?? 0), 0);
      expect(cos(a, b)).toBeGreaterThan(0.3);
      expect(cos(a, c)).toBeLessThan(0.2);
    }, 120_000);
  },
);

// ─── Push ───────────────────────────────────────────────────────────────────

interface FakePushState {
  subscriptions: PushSubscriptionRow[];
  settings: {
    notificationPrefs: Record<string, unknown>;
    pushPrefs: Record<string, unknown>;
    quietHours: { start: string; end: string } | null;
  } | null;
  notifications: NotificationRow[];
  deliveries: Array<Record<string, unknown>>;
  deletedSubs: string[];
}

function fakePushRepo(state: FakePushState): PushRepo {
  return {
    async listCandidateNotifications() {
      return state.notifications;
    },
    async getSubscriptions(userId) {
      return state.subscriptions.filter((s) => s.userId === userId);
    },
    async getSettings() {
      return state.settings;
    },
    async getHandle() {
      return "actorhandle";
    },
    async listDeliveredPairs() {
      return new Set(
        state.deliveries.map((d) => `${d.notificationId}:${d.subscriptionId}`),
      );
    },
    async recordDelivery(row) {
      state.deliveries.push({ ...row });
    },
    async deleteSubscription(id) {
      state.deletedSubs.push(id);
    },
  };
}

function hhmm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function baseState(): FakePushState {
  return {
    subscriptions: [
      {
        id: "sub-1",
        userId: "user-1",
        endpoint: "https://push.example.com/abc",
        p256dh: "k",
        auth: "a",
      },
    ],
    settings: { notificationPrefs: {}, pushPrefs: {}, quietHours: null },
    notifications: [
      {
        id: "notif-1",
        recipientId: "user-1",
        type: "reply",
        actorId: "user-2",
        payload: {},
        createdAt: new Date(),
      },
    ],
    deliveries: [],
    deletedSubs: [],
  };
}

describe("push sweep", () => {
  it("sends and records the attempt", async () => {
    const state = baseState();
    let calls = 0;
    const result = await runPushSweep(
      fakePushRepo(state),
      async () => {
        calls += 1;
        return { statusCode: 201 };
      },
      { now: new Date(), appBaseUrl: "https://gg.example" },
    );
    expect(calls).toBe(1);
    expect(result.sent).toBe(1);
    expect(state.deliveries[0]?.status).toBe("sent");
    expect(state.deliveries[0]?.responseStatus).toBe(201);
  });

  it("honors the per-type push pref without calling the sender", async () => {
    const state = baseState();
    state.settings!.pushPrefs = { reply: false };
    let calls = 0;
    const result = await runPushSweep(
      fakePushRepo(state),
      async () => {
        calls += 1;
        return { statusCode: 201 };
      },
      { now: new Date(), appBaseUrl: "https://gg.example" },
    );
    expect(calls).toBe(0);
    expect(result.skipped).toBe(1);
    expect(state.deliveries[0]?.status).toBe("skipped_pref");
  });

  it("honors quiet hours (Toronto) without calling the sender", async () => {
    const now = new Date();
    const state = baseState();
    const current = torontoMinutesOfDay(now);
    state.settings!.quietHours = { start: hhmm(current - 30), end: hhmm(current + 30) };
    let calls = 0;
    const result = await runPushSweep(
      fakePushRepo(state),
      async () => {
        calls += 1;
        return { statusCode: 201 };
      },
      { now, appBaseUrl: "https://gg.example" },
    );
    expect(calls).toBe(0);
    expect(result.skipped).toBe(1);
    expect(state.deliveries[0]?.status).toBe("skipped_quiet_hours");
    expect(isQuietHours(state.settings!.quietHours, now)).toBe(true);
    expect(isQuietHours({ start: "03:00", end: "03:00" }, now)).toBe(false);
  });

  it("deletes subscriptions the push service says are gone (410)", async () => {
    const state = baseState();
    const result = await runPushSweep(
      fakePushRepo(state),
      async () => ({ statusCode: 410 }),
      { now: new Date(), appBaseUrl: "https://gg.example" },
    );
    expect(result.gone).toBe(1);
    expect(state.deletedSubs).toEqual(["sub-1"]);
    expect(state.deliveries[0]?.status).toBe("gone");
  });

  it("does not re-attempt pairs that already have a delivery row", async () => {
    const state = baseState();
    state.deliveries.push({ notificationId: "notif-1", subscriptionId: "sub-1", status: "sent" });
    let calls = 0;
    const result = await runPushSweep(
      fakePushRepo(state),
      async () => {
        calls += 1;
        return { statusCode: 201 };
      },
      { now: new Date(), appBaseUrl: "https://gg.example" },
    );
    expect(calls).toBe(0);
    expect(result.sent).toBe(0);
  });
});

describe("push sender (real web-push against a local endpoint)", () => {
  let server: Server;
  let received: Array<{ method: string; url: string }> = [];
  let endpoint = "";

  it("delivers an encrypted push to the subscription endpoint", async () => {
    // web-push always speaks TLS (real push services are HTTPS), so the
    // fake endpoint is a local HTTPS server with a throwaway self-signed
    // cert; the test process trusts it via NODE_TLS_REJECT_UNAUTHORIZED.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/gg-push-cert-`);
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", `${dir}/key.pem`, "-out", `${dir}/cert.pem`,
      "-days", "1", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1",
    ], { stdio: "ignore" });
    const { createServer: createHttpsServer } = await import("node:https");
    received = [];
    server = createHttpsServer(
      { key: readFileSync(`${dir}/key.pem`), cert: readFileSync(`${dir}/cert.pem`) },
      (req, res) => {
        received.push({ method: req.method ?? "", url: req.url ?? "" });
        req.resume();
        req.on("end", () => {
          res.writeHead(201);
          res.end();
        });
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    endpoint = `https://127.0.0.1:${port}/push`;

    // A real P-256 receiver keypair, as a browser would register.
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const p256dh = ecdh.getPublicKey().toString("base64url");
    const auth = randomBytes(16).toString("base64url");

    const vapid = webpush.generateVAPIDKeys();
    const sender = createWebPushSender({
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
      subject: "mailto:test@gg.example",
    });
    const state = baseState();
    state.subscriptions = [
      { id: "sub-real", userId: "user-1", endpoint, p256dh, auth },
    ];
    const result = await runPushSweep(fakePushRepo(state), sender, {
      now: new Date(),
      appBaseUrl: "https://gg.example",
    });
    expect(received.length).toBe(1);
    expect(received[0]?.method).toBe("POST");
    expect(result.sent).toBe(1);
    expect(state.deliveries[0]?.status).toBe("sent");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 30_000);
});

// ─── Digests ────────────────────────────────────────────────────────────────

function fakeDigestRepo(): { repo: DigestRepo; sent: Array<{ to: string; subject: string }>; logs: Array<Record<string, unknown>> } {
  const logs: Array<Record<string, unknown>> = [];
  const repo: DigestRepo = {
    async listDigestUsers() {
      return [{ id: "u-1", email: "reader@example.com", handle: "reader" }];
    },
    async topCommunityPosts() {
      return [
        {
          shortCode: "abc123",
          title: "Libraries <b>matter</b>",
          excerpt: "A post about funding libraries in our city.",
          authorHandle: "priya",
          communitySlug: "cityhall",
          score: 42,
        },
      ];
    },
    async latestPulse() {
      return {
        question: "Should transit be free?",
        pulseDate: "2026-10-11",
        leadingOption: "Yes",
        totalVotes: 128,
      };
    },
    async recentDebates() {
      return [
        {
          proposition: "Stadiums deserve public money",
          mindChangeRate: 0.25,
          mindChangedCount: 7,
        },
      ];
    },
    async hasDigestLog(userId, frequency, periodKey) {
      return logs.some(
        (l) => l.userId === userId && l.frequency === frequency && l.periodKey === periodKey,
      );
    },
    async recordDigestLog(userId, frequency, periodKey, itemCount) {
      logs.push({ userId, frequency, periodKey, itemCount });
    },
  };
  return { repo, sent: [], logs };
}

describe("digests", () => {
  it("builds content from posts, pulse and debates", async () => {
    const { repo } = fakeDigestRepo();
    const content = await buildDigest(repo, "u-1", "daily", new Date());
    expect(content.posts.length).toBe(1);
    expect(content.pulse?.leadingOption).toBe("Yes");
    expect(content.debates[0]?.mindChangedCount).toBe(7);
  });

  it("renders escaped HTML with all three sections", async () => {
    const { repo } = fakeDigestRepo();
    const content = await buildDigest(repo, "u-1", "weekly", new Date());
    const html = renderDigestHtml(content, {
      frequency: "weekly",
      appBaseUrl: "https://gg.example",
      handle: "reader",
    });
    expect(html).toContain("Your weekly GG digest");
    expect(html).toContain("Libraries &lt;b&gt;matter&lt;/b&gt;");
    expect(html).not.toContain("<b>matter</b>");
    expect(html).toContain("Should transit be free?");
    expect(html).toContain("7 minds changed");
    expect(html).toContain("https://gg.example/post/abc123");
  });

  it("sends once per period and logs the send", async () => {
    const { repo, logs } = fakeDigestRepo();
    const sent: string[] = [];
    const mailer = {
      async sendDigestEmail(to: string, subject: string) {
        sent.push(`${to}:${subject}`);
      },
    };
    const now = new Date();
    const first = await runDigest(repo, mailer, "daily", now, "https://gg.example");
    expect(first.sent).toBe(1);
    expect(sent[0]).toContain("reader@example.com");
    expect(logs.length).toBe(1);
    const second = await runDigest(repo, mailer, "daily", now, "https://gg.example");
    expect(second.alreadySent).toBe(1);
    expect(sent.length).toBe(1);
  });

  it("period keys are Toronto-local", () => {
    // 2026-10-11 03:30 UTC = 2026-10-10 23:30 EDT (previous Toronto day).
    const instant = new Date("2026-10-11T03:30:00Z");
    expect(digestPeriodKey("daily", instant)).toBe("2026-10-10");
    expect(digestPeriodKey("weekly", instant)).toMatch(/^\d{4}-W\d{2}$/);
  });
});

// ─── DB integration (TEST_DATABASE_URL) ─────────────────────────────────────

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("phase5b repos (DB integration)", () => {
  const { db, client } = createWorkerDb(TEST_DATABASE_URL!);
  const suffix = Math.random().toString(36).slice(2, 10);
  const userId = randomUUID();
  const communityId = randomUUID();
  const postId = randomUUID();

  afterAll(async () => {
    await client.end();
  });

  it("digest repo finds seeded content for a subscribed user", async () => {
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`
      insert into users (id, handle, email, email_verified_at, author_type, status, date_of_birth)
      values (${userId}::uuid, ${"dg_" + suffix}, ${"dg_" + suffix + "@example.com"}, now(), 'human', 'active', '1995-01-01')`);
    await db.execute(sql`
      insert into user_settings (user_id, digest_frequency)
      values (${userId}::uuid, 'daily')`);
    await db.execute(sql`
      insert into communities (id, slug, name, creator_id)
      values (${communityId}::uuid, ${"dg_" + suffix}, 'Digest Test', ${userId}::uuid)`);
    await db.execute(sql`
      insert into community_members (community_id, user_id, role, status)
      values (${communityId}::uuid, ${userId}::uuid, 'member', 'active')`);
    await db.execute(sql`
      insert into posts (id, short_code, author_id, author_type, type, root_id, path, path_label, depth, community_id, body_md, body_html, visibility, score)
      values (${postId}::uuid, ${"dg" + suffix}, ${userId}::uuid, 'human', 'TEXT', ${postId}::uuid, 'x', 'x', 0, ${communityId}::uuid, 'A seeded digest post about transit', '', 'community', 99)`);

    const repo = drizzleDigestRepo(db);
    const users = await repo.listDigestUsers("daily");
    expect(users.some((u) => u.id === userId)).toBe(true);
    const content = await buildDigest(repo, userId, "daily", new Date());
    expect(content.posts.some((p) => p.excerpt.includes("seeded digest post"))).toBe(true);
  });
});
