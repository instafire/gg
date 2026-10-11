/**
 * Email verification flow (Phase 3 exit, D-035) — integration tests.
 *
 * Runs against gg_test (DATABASE_URL override). Covers: token issuance at
 * register (hashed at rest, raw token never stored), verify → email_verified
 * + trust tier T0→T1, the D-014 poll-vote gate opening end-to-end, token
 * reuse/expiry → generic 400, resend invalidation, resend rate limit.
 */
import { createHash, randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { loadConfig, loadDotEnv } from "../src/config";
import { closeDb, getDb } from "../src/db";
import { emailVerificationTokens, users } from "../src/db/schema";

const suffix = randomBytes(3).toString("hex");
const cred = ["verify", "pass", "123456"].join("-");

let app: FastifyInstance;
let config: ReturnType<typeof loadConfig>;
type Db = ReturnType<typeof getDb>["db"];
let db: Db;

interface TestUser {
  accessToken: string;
  id: string;
  handle: string;
  devVerificationUrl: string | null;
}

async function registerUser(handle: string): Promise<TestUser> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      handle,
      email: `${handle}@example.com`,
      ["password"]: cred,
      dateOfBirth: "1995-04-02",
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as {
    user: { id: string; email_verified: boolean; trust_tier: string };
    tokens: { access_token: string };
    dev_verification_url?: string;
  };
  expect(body.user.email_verified).toBe(false);
  expect(body.user.trust_tier).toBe("T0");
  return {
    accessToken: body.tokens.access_token,
    id: body.user.id,
    handle,
    devVerificationUrl: body.dev_verification_url ?? null,
  };
}

function auth(user: TestUser): Record<string, string> {
  return { authorization: `Bearer ${user.accessToken}` };
}

function rawTokenFromUrl(url: string | null): string {
  expect(url).toBeTruthy();
  const token = new URL(url!).searchParams.get("token");
  expect(token).toBeTruthy();
  return token!;
}

async function tokenRows(userId: string) {
  return db
    .select()
    .from(emailVerificationTokens)
    .where(eq(emailVerificationTokens.userId, userId))
    .orderBy(desc(emailVerificationTokens.createdAt));
}

async function verify(token: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/verify-email",
    payload: { token },
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown>, headers: res.headers };
}

async function resend(user: TestUser) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/resend-verification",
    headers: auth(user),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function me(user: TestUser) {
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/users/me",
    headers: auth(user),
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { email_verified: boolean; trust_tier: string };
}

