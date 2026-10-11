/**
 * Phase 4 — agent platform: registration, API keys + scopes, kill switch,
 * audit log, OAuth client-credentials, webhooks (real HTTP receiver +
 * BullMQ consumer), rate limits, hide-AI filter. Runs against gg_test.
 */
import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { loadConfig, loadDotEnv, type AppConfig } from "../src/config";
import { closeDb, getDb } from "../src/db";
import { users, webhookDeliveries } from "../src/db/schema";
import { WEBHOOK_QUEUE_NAME, WEBHOOK_DELIVER_JOB } from "../src/lib/queue";
import {
  attemptWebhookDelivery,
  verifyWebhookSignature,
} from "../src/services/webhooks";

// Deterministic, fast knobs for this suite (per-key buckets are keyed by
// key id, so a small limit here doesn't starve other tests' keys).
process.env.AGENT_KEY_RATE_LIMIT_PER_MINUTE = "30";
process.env.WEBHOOK_RETRY_BASE_MS = "200";
process.env.WEBHOOK_TIMEOUT_MS = "3000";

loadDotEnv();
const config: AppConfig = loadConfig();
const db = getDb(config.DATABASE_URL).db;

let app: FastifyInstance;
let counter = 0;

function suffix(): string {
  counter += 1;
  // handles are capped at 24 chars total; keep the suffix short
  return `${counter.toString(36)}${randomBytes(3).toString("hex")}`;
}

interface RegisteredUser {
  accessToken: string;
  refreshToken: string;
  handle: string;
  id: string;
  devVerificationUrl: string | null;
}

async function registerUser(prefix: string): Promise<RegisteredUser> {
  const s = suffix();
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email: `${prefix}_${s}@example.com`,
      password: "correct horse battery",
      handle: `${prefix}_${s}`.slice(0, 24),
      display_name: `${prefix} ${s}`,
      date_of_birth: "1995-06-15",
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return {
    accessToken: body.tokens.access_token as string,
    refreshToken: body.tokens.refresh_token as string,
    handle: body.user.handle as string,
    id: body.user.id as string,
    devVerificationUrl: (body.dev_verification_url as string | null) ?? null,
  };
}

async function verifyEmail(user: RegisteredUser): Promise<void> {
  expect(user.devVerificationUrl).toBeTruthy();
  const token = new URL(user.devVerificationUrl!).searchParams.get("token")!;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/verify-email",
    payload: { token },
  });
  expect(res.statusCode).toBe(200);
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function keyAuth(secret: string): Record<string, string> {
  return { "x-api-key": secret };
}

interface AgentReg {
  profile: any;
  secret: string;
  keyId: string;
}

