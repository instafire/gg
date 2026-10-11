/**
 * D-045 — an agent's effective trust tier for trust-gated checks is its
 * accountable owner's CURRENT tier, resolved at request time. Agents can
 * never verify an email, so without this every agent would sit at T0 and
 * be permanently barred from default (T1) polls — contradicting D-012.
 * Runs against gg_test (DATABASE_URL override).
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { loadConfig, loadDotEnv, type AppConfig } from "../src/config";
import { closeDb, getDb } from "../src/db";
import { pollVotes, users } from "../src/db/schema";

loadDotEnv();
const config: AppConfig = loadConfig();
const db = getDb(config.DATABASE_URL).db;

let app: FastifyInstance;
let counter = 0;

function suffix(): string {
  counter += 1;
  return `${counter.toString(36)}${randomBytes(3).toString("hex")}`;
}

interface RegisteredUser {
  accessToken: string;
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
  handle: string;
  id: string;
  secret: string;
}

async function registerAgent(owner: RegisteredUser, name: string): Promise<AgentReg> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/agents/register",
    headers: auth(owner.accessToken),
    payload: {
      handle: `${name}_${suffix()}`.slice(0, 24),
      display_name: `Agent ${name}`,
      purpose: "D-045 integration test agent",
      model_provider: "TestCo",
      model_name: "test-model-1",
      capabilities: ["posting", "voting"],
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return {
    handle: body.handle as string,
    id: body.user_id as string,
    secret: body.api_key.secret as string,
  };
}

/** A poll with NO explicit min_trust_tier — the spec default is T1. */
async function createDefaultPoll(owner: RegisteredUser): Promise<{ pollId: string; optionId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/posts",
    headers: auth(owner.accessToken),
    payload: {
      type: "POLL",
      body: "d045 default-tier poll",
      poll: {
        question: "Default tier gate?",
        type: "single",
        result_mode: "live",
        options: [{ text: "Yes" }, { text: "No" }],
      },
    },
  });
  expect(res.statusCode).toBe(201);
  const poll = res.json().poll;
  return { pollId: poll.id as string, optionId: poll.options[0].id as string };
}

function castVote(secret: string, pollId: string, optionId: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/polls/${pollId}/votes`,
    headers: keyAuth(secret),
    payload: { option_id: optionId },
  });
}

beforeAll(async () => {
  app = await buildApp(config);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await closeDb();
});

describe("D-045 agent effective trust tier", () => {
  it("agent of a T1 owner votes in a default (T1) poll; ballot lands in the agent split", async () => {
    const owner = await registerUser("t1owner");
    await verifyEmail(owner);
    const agent = await registerAgent(owner, "voter");
    const { pollId, optionId } = await createDefaultPoll(owner);

    const vote = await castVote(agent.secret, pollId, optionId);
    expect(vote.statusCode).toBe(200);
    const yes = (vote.json().options as any[]).find((o) => o.id === optionId);
    expect(yes.agent_votes).toBe(1);
    expect(yes.human_votes).toBe(0);

    // The ballot snapshot records the tier the ballot was admitted under,
    // while the agent's own stored tier is never rewritten.
    const [ballot] = await db
      .select()
      .from(pollVotes)
      .where(eq(pollVotes.pollId, pollId));
    expect(ballot?.voterTrustTier).toBe("T1");
    expect(ballot?.authorType).toBe("agent");
    const [agentRow] = await db.select().from(users).where(eq(users.id, agent.id));
    expect(agentRow?.trustTier).toBe("T0");
  });

  it("agent of a T0 owner is still gated from a default poll", async () => {
    const owner = await registerUser("t0owner");
    const agent = await registerAgent(owner, "gated");
    const { pollId, optionId } = await createDefaultPoll(owner);

    const vote = await castVote(agent.secret, pollId, optionId);
    expect(vote.statusCode).toBe(403);
    expect(JSON.stringify(vote.json())).toContain("trust tier T1");
  });

  it("owner promotion after registration applies at request time", async () => {
    const owner = await registerUser("promo");
    const agent = await registerAgent(owner, "late");
    const { pollId, optionId } = await createDefaultPoll(owner);

    const before = await castVote(agent.secret, pollId, optionId);
    expect(before.statusCode).toBe(403);

    await verifyEmail(owner);

    const after = await castVote(agent.secret, pollId, optionId);
    expect(after.statusCode).toBe(200);
    const yes = (after.json().options as any[]).find((o) => o.id === optionId);
    expect(yes.agent_votes).toBe(1);
  });

  it("kill-switched agent of a T1 owner is still rejected", async () => {
    const owner = await registerUser("ksowner2");
    await verifyEmail(owner);
    const agent = await registerAgent(owner, "doomed");
    const { pollId, optionId } = await createDefaultPoll(owner);

    const engage = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.handle}/kill-switch`,
      headers: auth(owner.accessToken),
      payload: { engaged: true, reason: "d045 test" },
    });
    expect(engage.statusCode).toBe(200);

    const vote = await castVote(agent.secret, pollId, optionId);
    expect(vote.statusCode).toBe(401);
  });

  it("scope check still binds: a read-only key is denied even with a T1 owner", async () => {
    const owner = await registerUser("scopeowner");
    await verifyEmail(owner);
    const agent = await registerAgent(owner, "reader");
    const { pollId, optionId } = await createDefaultPoll(owner);

    const narrow = await app.inject({
      method: "POST",
      url: "/api/v1/users/me/api-keys",
      headers: auth(owner.accessToken),
      payload: { agent_handle: agent.handle, name: "reader", scopes: ["read:feed"] },
    });
    expect(narrow.statusCode).toBe(201);
    const narrowSecret = narrow.json().secret as string;

    const vote = await castVote(narrowSecret, pollId, optionId);
    expect(vote.statusCode).toBe(403);
    expect(JSON.stringify(vote.json())).toContain("write:vote");
  });
});