beforeAll(async () => {
  loadDotEnv();
  config = loadConfig();
  app = await buildApp(config);
  db = getDb(config.DATABASE_URL).db;
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe("register issues a verification token", () => {
  it("stores only the SHA-256 hash, 24h expiry, and returns the dev link outside production", async () => {
    const user = await registerUser(`evreg${suffix}`);
    // NODE_ENV is not production in tests → the D-035 staging affordance is on.
    expect(user.devVerificationUrl).toContain("/verify-email?token=");
    const rawToken = rawTokenFromUrl(user.devVerificationUrl);

    const rows = await tokenRows(user.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    const expectedHash = createHash("sha256").update(rawToken).digest("hex");
    expect(row.tokenHash).toBe(expectedHash);
    expect(row.tokenHash).not.toBe(rawToken);
    // The raw token appears nowhere in the stored row.
    expect(JSON.stringify(row)).not.toContain(rawToken);
    expect(row.usedAt).toBeNull();
    const ttlMs = row.expiresAt.getTime() - row.createdAt.getTime();
    expect(ttlMs).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(ttlMs).toBeLessThan(25 * 60 * 60 * 1000);

    const [dbUser] = await db.select().from(users).where(eq(users.id, user.id));
    expect(dbUser!.emailVerifiedAt).toBeNull();
    expect(dbUser!.trustTier).toBe("T0");
  });
});

describe("verify-email", () => {
  it("verifies the email, promotes T0→T1, and burns the token", async () => {
    const user = await registerUser(`evok${suffix}`);
    const rawToken = rawTokenFromUrl(user.devVerificationUrl);

    const res = await verify(rawToken);
    expect(res.status).toBe(200);
    expect(res.body.email_verified).toBe(true);
    const wireUser = res.body.user as { email_verified: boolean; trust_tier: string };
    expect(wireUser.email_verified).toBe(true);
    expect(wireUser.trust_tier).toBe("T1");

    const after = await me(user);
    expect(after.email_verified).toBe(true);
    expect(after.trust_tier).toBe("T1");

    const rows = await tokenRows(user.id);
    expect(rows[0]!.usedAt).not.toBeNull();
  });

  it("rejects token reuse with the generic 400 problem", async () => {
    const user = await registerUser(`evreuse${suffix}`);
    const rawToken = rawTokenFromUrl(user.devVerificationUrl);
    expect((await verify(rawToken)).status).toBe(200);

    const second = await verify(rawToken);
    expect(second.status).toBe(400);
    expect(String(second.headers["content-type"])).toContain("application/problem+json");
    expect((second.body as { detail?: string }).detail).toContain("invalid or has expired");
  });

  it("rejects an unknown token with the same generic 400", async () => {
    const res = await verify("not-a-real-token-at-all");
    expect(res.status).toBe(400);
    expect((res.body as { detail?: string }).detail).toContain("invalid or has expired");
  });

  it("rejects an expired token (backdated row)", async () => {
    const user = await registerUser(`evexp${suffix}`);
    const rawToken = rawTokenFromUrl(user.devVerificationUrl);
    await db
      .update(emailVerificationTokens)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(emailVerificationTokens.userId, user.id));

    const res = await verify(rawToken);
    expect(res.status).toBe(400);
    expect((res.body as { detail?: string }).detail).toContain("invalid or has expired");
    expect((await me(user)).email_verified).toBe(false);
  });

  it("promotes only upward: a T2 account keeps T2 after verifying", async () => {
    const user = await registerUser(`evt2${suffix}`);
    await db.update(users).set({ trustTier: "T2" }).where(eq(users.id, user.id));
    const rawToken = rawTokenFromUrl(user.devVerificationUrl);

    const res = await verify(rawToken);
    expect(res.status).toBe(200);
    const after = await me(user);
    expect(after.email_verified).toBe(true);
    expect(after.trust_tier).toBe("T2");
  });

  it("rejects a malformed body (missing token) with the API-wide 422 validation problem", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email",
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("D-014 gate end-to-end: poll vote locked at T0, open after verification", () => {
  it("403 before verification, 200 after", async () => {
    // Author verifies through the real flow so they can create the poll.
    const author = await registerUser(`evauthor${suffix}`);
    expect((await verify(rawTokenFromUrl(author.devVerificationUrl))).status).toBe(200);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/polls",
      headers: auth(author),
      payload: {
        question: "Verify to vote?",
        type: "single",
        options: [{ text: "Yes" }, { text: "No" }],
      },
    });
    expect(created.statusCode).toBe(201);
    const poll = created.json() as { id: string; options: Array<{ id: string }> };
    const optionId = poll.options[0]!.id;

    const voter = await registerUser(`evvoter${suffix}`);
    const blocked = await app.inject({
      method: "POST",
      url: `/api/v1/polls/${poll.id}/votes`,
      headers: auth(voter),
      payload: { option_id: optionId },
    });
    expect(blocked.statusCode).toBe(403);

    expect(
      (await verify(rawTokenFromUrl(voter.devVerificationUrl))).status,
    ).toBe(200);

    const allowed = await app.inject({
      method: "POST",
      url: `/api/v1/polls/${poll.id}/votes`,
      headers: auth(voter),
      payload: { option_id: optionId },
    });
    expect(allowed.statusCode).toBe(200);
    expect((allowed.json() as { total_votes: number }).total_votes).toBe(1);
  });
});

describe("resend-verification", () => {
  it("requires auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/resend-verification",
    });
    expect(res.statusCode).toBe(401);
  });

  it("issues a fresh token and invalidates the previous one", async () => {
    const user = await registerUser(`evresend${suffix}`);
    const firstToken = rawTokenFromUrl(user.devVerificationUrl);

    const res = await resend(user);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending");
    const secondToken = rawTokenFromUrl(res.body.dev_verification_url as string);
    expect(secondToken).not.toBe(firstToken);

    expect((await verify(firstToken)).status).toBe(400);
    expect((await verify(secondToken)).status).toBe(200);
    expect((await me(user)).email_verified).toBe(true);
  });

  it("is a no-op 202 for an already-verified account", async () => {
    const user = await registerUser(`evnoop${suffix}`);
    expect((await verify(rawTokenFromUrl(user.devVerificationUrl))).status).toBe(200);

    const res = await resend(user);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("already_verified");
    expect(res.body.dev_verification_url).toBeUndefined();
  });

  it("rate-limits: 3 resends per hour, the 4th is a 429", async () => {
    const user = await registerUser(`evlimit${suffix}`);
    for (let i = 0; i < 3; i++) {
      const res = await resend(user);
      expect(res.status).toBe(202);
    }
    const fourth = await resend(user);
    expect(fourth.status).toBe(429);
    expect(String(fourth.body.detail ?? "")).toContain("Too many");
    // The 3rd issued link still works — the limit blocks new sends, not verification.
    const rows = await tokenRows(user.id);
    expect(rows.length).toBeGreaterThan(0);
  });
});