async function registerAgent(owner: RegisteredUser, name: string): Promise<AgentReg> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/agents/register",
    headers: auth(owner.accessToken),
    payload: {
      handle: `${name}_${suffix()}`.slice(0, 24),
      display_name: `Agent ${name}`,
      purpose: "Phase 4 integration test agent",
      model_provider: "TestCo",
      model_name: "test-model-1",
      capabilities: ["posting", "voting"],
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { profile: body, secret: body.api_key.secret as string, keyId: body.api_key.id as string };
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ─── webhook receiver ────────────────────────────────────────────────────────
interface ReceivedHook {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
const received: ReceivedHook[] = [];
let receiverMode: "ok" | "flaky" = "ok";
let flakyFailuresLeft = 0;
let receiver: Server;
let receiverPort = 0;
let hookWorker: Worker;

beforeAll(async () => {
  app = await buildApp(config);
  receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      if (receiverMode === "flaky" && flakyFailuresLeft > 0) {
        flakyFailuresLeft -= 1;
        res.writeHead(500).end("boom");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  receiverPort = (receiver.address() as { port: number }).port;

  hookWorker = new Worker(
    WEBHOOK_QUEUE_NAME,
    async (job) => {
      if (job.name !== WEBHOOK_DELIVER_JOB) return;
      await attemptWebhookDelivery(db, config, job.data.deliveryId as string);
    },
    { connection: { url: config.REDIS_URL }, concurrency: 4 },
  );
  await hookWorker.waitUntilReady();
}, 60_000);

afterAll(async () => {
  await hookWorker?.close();
  receiver?.close();
  await app?.close();
  await closeDb();
});

describe("agent registration + directory", () => {
  it("registers an agent, returns the first key exactly once, lists it publicly", async () => {
    const owner = await registerUser("owner");
    const { profile, secret, keyId } = await registerAgent(owner, "scout");

    expect(secret.startsWith("gg_live_")).toBe(true);
    expect(keyId).toBeTruthy();
    expect(profile.purpose).toContain("integration test");
    expect(profile.owner.handle).toBe(owner.handle);
    expect(profile.kill_switch_engaged).toBe(false);
    expect(profile.rate_tier).toBe(0);
    expect(profile.auto_disclosure).toContain("AI agent account");
    expect(profile.api_key.scopes).toEqual(
      expect.arrayContaining(["read:feed", "write:post", "write:vote", "debate:participate"]),
    );

    // public directory + profile
    const dir = await app.inject({ method: "GET", url: "/api/v1/agents?limit=50" });
    expect(dir.statusCode).toBe(200);
    expect(dir.json().data.some((a: any) => a.handle === profile.handle)).toBe(true);
    const pub = await app.inject({ method: "GET", url: `/api/v1/agents/${profile.handle}` });
    expect(pub.statusCode).toBe(200);
    expect(pub.json().owner.handle).toBe(owner.handle);

    // human handles are not agent profiles
    const notAgent = await app.inject({ method: "GET", url: `/api/v1/agents/${owner.handle}` });
    expect(notAgent.statusCode).toBe(404);

    // duplicate handle → 409
    const dupe = await app.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      headers: auth(owner.accessToken),
      payload: { handle: profile.handle, display_name: "Dupe", purpose: "dupe" },
    });
    expect(dupe.statusCode).toBe(409);

    // an agent key cannot register further agents (human owners only)
    const byAgent = await app.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      headers: keyAuth(secret),
      payload: { handle: `nested_${suffix()}`, display_name: "Nested", purpose: "nope" },
    });
    expect(byAgent.statusCode).toBe(403);

    // owner can patch the disclosure fields; strangers cannot
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${profile.handle}`,
      headers: auth(owner.accessToken),
      payload: { purpose: "Updated purpose statement" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().purpose).toBe("Updated purpose statement");
    const stranger = await registerUser("stranger");
    const patchStranger = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${profile.handle}`,
      headers: auth(stranger.accessToken),
      payload: { purpose: "hijack" },
    });
    expect(patchStranger.statusCode).toBe(403);
  });
});

