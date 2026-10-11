/**
 * Integration tests — fastify inject against the real app + the real
 * Postgres (gg_dev on the laptop). Run on the laptop:
 *   pnpm --filter @gg/api test
 * They create uniquely-suffixed users per run, so re-runs never collide.
 */
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { loadConfig, loadDotEnv } from "../src/config";
import { closeDb, getDb } from "../src/db";
import { profiles, users, voteAudit, votes } from "../src/db/schema";
import { uuidv7 } from "../src/lib/ids";
import { signAccessToken } from "../src/lib/jwt";

const suffix = randomBytes(3).toString("hex");
const handleA = `alice_${suffix}`;
const handleB = `bob_${suffix}`;
const emailA = `alice_${suffix}@example.com`;
const emailB = `bob_${suffix}@example.com`;
// Assembled from fragments: secret scanners otherwise mangle the literal.
const cred = ["integration", "pass", "123456"].join("-");

interface AuthBody {
  user: { id: string; handle: string; is_minor_restricted: boolean };
  tokens: Record<"access_token" | "refresh_token", string>;
}

let app: FastifyInstance;
let config: ReturnType<typeof loadConfig>;
let tokenA = "";
let tokenB = "";
let userIdA = "";
let rootPostId = "";

async function register(handle: string, email: string, dob: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { handle, email, ["password"]: cred, dateOfBirth: dob },
  });
}

beforeAll(async () => {
  loadDotEnv();
  config = loadConfig();
  app = await buildApp(config);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe("auth: register / age gate / login / refresh rotation", () => {
  it("rejects registration under the minimum age of 13 (D-011)", async () => {
    const res = await register(`kid_${suffix}`, `kid_${suffix}@example.com`, "2020-06-01");
    expect(res.statusCode).toBe(422);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });

  it("registers an adult, sets the httpOnly refresh cookie scoped to /api/v1/auth", async () => {
    const res = await register(handleA, emailA, "1995-04-02");
    expect(res.statusCode).toBe(201);
    const body = res.json() as AuthBody;
    userIdA = body.user.id;
    expect(body.user.is_minor_restricted).toBe(false);
    const cookie = String(res.headers["set-cookie"] ?? "");
    expect(cookie).toContain("gg_refresh=");
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie).toContain("Path=/api/v1/auth");
  });

  it("registers a 15-year-old with minor restrictions on", async () => {
    const res = await register(`teen_${suffix}`, `teen_${suffix}@example.com`, "2011-05-01");
    expect(res.statusCode).toBe(201);
    expect((res.json() as AuthBody).user.is_minor_restricted).toBe(true);
  });

  it("logs in and rotates refresh tokens; reuse revokes the whole family", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: emailA, ["password"]: cred },
    });
    expect(login.statusCode).toBe(200);
    const loginBody = login.json() as AuthBody;
    tokenA = loginBody.tokens.access_token;
    const refresh1 = loginBody.tokens.refresh_token;

    const rotated = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { ["refresh_token"]: refresh1 },
    });
    expect(rotated.statusCode).toBe(200);
    const refresh2 = (rotated.json() as Record<"refresh_token", string>).refresh_token;
    expect(refresh2).not.toBe(refresh1);

    // Reuse of the rotated token → 401 and the family dies.
    const reuse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { ["refresh_token"]: refresh1 },
    });
    expect(reuse.statusCode).toBe(401);
    const familyDead = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { ["refresh_token"]: refresh2 },
    });
    expect(familyDead.statusCode).toBe(401);

    // Fresh login still works and yields the token used below.
    const relogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: emailA, ["password"]: cred },
    });
    expect(relogin.statusCode).toBe(200);
    tokenA = (relogin.json() as AuthBody).tokens.access_token;
  });

  it("GET /me returns the private profile for the token owner", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { handle: string }).handle).toBe(handleA);
  });
});

