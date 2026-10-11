/**
 * Integration tests — PostCreate contract (Phase 1 exit round).
 *
 * API_SPEC PostCreate promises parent_id / quoted_post_id / repost_of_id on
 * POST /api/v1/posts ("one endpoint covers all content"), but the route's
 * zod schema omitted all three and silently stripped them: web replies
 * persisted as root posts (no thread, no reply notification) and reposts
 * failed outright. These tests pin the contract.
 *
 * Same harness as the other integration suites; run on the laptop with
 * DATABASE_URL pointed at gg_test.
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { loadConfig, loadDotEnv } from "../src/config";
import { closeDb, getDb } from "../src/db";
import { notifications, posts } from "../src/db/schema";

const suffix = randomBytes(3).toString("hex");
// Assembled from fragments: secret scanners otherwise mangle the literal.
const cred = ["integration", "pass", "123456"].join("-");

interface Session {
  handle: string;
  userId: string;
  token: string;
}

let app: FastifyInstance;

async function registerUser(label: string): Promise<Session> {
  const handle = `${label}_${suffix}`;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      handle,
      email: `${handle}@example.com`,
      ["password"]: cred,
      dateOfBirth: "1996-03-04",
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as {
    user: { id: string };
    tokens: { access_token: string };
  };
  return { handle, userId: body.user.id, token: body.tokens.access_token };
}

function auth(session: Session) {
  return { authorization: `Bearer ${session.token}` };
}

async function createViaPostsEndpoint(
  session: Session,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/posts",
    headers: auth(session),
    payload,
  });
}

function db() {
  return getDb(loadConfig().DATABASE_URL).db;
}

beforeAll(async () => {
  loadDotEnv();
  app = await buildApp(loadConfig());
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe("CORS preflight allows the full write surface", () => {
  it("OPTIONS permits PUT, PATCH and DELETE for an allowed origin", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/api/v1/posts/00000000-0000-4000-8000-000000000000/vote",
        headers: {
          // The config default origin (CORS_ORIGINS default "http://localhost:3000").
          origin: "http://localhost:3000",
          "access-control-request-method": method,
          "access-control-request-headers":
            "authorization,content-type,idempotency-key",
        },
      });
      expect(res.statusCode).toBe(204);
      const allowed = res.headers["access-control-allow-methods"] as string;
      expect(allowed).toContain(method);
    }
  });
});

describe("POST /posts contract: parent_id, quoted_post_id, repost_of_id", () => {
  it("parent_id creates a real reply (thread linkage + reply notification)", async () => {
    const author = await registerUser("cc_author");
    const replier = await registerUser("cc_replier");

    const root = await createViaPostsEndpoint(author, {
      type: "TEXT",
      body_md: "contract root post",
    });
    expect(root.statusCode).toBe(201);
    const rootId = (root.json() as { id: string }).id;

    const reply = await createViaPostsEndpoint(replier, {
      type: "TEXT",
      body_md: "contract reply via parent_id",
      parent_id: rootId,
    });
    expect(reply.statusCode).toBe(201);
    const replyBody = reply.json() as {
      id: string;
      parent_id: string | null;
      root_id: string;
      depth: number;
    };
    expect(replyBody.parent_id).toBe(rootId);
    expect(replyBody.root_id).toBe(rootId);
    expect(replyBody.depth).toBe(1);

    // The thread endpoint shows the reply nested under the root.
    const thread = await app.inject({
      method: "GET",
      url: `/api/v1/posts/${rootId}/thread`,
      headers: auth(author),
    });
    expect(thread.statusCode).toBe(200);
    const threadBody = thread.json() as {
      replies: { data: Array<{ id: string }> };
    };
    expect(threadBody.replies.data.map((r) => r.id)).toContain(replyBody.id);

    // And the reply notification reached the root author.
    const rows = await db()
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, author.userId));
    const replyNotifs = rows.filter(
      (r) => r.type === "reply" && r.subjectId === replyBody.id,
    );
    expect(replyNotifs).toHaveLength(1);
  });

  it("repost_of_id creates an empty-body repost and bumps repost_count", async () => {
    const author = await registerUser("cc_rp_author");
    const reposter = await registerUser("cc_rp_fan");
    const root = await createViaPostsEndpoint(author, {
      type: "TEXT",
      body_md: "repost this take",
    });
    const rootId = (root.json() as { id: string }).id;

    const repost = await createViaPostsEndpoint(reposter, {
      type: "TEXT",
      body_md: "",
      repost_of_id: rootId,
    });
    expect(repost.statusCode).toBe(201);
    const [row] = await db()
      .select()
      .from(posts)
      .where(eq(posts.id, rootId))
      .limit(1);
    expect(row!.repostCount).toBe(1);
    const [rpRow] = await db()
      .select()
      .from(posts)
      .where(eq(posts.id, (repost.json() as { id: string }).id))
      .limit(1);
    expect(rpRow!.repostOfId).toBe(rootId);
  });

  it("quoted_post_id links the quote and bumps quote_count", async () => {
    const author = await registerUser("cc_q_author");
    const quoter = await registerUser("cc_q_fan");
    const root = await createViaPostsEndpoint(author, {
      type: "TEXT",
      body_md: "quote this take",
    });
    const rootId = (root.json() as { id: string }).id;

    const quote = await createViaPostsEndpoint(quoter, {
      type: "TEXT",
      body_md: "my response to the take",
      quoted_post_id: rootId,
    });
    expect(quote.statusCode).toBe(201);
    const [row] = await db()
      .select()
      .from(posts)
      .where(eq(posts.id, rootId))
      .limit(1);
    expect(row!.quoteCount).toBe(1);
    const [qRow] = await db()
      .select()
      .from(posts)
      .where(eq(posts.id, (quote.json() as { id: string }).id))
      .limit(1);
    expect(qRow!.quotedPostId).toBe(rootId);
  });

  it("unknown parent_id is a 404, not a silent root post", async () => {
    const user = await registerUser("cc_orphan");
    const res = await createViaPostsEndpoint(user, {
      type: "TEXT",
      body_md: "reply to nothing",
      parent_id: "01900000-0000-7000-8000-000000000000",
    });
    expect(res.statusCode).toBe(404);
  });
});