describe("api keys: auth, scopes, revocation", () => {
  it("key posts as the agent over both transports; scope denials are 403; revoke → 401", async () => {
    const owner = await registerUser("keyowner");
    await verifyEmail(owner);
    const { profile, secret } = await registerAgent(owner, "poster");

    // X-API-Key transport
    const post = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: keyAuth(secret),
      payload: { type: "TEXT", body: "hello from an agent key" },
    });
    expect(post.statusCode).toBe(201);
    expect(post.json().author.author_type).toBe("agent");
    expect(post.json().author.handle).toBe(profile.handle);

    // Bearer transport (TS SDK shape)
    const post2 = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: auth(secret),
      payload: { type: "TEXT", body: "bearer transport works too" },
    });
    expect(post2.statusCode).toBe(201);

    // poll the agent can vote in (min tier T0 so a fresh agent qualifies)
    const pollRes = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: auth(owner.accessToken),
      payload: {
        type: "POLL",
        body: "agent split check",
        poll: {
          question: "Do agents vote?",
          type: "single",
          result_mode: "live",
          min_trust_tier: "T0",
          options: [{ text: "Yes" }, { text: "No" }],
        },
      },
    });
    expect(pollRes.statusCode).toBe(201);
    const pollId = pollRes.json().poll.id as string;
    const optionId = pollRes.json().poll.options[0].id as string;

    const humanVote = await app.inject({
      method: "POST",
      url: `/api/v1/polls/${pollId}/votes`,
      headers: auth(owner.accessToken),
      payload: { option_id: optionId },
    });
    expect(humanVote.statusCode).toBe(200);
    const agentVote = await app.inject({
      method: "POST",
      url: `/api/v1/polls/${pollId}/votes`,
      headers: keyAuth(secret),
      payload: { option_id: optionId },
    });
    expect(agentVote.statusCode).toBe(200);
    const results = agentVote.json();
    const yes = (results.options as any[]).find((o) => o.id === optionId);
    expect(yes.human_votes).toBe(1);
    expect(yes.agent_votes).toBe(1);

    // narrow key: read:feed only → vote denied 403, feed allowed
    const narrow = await app.inject({
      method: "POST",
      url: "/api/v1/users/me/api-keys",
      headers: auth(owner.accessToken),
      payload: { agent_handle: profile.handle, name: "reader", scopes: ["read:feed"] },
    });
    expect(narrow.statusCode).toBe(201);
    const narrowSecret = narrow.json().secret as string;
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/polls/${pollId}/votes`,
      headers: keyAuth(narrowSecret),
      payload: { option_id: optionId },
    });
    expect(denied.statusCode).toBe(403);
    expect(JSON.stringify(denied.json())).toContain("write:vote");
    const feed = await app.inject({
      method: "GET",
      url: "/api/v1/feed",
      headers: keyAuth(narrowSecret),
    });
    expect(feed.statusCode).toBe(200);
    // rate-limit headers ride along on key-authenticated requests
    expect(feed.headers["ratelimit-limit"]).toBe("30");

    // a key cannot manage credentials (session required)
    const minted = await app.inject({
      method: "POST",
      url: "/api/v1/users/me/api-keys",
      headers: keyAuth(secret),
      payload: { name: "evil", scopes: ["read:feed"] },
    });
    expect(minted.statusCode).toBe(403);

    // revoke → 401 everywhere
    const keys = await app.inject({
      method: "GET",
      url: `/api/v1/users/me/api-keys?agent_handle=${profile.handle}`,
      headers: auth(owner.accessToken),
    });
    const main = (keys.json().data as any[]).find((k) => k.scopes.includes("write:vote"));
    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/v1/users/me/api-keys/${main.id}`,
      headers: auth(owner.accessToken),
    });
    expect(revoke.statusCode).toBe(204);
    const dead = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: keyAuth(secret),
      payload: { type: "TEXT", body: "should fail" },
    });
    expect(dead.statusCode).toBe(401);
  });

  it("rate limit: the (limit+1)th key request in a minute is a 429", async () => {
    const owner = await registerUser("rlowner");
    const { profile } = await registerAgent(owner, "limited");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/users/me/api-keys",
      headers: auth(owner.accessToken),
      payload: { agent_handle: profile.handle, name: "rl", scopes: ["read:feed"] },
    });
    const rlSecret = created.json().secret as string;
    let last = 0;
    for (let i = 0; i < 31; i += 1) {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/feed",
        headers: keyAuth(rlSecret),
      });
      last = res.statusCode;
      if (i < 30) expect(last).toBe(200);
    }
    expect(last).toBe(429);
  });
});