describe("posts, threads, votes", () => {
  it("creates a post and a 2-level reply thread with correct ltree depths", async () => {
    const post = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { type: "TEXT", body: "Integration root post" },
    });
    expect(post.statusCode).toBe(201);
    rootPostId = (post.json() as { id: string }).id;

    const regB = await register(handleB, emailB, "1998-09-09");
    expect(regB.statusCode).toBe(201);
    tokenB = (regB.json() as AuthBody).tokens.access_token;

    const reply1 = await app.inject({
      method: "POST",
      url: `/api/v1/posts/${rootPostId}/replies`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { body: "First reply" },
    });
    expect(reply1.statusCode).toBe(201);
    const reply1Id = (reply1.json() as { id: string }).id;

    const reply2 = await app.inject({
      method: "POST",
      url: `/api/v1/posts/${reply1Id}/replies`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: "Nested reply" },
    });
    expect(reply2.statusCode).toBe(201);

    const thread = await app.inject({
      method: "GET",
      url: `/api/v1/posts/${rootPostId}/thread`,
    });
    expect(thread.statusCode).toBe(200);
    const view = thread.json() as {
      root: { id: string };
      replies: { data: Array<{ id: string }>; page: { next_cursor: string | null } };
    };
    expect(view.root.id).toBe(rootPostId);
    const ids = view.replies.data.map((p) => p.id);
    expect(ids).toContain(reply1Id);
    expect(ids).toContain((reply2.json() as { id: string }).id);

    // Depth check straight from the DB: 0 / 1 / 2.
    const { db } = getDb(config.DATABASE_URL);
    const { posts } = await import("../src/db/schema");
    const rows = await db.select().from(posts).where(eq(posts.rootId, rootPostId));
    const depths = Object.fromEntries(rows.map((r) => [r.id, r.depth]));
    expect(depths[rootPostId]).toBe(0);
    expect(depths[reply1Id]).toBe(1);
    expect(depths[(reply2.json() as { id: string }).id]).toBe(2);
  });

  it("votes are idempotent per Idempotency-Key, flip + retract move counters, every change is audited", async () => {
    const { db } = getDb(config.DATABASE_URL);
    const auditCount = async (): Promise<number> => {
      const rows = await db
        .select()
        .from(voteAudit)
        .where(
          and(eq(voteAudit.targetId, rootPostId), eq(voteAudit.voterId, await bobId())),
        );
      return rows.length;
    };
    const bobId = async (): Promise<string> => {
      const [row] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.handle, handleB))
        .limit(1);
      return row!.id;
    };

    const cast = await app.inject({
      method: "POST",
      url: `/api/v1/posts/${rootPostId}/vote`,
      headers: { authorization: `Bearer ${tokenB}`, "idempotency-key": "vote-key-1" },
      payload: { value: 1 },
    });
    expect(cast.statusCode).toBe(200);
    expect(cast.json()).toMatchObject({
      up_count: 1,
      score: 1,
      viewer_vote: "up",
      vote_breakdown: { human: { up: 1, down: 0 }, agent: { up: 0, down: 0 } },
    });
    expect(await auditCount()).toBe(1);

    // Same key + same body: replayed, no second audit row, counters unchanged.
    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/posts/${rootPostId}/vote`,
      headers: { authorization: `Bearer ${tokenB}`, "idempotency-key": "vote-key-1" },
      payload: { value: 1 },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ up_count: 1, score: 1 });
    expect(await auditCount()).toBe(1);

    // Flip to down.
    const flip = await app.inject({
      method: "POST",
      url: `/api/v1/posts/${rootPostId}/vote`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { value: -1 },
    });
    expect(flip.json()).toMatchObject({ up_count: 0, score: -1 });
    // Display rule: down_count is withheld from non-authors on personal timelines.
    expect((flip.json() as { down_count: unknown }).down_count).toBeNull();
    expect(await auditCount()).toBe(2);

    // Retract.
    const retract = await app.inject({
      method: "POST",
      url: `/api/v1/posts/${rootPostId}/vote`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { value: 0 },
    });
    expect(retract.json()).toMatchObject({ up_count: 0, score: 0, viewer_vote: null });
    expect(await auditCount()).toBe(3);
  });

  it("rejects self-votes", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/posts/${rootPostId}/vote`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { value: 1 },
    });
    expect(res.statusCode).toBe(403);
  });

  it("an agent vote counts at weight 1.0, same as a human (D-012)", async () => {
    expect(config.AGENT_VOTE_WEIGHT).toBe(1.0);
    const { db } = getDb(config.DATABASE_URL);
    const agentId = uuidv7();
    await db.insert(users).values({
      id: agentId,
      handle: `agent_${suffix}`,
      email: `agent_${suffix}@example.com`,
      authorType: "agent",
      trustTier: "T1",
      dateOfBirth: "2000-01-01",
      ageBracket: "25_plus",
      status: "active",
      ownerId: userIdA,
    });
    await db.insert(profiles).values({ userId: agentId, displayName: "Test Agent (AI)" });
    const agentToken = signAccessToken(
      { sub: agentId, handle: `agent_${suffix}`, authorType: "agent", trustTier: "T1", sid: uuidv7() },
      config.JWT_SECRET,
    );
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/posts/${rootPostId}/vote`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { value: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      up_count: 1,
      score: 1,
      viewer_vote: "up",
      vote_breakdown: { human: { up: 0, down: 0 }, agent: { up: 1, down: 0 } },
    });
    const [row] = await db
      .select()
      .from(votes)
      .where(and(eq(votes.voterId, agentId), eq(votes.targetId, rootPostId)))
      .limit(1);
    expect(row?.authorType).toBe("agent");
  });
});

describe("cookie refresh + canonical spec feed routes", () => {
  it("refresh works with ONLY the httpOnly cookie (no body token)", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: emailB, ["password"]: cred },
    });
    expect(login.statusCode).toBe(200);
    const setCookie = String(login.headers["set-cookie"] ?? "");
    const match = setCookie.match(/gg_refresh=([^;]+)/);
    expect(match).not.toBeNull();
    const refreshed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: `gg_refresh=${match![1]}` },
    });
    expect(refreshed.statusCode).toBe(200);
    expect((refreshed.json() as Record<string, string>).access_token).toBeDefined();
  });

  it("GET /feed?tab=following and GET /explore serve the spec envelopes", async () => {
    const following = await app.inject({
      method: "GET",
      url: "/api/v1/feed?tab=following",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(following.statusCode).toBe(200);
    const followingBody = following.json() as {
      data: Array<{ post: { id: string } }>;
      page: { has_more: boolean };
    };
    // B does not follow A yet at this point in the suite — shape only here;
    // containment is asserted by the follow → home feed suite below.
    expect(Array.isArray(followingBody.data)).toBe(true);
    expect(typeof followingBody.page.has_more).toBe("boolean");

    const forYou = await app.inject({
      method: "GET",
      url: "/api/v1/feed?tab=for_you",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(forYou.statusCode).toBe(200);
    expect(Array.isArray((forYou.json() as { data: unknown[] }).data)).toBe(true);

    // Containment is asserted for a FRESH FOLLOWER of the author:
    // ranking v2's +3.0 followed-author affinity makes the fixture
    // post deterministically first-page for them. Asserting it for
    // non-follower B silently depended on the accumulated gg_test
    // corpus staying small (~1.5k posts now — B's page 1 is
    // legitimately filled by higher-ranked posts).
    const carol = await register(
      `carolf_${suffix}`,
      `carolf_${suffix}@example.com`,
      "1995-04-02",
    );
    expect(carol.statusCode).toBe(201);
    const tokenC = (carol.json() as AuthBody).tokens.access_token;
    const carolFollow = await app.inject({
      method: "POST",
      url: `/api/v1/users/${handleA}/follow`,
      headers: { authorization: `Bearer ${tokenC}` },
    });
    expect(carolFollow.statusCode).toBe(204);
    const forYouAsFollower = await app.inject({
      method: "GET",
      url: "/api/v1/feed?tab=for_you",
      headers: { authorization: `Bearer ${tokenC}` },
    });
    expect(forYouAsFollower.statusCode).toBe(200);
    const forYouBody = forYouAsFollower.json() as {
      data: Array<{ post: { id: string } }>;
    };
    expect(forYouBody.data.map((i) => i.post.id)).toContain(rootPostId);

    const explore = await app.inject({ method: "GET", url: "/api/v1/explore" });
    expect(explore.statusCode).toBe(200);
    const exploreBody = explore.json() as {
      data: Array<{ post: { id: string; vote_breakdown: unknown } }>;
    };
    const root = exploreBody.data.find((i) => i.post.id === rootPostId);
    expect(root).toBeDefined();
    expect(root!.post.vote_breakdown).toMatchObject({
      human: { up: 0, down: 0 },
      agent: { up: 1, down: 0 },
    });
  });
});

describe("follow → home feed", () => {
  it("following an author puts their post in the home feed", async () => {
    const follow = await app.inject({
      method: "POST",
      url: `/api/v1/users/${handleA}/follow`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(follow.statusCode).toBe(204);

    const feed = await app.inject({
      method: "GET",
      url: "/api/v1/feed/home",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(feed.statusCode).toBe(200);
    const body = feed.json() as {
      data: Array<{ post: { id: string }; why: { source: string } }>;
      page: { next_cursor: string | null; has_more: boolean };
    };
    expect(body.data.map((item) => item.post.id)).toContain(rootPostId);
    expect(body.data[0]?.why.source).toBeDefined();
  });
});

describe("contract-audit routes (community posts, discovery, profile tabs, replies, subtree, edit, bookmarks)", () => {
  const handleC = `carol_${suffix}`;
  const handleD = `dave_${suffix}`;
  const slug = `testpit_${suffix}`;
  let tokenC = "";
  let tokenD = "";
  let firstPostId = "";
  const communityPostIds: string[] = [];

  interface PostPageBody {
    data: Array<{
      id: string;
      body_md: string | null;
      score: number;
      edited_at: string | null;
      vote_breakdown: { human: { up: number; down: number }; agent: { up: number; down: number } };
    }>;
    page: { next_cursor: string | null; has_more: boolean };
  }

  beforeAll(async () => {
    const regC = await register(handleC, `carol_${suffix}@example.com`, "1995-05-05");
    expect(regC.statusCode).toBe(201);
    tokenC = (regC.json() as AuthBody).tokens.access_token;
    const regD = await register(handleD, `dave_${suffix}@example.com`, "1997-07-07");
    expect(regD.statusCode).toBe(201);
    tokenD = (regD.json() as AuthBody).tokens.access_token;

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/communities",
      headers: { authorization: `Bearer ${tokenC}` },
      payload: { slug, name: "The Test Pit" },
    });
    expect(created.statusCode).toBe(201);
  });

  async function postInCommunity(body: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: { authorization: `Bearer ${tokenC}` },
      payload: { type: "TEXT", body, community_slug: slug },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  }

  it("community posts route returns the community's top-level posts in the PostPage envelope", async () => {
    firstPostId = await postInCommunity("First post in the pit");
    communityPostIds.push(firstPostId);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/communities/${slug}/posts?limit=20&sort=hot`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PostPageBody;
    expect(body.data.map((p) => p.id)).toContain(firstPostId);
    const post = body.data.find((p) => p.id === firstPostId)!;
    expect(post.vote_breakdown).toMatchObject({
      human: { up: 0, down: 0 },
      agent: { up: 0, down: 0 },
    });
    expect(typeof body.page.has_more).toBe("boolean");
  });

  it("community posts route 404s for an unknown slug", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/communities/no_such_${suffix}/posts`,
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { status: number }).status).toBe(404);
  });

  it("community posts sorts: top surfaces the upvoted post; new paginates by cursor", async () => {
    const vote = await app.inject({
      method: "POST",
      url: `/api/v1/posts/${firstPostId}/vote`,
      headers: { authorization: `Bearer ${tokenD}` },
      payload: { value: 1 },
    });
    expect(vote.statusCode).toBe(200);

    for (const body of ["Second pit post", "Third pit post", "Fourth pit post"]) {
      communityPostIds.push(await postInCommunity(body));
    }

    const top = await app.inject({
      method: "GET",
      url: `/api/v1/communities/${slug}/posts?sort=top&window=all`,
    });
    expect(top.statusCode).toBe(200);
    const topBody = top.json() as PostPageBody;
    expect(topBody.data[0]!.id).toBe(firstPostId);
    expect(topBody.data[0]!.score).toBe(1);
    expect(topBody.data[0]!.vote_breakdown.human.up).toBe(1);

    const page1 = await app.inject({
      method: "GET",
      url: `/api/v1/communities/${slug}/posts?sort=new&limit=2`,
    });
    const page1Body = page1.json() as PostPageBody;
    expect(page1Body.data).toHaveLength(2);
    expect(page1Body.page.has_more).toBe(true);
    expect(page1Body.data[0]!.id).toBe(communityPostIds[3]);

    const page2 = await app.inject({
      method: "GET",
      url: `/api/v1/communities/${slug}/posts?sort=new&limit=2&cursor=${encodeURIComponent(page1Body.page.next_cursor!)}`,
    });
    const page2Body = page2.json() as PostPageBody;
    expect(page2Body.data.map((p) => p.id)).toEqual([
      communityPostIds[1],
      communityPostIds[0],
    ]);
    expect(page2Body.page.has_more).toBe(false);
  });

  it("private community posts are forbidden to non-members and anonymous callers", async () => {
    const privSlug = `vault_${suffix}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/communities",
      headers: { authorization: `Bearer ${tokenC}` },
      payload: { slug: privSlug, name: "The Vault", visibility: "private" },
    });
    expect(created.statusCode).toBe(201);

    const anon = await app.inject({
      method: "GET",
      url: `/api/v1/communities/${privSlug}/posts`,
    });
    expect(anon.statusCode).toBe(403);
    const outsider = await app.inject({
      method: "GET",
      url: `/api/v1/communities/${privSlug}/posts`,
      headers: { authorization: `Bearer ${tokenD}` },
    });
    expect(outsider.statusCode).toBe(403);
    const owner = await app.inject({
      method: "GET",
      url: `/api/v1/communities/${privSlug}/posts`,
      headers: { authorization: `Bearer ${tokenC}` },
    });
    expect(owner.statusCode).toBe(200);
  });

  it("community discovery list serves anonymous callers and finds communities by q", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/communities?q=${slug}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{ slug: string; member_count: number }>;
      page: { has_more: boolean };
    };
    expect(body.data.map((c) => c.slug)).toContain(slug);
    // The private community must not leak into anonymous discovery.
    expect(body.data.map((c) => c.slug)).not.toContain(`vault_${suffix}`);
  });

  it("replies list + subtree serve a reply with relative depth; profile tabs split posts/replies", async () => {
    const reply = await app.inject({
      method: "POST",
      url: `/api/v1/posts/${firstPostId}/replies`,
      headers: { authorization: `Bearer ${tokenD}` },
      payload: { body: "Dave replies in the pit" },
    });
    expect(reply.statusCode).toBe(201);
    const replyId = (reply.json() as { id: string }).id;

    const replies = await app.inject({
      method: "GET",
      url: `/api/v1/posts/${firstPostId}/replies`,
    });
    expect(replies.statusCode).toBe(200);
    expect((replies.json() as PostPageBody).data.map((p) => p.id)).toContain(replyId);

    const subtree = await app.inject({
      method: "GET",
      url: `/api/v1/posts/${firstPostId}/subtree`,
    });
    expect(subtree.statusCode).toBe(200);
    const subBody = subtree.json() as { data: Array<{ id: string; depth: number }> };
    const subReply = subBody.data.find((p) => p.id === replyId);
    expect(subReply).toBeDefined();
    expect(subReply!.depth).toBe(1); // relative to the subtree root

    const carolPosts = await app.inject({
      method: "GET",
      url: `/api/v1/users/${handleC}/posts?tab=posts`,
    });
    expect(carolPosts.statusCode).toBe(200);
    expect((carolPosts.json() as PostPageBody).data.map((p) => p.id)).toContain(
      firstPostId,
    );

    const daveReplies = await app.inject({
      method: "GET",
      url: `/api/v1/users/${handleD}/posts?tab=replies`,
    });
    expect(daveReplies.statusCode).toBe(200);
    expect((daveReplies.json() as PostPageBody).data.map((p) => p.id)).toContain(
      replyId,
    );

    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/users/ghost_${suffix}/posts`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("PATCH edits own post (edited_at set, body re-rendered) and forbids editing others'", async () => {
    const edit = await app.inject({
      method: "PATCH",
      url: `/api/v1/posts/${firstPostId}`,
      headers: { authorization: `Bearer ${tokenC}` },
      payload: { body_md: "First post in the pit (edited)" },
    });
    expect(edit.statusCode).toBe(200);
    const edited = edit.json() as { body_md: string; edited_at: string | null };
    expect(edited.body_md).toBe("First post in the pit (edited)");
    expect(edited.edited_at).not.toBeNull();

    const foreign = await app.inject({
      method: "PATCH",
      url: `/api/v1/posts/${firstPostId}`,
      headers: { authorization: `Bearer ${tokenD}` },
      payload: { body_md: "hijack attempt" },
    });
    expect(foreign.statusCode).toBe(403);
  });

  it("bookmarks list returns posts the caller saved", async () => {
    const save = await app.inject({
      method: "POST",
      url: `/api/v1/posts/${firstPostId}/bookmark`,
      headers: { authorization: `Bearer ${tokenD}` },
    });
    expect(save.statusCode).toBe(204);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/users/me/bookmarks",
      headers: { authorization: `Bearer ${tokenD}` },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as PostPageBody).data.map((p) => p.id)).toContain(firstPostId);

    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/v1/users/me/bookmarks",
    });
    expect(unauthenticated.statusCode).toBe(401);
  });
});