describe("kill switch + audit log", () => {
  it("engage kills keys and OAuth tokens; admin-only release; keys stay revoked; audit is owner-only", async () => {
    const owner = await registerUser("ksowner");
    await verifyEmail(owner);
    const { profile, secret, keyId } = await registerAgent(owner, "victim");
    const handle = profile.handle as string;

    // agent writes some history first
    const post = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: keyAuth(secret),
      payload: { type: "TEXT", body: "pre-kill post" },
    });
    expect(post.statusCode).toBe(201);
    const follow = await app.inject({
      method: "POST",
      url: `/api/v1/users/${owner.handle}/follow`,
      headers: keyAuth(secret),
    });
    expect(follow.statusCode).toBe(204);

    // OAuth client + token for this agent
    const client = await app.inject({
      method: "POST",
      url: "/api/v1/developers/oauth-clients",
      headers: auth(owner.accessToken),
      payload: { name: "ks client", redirect_uris: [], allowed_scopes: ["write:post"], is_confidential: true },
    });
    expect(client.statusCode).toBe(201);
    const grant = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      payload: {
        grant_type: "client_credentials",
        client_id: client.json().client_id,
        client_secret: client.json().client_secret,
        agent_handle: handle,
        scope: "write:post",
      },
    });
    expect(grant.statusCode).toBe(200);
    const oauthToken = grant.json().access_token as string;
    const viaOauth = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: auth(oauthToken),
      payload: { type: "TEXT", body: "via oauth" },
    });
    expect(viaOauth.statusCode).toBe(201);
    expect(viaOauth.json().author.author_type).toBe("agent");

    // audit log: owner sees the writes with key attribution; stranger 403
    const audit = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${handle}/audit-log`,
      headers: auth(owner.accessToken),
    });
    expect(audit.statusCode).toBe(200);
    const entries = audit.json().data as any[];
    const actions = entries.map((e) => e.action);
    expect(actions).toContain("post.create");
    expect(actions).toContain("user.follow");
    const postEntry = entries.find(
      (e) => e.action === "post.create" && e.metadata.auth_method === "api_key",
    );
    expect(postEntry).toBeTruthy();
    expect(postEntry.metadata.api_key_id).toBe(keyId);
    const oauthEntry = entries.find(
      (e) => e.action === "post.create" && e.metadata.auth_method === "oauth",
    );
    expect(oauthEntry).toBeTruthy();
    const stranger = await registerUser("audstranger");
    const auditStranger = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${handle}/audit-log`,
      headers: auth(stranger.accessToken),
    });
    expect(auditStranger.statusCode).toBe(403);

    // engage: stranger cannot; owner can
    const engageStranger = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${handle}/kill-switch`,
      headers: auth(stranger.accessToken),
      payload: { engaged: true },
    });
    expect(engageStranger.statusCode).toBe(403);
    const engage = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${handle}/kill-switch`,
      headers: auth(owner.accessToken),
      payload: { engaged: true, reason: "integration test" },
    });
    expect(engage.statusCode).toBe(200);
    expect(engage.json().kill_switch_engaged).toBe(true);

    const deadKey = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: keyAuth(secret),
      payload: { type: "TEXT", body: "zombie" },
    });
    expect(deadKey.statusCode).toBe(401);
    const deadOauth = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: auth(oauthToken),
      payload: { type: "TEXT", body: "zombie oauth" },
    });
    expect(deadOauth.statusCode).toBe(401);
    const grantWhileKilled = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      payload: {
        grant_type: "client_credentials",
        client_id: client.json().client_id,
        client_secret: client.json().client_secret,
        agent_handle: handle,
      },
    });
    expect(grantWhileKilled.statusCode).toBe(403);

    const pub = await app.inject({ method: "GET", url: `/api/v1/agents/${handle}` });
    expect(pub.json().kill_switch_engaged).toBe(true);

    // release: owner cannot (admin only); admin can
    const releaseOwner = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${handle}/kill-switch`,
      headers: auth(owner.accessToken),
      payload: { engaged: false },
    });
    expect(releaseOwner.statusCode).toBe(403);
    const adminUser = await registerUser("theadmin");
    await db.update(users).set({ platformRole: "admin" }).where(eq(users.id, adminUser.id));
    const release = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${handle}/kill-switch`,
      headers: auth(adminUser.accessToken),
      payload: { engaged: false },
    });
    expect(release.statusCode).toBe(200);
    expect(release.json().kill_switch_engaged).toBe(false);

    // old key stays revoked (no resurrection), a fresh key works
    const stillDead = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: keyAuth(secret),
      payload: { type: "TEXT", body: "still zombie" },
    });
    expect(stillDead.statusCode).toBe(401);
    const fresh = await app.inject({
      method: "POST",
      url: "/api/v1/users/me/api-keys",
      headers: auth(owner.accessToken),
      payload: { agent_handle: handle, name: "post-release", scopes: ["write:post"] },
    });
    const alive = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: keyAuth(fresh.json().secret as string),
      payload: { type: "TEXT", body: "back online" },
    });
    expect(alive.statusCode).toBe(201);

    // kill-switch transitions themselves are in the audit trail
    const audit2 = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${handle}/audit-log?limit=50`,
      headers: auth(owner.accessToken),
    });
    const actions2 = (audit2.json().data as any[]).map((e) => e.action);
    expect(actions2).toContain("agent.kill_switch.engage");
    expect(actions2).toContain("agent.kill_switch.release");
  });
});

describe("oauth client-credentials", () => {
  it("rejects bad secrets and unowned agents; granted scopes are the intersection", async () => {
    const owner = await registerUser("oauthowner");
    const other = await registerUser("oauthother");
    const { profile } = await registerAgent(owner, "grantme");
    const foreign = await registerAgent(other, "foreign");

    const client = await app.inject({
      method: "POST",
      url: "/api/v1/developers/oauth-clients",
      headers: auth(owner.accessToken),
      payload: { name: "c", redirect_uris: [], allowed_scopes: ["read:feed", "write:post"], is_confidential: true },
    });
    expect(client.statusCode).toBe(201);
    expect(client.json().client_id).toMatch(/^ggc_/);
    expect(client.json().client_secret).toMatch(/^ggcs_/);

    const badSecret = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      payload: {
        grant_type: "client_credentials",
        client_id: client.json().client_id,
        client_secret: "ggcs_wrong",
        agent_handle: profile.handle,
      },
    });
    expect(badSecret.statusCode).toBe(401);

    const unowned = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      payload: {
        grant_type: "client_credentials",
        client_id: client.json().client_id,
        client_secret: client.json().client_secret,
        agent_handle: foreign.profile.handle,
      },
    });
    expect(unowned.statusCode).toBe(403);

    // asks for write:vote (not in allowed_scopes) → invalid_scope rejection
    const overAsk = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload:
        `grant_type=client_credentials&client_id=${client.json().client_id}` +
        `&client_secret=${client.json().client_secret}&agent_handle=${profile.handle}` +
        `&scope=${encodeURIComponent("write:post write:vote")}`,
    });
    expect(overAsk.statusCode).toBe(403);
    // in-scope ask over the form transport succeeds
    const grant = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload:
        `grant_type=client_credentials&client_id=${client.json().client_id}` +
        `&client_secret=${client.json().client_secret}&agent_handle=${profile.handle}` +
        `&scope=${encodeURIComponent("write:post")}`,
    });
    expect(grant.statusCode).toBe(200);
    expect(grant.json().scope).toBe("write:post");
    const token = grant.json().access_token as string;

    const post = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: auth(token),
      payload: { type: "TEXT", body: "oauth post" },
    });
    expect(post.statusCode).toBe(201);
    const feedDenied = await app.inject({
      method: "GET",
      url: "/api/v1/feed",
      headers: auth(token),
    });
    expect(feedDenied.statusCode).toBe(403); // no read:feed in granted scopes
  });
});

describe("webhooks", () => {
  it("mention of the agent → signed delivery arrives, verifies, and is logged; test-ping works; retries recover", async () => {
    const owner = await registerUser("hookowner");
    const { profile } = await registerAgent(owner, "hooked");
    const handle = profile.handle as string;

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/users/me/webhooks",
      headers: auth(owner.accessToken),
      payload: {
        agent_handle: handle,
        url: `http://127.0.0.1:${receiverPort}/hook`,
        events: ["mention.created", "ping"],
      },
    });
    expect(created.statusCode).toBe(201);
    const hook = created.json();
    expect(hook.secret).toMatch(/^ggwh_/);
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/users/me/webhooks?agent_handle=${handle}`,
      headers: auth(owner.accessToken),
    });
    expect(list.json().data[0].secret).toBeUndefined();

    // a human mentions the agent
    const poster = await registerUser("mentioner");
    const post = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: auth(poster.accessToken),
      payload: { type: "TEXT", body: `hey @${handle} what do you think?` },
    });
    expect(post.statusCode).toBe(201);

    const delivery = await waitFor(async () => {
      const hit = received.find((r) => r.headers["x-gg-event"] === "mention.created");
      return hit ?? null;
    });
    const payload = JSON.parse(delivery.body);
    expect(payload.event).toBe("mention.created");
    expect(payload.data.mentioned_handle).toBe(handle);
    const signature = delivery.headers["x-gg-signature"] as string;
    expect(signature.startsWith("sha256=")).toBe(true);
    expect(verifyWebhookSignature(hook.secret, delivery.body, signature)).toBe(true);
    // independent recomputation, no shared code
    const expected =
      "sha256=" + createHmac("sha256", hook.secret).update(delivery.body).digest("hex");
    expect(signature).toBe(expected);

    const row = await waitFor(async () => {
      const rows = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.webhookId, hook.id));
      const delivered = rows.find((r) => r.event === "mention.created" && r.status === "delivered");
      return delivered ?? null;
    });
    expect(row.responseStatus).toBe(200);

    // test ping
    const ping = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/${hook.id}/test`,
      headers: auth(owner.accessToken),
    });
    expect(ping.statusCode).toBe(202);
    await waitFor(async () =>
      received.some((r) => r.headers["x-gg-event"] === "ping") ? true : null,
    );

    // retry path: receiver 500s twice, then accepts → delivered with attempts ≥ 3
    receiverMode = "flaky";
    flakyFailuresLeft = 2;
    const flakyHook = await app.inject({
      method: "POST",
      url: "/api/v1/users/me/webhooks",
      headers: auth(owner.accessToken),
      payload: {
        agent_handle: handle,
        url: `http://127.0.0.1:${receiverPort}/flaky`,
        events: ["ping"],
      },
    });
    const flakyId = flakyHook.json().id as string;
    const flakyPing = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/${flakyId}/test`,
      headers: auth(owner.accessToken),
    });
    expect(flakyPing.statusCode).toBe(202);
    const flakyRow = await waitFor(async () => {
      const rows = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.webhookId, flakyId));
      const done = rows.find((r) => r.status === "delivered");
      return done ?? null;
    }, 30_000);
    expect(flakyRow.attempts).toBeGreaterThanOrEqual(3);
    receiverMode = "ok";

    // deliveries endpoint exposes the log to the owner
    const log = await app.inject({
      method: "GET",
      url: `/api/v1/webhooks/${hook.id}/deliveries`,
      headers: auth(owner.accessToken),
    });
    expect(log.statusCode).toBe(200);
    expect((log.json().data as any[]).length).toBeGreaterThanOrEqual(2);
  }, 90_000);
});

describe("hide AI accounts filter", () => {
  it("following feed drops agent posts when the toggle is on", async () => {
    const owner = await registerUser("hideowner");
    const { profile, secret } = await registerAgent(owner, "hideme");
    const follow = await app.inject({
      method: "POST",
      url: `/api/v1/users/${profile.handle}/follow`,
      headers: auth(owner.accessToken),
    });
    expect(follow.statusCode).toBe(204);
    const post = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: keyAuth(secret),
      payload: { type: "TEXT", body: "agent post for hide test" },
    });
    expect(post.statusCode).toBe(201);
    const postId = post.json().id as string;

    const feedOn = await app.inject({
      method: "GET",
      url: "/api/v1/feed?tab=following",
      headers: auth(owner.accessToken),
    });
    expect((feedOn.json().data as any[]).some((p) => (p.post ?? p).id === postId)).toBe(true);

    const settings = await app.inject({
      method: "PATCH",
      url: "/api/v1/users/me/settings",
      headers: auth(owner.accessToken),
      payload: { hide_ai_accounts: true },
    });
    expect(settings.statusCode).toBe(200);
    const feedOff = await app.inject({
      method: "GET",
      url: "/api/v1/feed?tab=following",
      headers: auth(owner.accessToken),
    });
    expect((feedOff.json().data as any[]).some((p) => (p.post ?? p).id === postId)).toBe(false);
  });
});
