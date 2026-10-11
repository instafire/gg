import { describe, expect, it, vi } from "vitest";
import { GGApiError, GGClient } from "../src/index";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/** A fetch stub that routes by "METHOD /path" and records every call. */
function stubFetch(routes: Record<string, (call: RecordedCall) => Response>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = vi.fn<FetchFn>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const call: RecordedCall = {
      url,
      method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const handler = routes[`${method} ${path}`] ?? routes[method];
    if (!handler) return jsonResponse({ title: "Not Found", detail: `no route ${method} ${path}` }, 404);
    return handler(call);
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function makeClient(routes: Record<string, (call: RecordedCall) => Response>) {
  const stub = stubFetch(routes);
  const client = new GGClient({ baseUrl: "http://localhost:4000", fetchImpl: stub.fetchImpl });
  return { client, calls: stub.calls };
}

const tokenPairWire = {
  access_token: "access-1",
  refresh_token: "refresh-1",
  token_type: "Bearer",
  expires_in: 900,
};

const userPrivateWire = {
  id: "01921f2e-7b6d-7c8f-9a0b-1c2d3e4f5a6b",
  handle: "aman",
  email: "aman@example.com",
  email_verified: true,
  author_type: "human",
  trust_tier: "T1",
  age_bracket: "25_plus",
  status: "active",
  profile: {
    user_id: "01921f2e-7b6d-7c8f-9a0b-1c2d3e4f5a6b",
    handle: "aman",
    display_name: "Aman H",
    bio: "building GG",
    avatar_url: null,
    banner_url: null,
    author_type: "human",
    trust_tier: "T1",
    is_private: false,
    follower_count: 12,
    following_count: 34,
  },
};

const postWire = {
  id: "01921f2e-7b6d-7c8f-9a0b-1c2d3e4f5a6c",
  short_code: "abc123",
  type: "TEXT",
  author: {
    id: "01921f2e-7b6d-7c8f-9a0b-1c2d3e4f5a6d",
    handle: "botty",
    display_name: "Botty",
    avatar_url: null,
    author_type: "agent",
    trust_tier: "T2",
    is_verified_agent: true,
  },
  author_type: "agent",
  parent_id: null,
  root_id: "01921f2e-7b6d-7c8f-9a0b-1c2d3e4f5a6c",
  depth: 0,
  body_md: "hot take https://example.com #gg",
  community: { id: "c1", slug: "tech", name: "Tech" },
  media: [],
  visibility: "public",
  is_nsfw: false,
  is_spoiler: false,
  up_count: 10,
  down_count: 3,
  score: 7,
  reply_count: 4,
  repost_count: 1,
  quote_count: 0,
  view_count: 99,
  created_at: "2026-10-10T12:00:00Z",
  edited_at: null,
  deleted_at: null,
  viewer_state: { vote: "up", bookmarked: true },
  vote_breakdown: { human: { up: 6, down: 2 }, agent: { up: 4, down: 1 } },
};

describe("auth", () => {
  it("register() posts the spec wire body and stores the returned tokens", async () => {
    const { client, calls } = makeClient({
      "POST /api/v1/auth/register": () =>
        jsonResponse({ user: userPrivateWire, tokens: tokenPairWire }, 201),
    });

    const result = await client.register({
      handle: "aman",
      email: "aman@example.com",
      password: "correct horse battery",
      displayName: "Aman H",
      dateOfBirth: "1999-05-01",
    });

    expect(calls[0]?.url).toBe("http://localhost:4000/api/v1/auth/register");
    expect(calls[0]?.body).toMatchObject({
      handle: "aman",
      display_name: "Aman H",
      date_of_birth: "1999-05-01",
    });
    expect(calls[0]?.headers.get("idempotency-key")).toBeTruthy();
    expect(result.user?.handle).toBe("aman");
    expect(result.user?.profile.followerCount).toBe(12);
    expect(result.totpRequired).toBe(false);
    expect(client.getAccessToken()).toBe("access-1");
  });

  it("login() then me() sends the bearer token and normalizes the profile", async () => {
    const { client, calls } = makeClient({
      "POST /api/v1/auth/login": () =>
        jsonResponse({ user: userPrivateWire, tokens: tokenPairWire }),
      "GET /api/v1/users/me": () => jsonResponse(userPrivateWire),
    });

    await client.login({ email: "aman@example.com", password: "pw" });
    const me = await client.me();

    const meCall = calls.find((c) => c.url.endsWith("/users/me"));
    expect(meCall?.headers.get("authorization")).toBe("Bearer access-1");
    expect(meCall?.headers.get("credentials") ?? meCall).toBeTruthy();
    expect(me.email).toBe("aman@example.com");
    expect(me.trustTier).toBe("T1");
    expect(me.profile.displayName).toBe("Aman H");
  });

  it("refresh() presents the in-memory refresh token and rotates the pair", async () => {
    const { client, calls } = makeClient({
      "POST /api/v1/auth/login": () =>
        jsonResponse({ user: userPrivateWire, tokens: tokenPairWire }),
      "POST /api/v1/auth/refresh": () =>
        jsonResponse({ ...tokenPairWire, access_token: "access-2", refresh_token: "refresh-2" }),
    });

    await client.login({ email: "aman@example.com", password: "pw" });
    const pair = await client.refresh();

    const refreshCall = calls.find((c) => c.url.endsWith("/auth/refresh"));
    expect(refreshCall?.body).toEqual({ refresh_token: "refresh-1" });
    expect(pair.accessToken).toBe("access-2");
    expect(client.getAccessToken()).toBe("access-2");
  });

  it("retries once after a 401 by refreshing the session", async () => {
    let meAttempts = 0;
    const { client } = makeClient({
      "POST /api/v1/auth/login": () =>
        jsonResponse({ user: userPrivateWire, tokens: tokenPairWire }),
      "POST /api/v1/auth/refresh": () =>
        jsonResponse({ ...tokenPairWire, access_token: "access-2" }),
      "GET /api/v1/users/me": () => {
        meAttempts += 1;
        return meAttempts === 1
          ? jsonResponse({ title: "Unauthorized", detail: "token expired" }, 401)
          : jsonResponse(userPrivateWire);
      },
    });

    await client.login({ email: "aman@example.com", password: "pw" });
    const me = await client.me();
    expect(me.handle).toBe("aman");
    expect(meAttempts).toBe(2);
    expect(client.getAccessToken()).toBe("access-2");
  });

  it("logout() clears the in-memory tokens", async () => {
    const { client } = makeClient({
      "POST /api/v1/auth/login": () =>
        jsonResponse({ user: userPrivateWire, tokens: tokenPairWire }),
      "POST /api/v1/auth/logout": () => new Response(null, { status: 204 }),
    });

    await client.login({ email: "aman@example.com", password: "pw" });
    await client.logout();
    expect(client.getAccessToken()).toBeNull();
  });

  it("surfaces problem+json code and field errors on GGApiError", async () => {
    const { client } = makeClient({
      "POST /api/v1/auth/register": () =>
        jsonResponse(
          {
            type: "about:blank",
            title: "Validation failed",
            status: 422,
            detail: "handle is taken",
            code: "user.handle_taken",
            request_id: "req-1",
            errors: [{ field: "handle", message: "is taken" }],
          },
          422,
        ),
    });

    const error = await client
      .register({ handle: "aman", email: "a@b.co", password: "x".repeat(12), dateOfBirth: "2000-01-01" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GGApiError);
    const apiError = error as GGApiError;
    expect(apiError.status).toBe(422);
    expect(apiError.detail).toBe("handle is taken");
    expect(apiError.code).toBe("user.handle_taken");
    expect(apiError.fieldErrors).toEqual([{ field: "handle", message: "is taken" }]);
    expect(apiError.message).toBe("GG API 422: handle is taken");
  });
});

describe("feeds and posts", () => {
  it("getFeed() unwraps feed items and normalizes posts + pagination envelope", async () => {
    const { client, calls } = makeClient({
      "GET /api/v1/feed?tab=for_you": () =>
        jsonResponse({
          data: [{ post: postWire, why: { source: "followed", reasons: ["You follow @botty"] } }],
          page: { next_cursor: "cursor-2", has_more: true },
        }),
    });

    const page = await client.getFeed({ tab: "for_you" });
    expect(calls[0]?.url).toBe("http://localhost:4000/api/v1/feed?tab=for_you");
    expect(page.nextCursor).toBe("cursor-2");
    expect(page.items).toHaveLength(1);
    const post = page.items[0];
    expect(post?.body).toBe("hot take https://example.com #gg");
    expect(post?.upCount).toBe(10);
    expect(post?.downCount).toBe(3);
    expect(post?.score).toBe(7);
    expect(post?.author.authorType).toBe("agent");
    expect(post?.author.isAgentBadge).toBe(true);
    expect(post?.viewerVote).toBe("up");
    expect(post?.viewerBookmarked).toBe(true);
    expect(post?.voteBreakdown).toEqual({ humanUp: 6, humanDown: 2, agentUp: 4, agentDown: 1 });
    expect(post?.whyReasons).toEqual(["You follow @botty"]);
    expect(post?.community?.slug).toBe("tech");
  });

  it("createPost() serializes to the spec wire format with an idempotency key", async () => {
    const { client, calls } = makeClient({
      "POST /api/v1/posts": () => jsonResponse(postWire, 201),
    });

    const created = await client.createPost({ body: "hello", parentId: "p-1", communitySlug: "tech" });
    expect(calls[0]?.body).toMatchObject({
      type: "TEXT",
      body_md: "hello",
      parent_id: "p-1",
      community_slug: "tech",
    });
    expect(calls[0]?.headers.get("idempotency-key")).toBeTruthy();
    expect(created.id).toBe(postWire.id);
  });

  it("voteOnPost() PUTs the value with an idempotency key and maps the summary", async () => {
    const { client, calls } = makeClient({
      [`PUT /api/v1/posts/${postWire.id}/vote`]: () =>
        jsonResponse({
          up_count: 11,
          down_count: 3,
          score: 8,
          viewer_vote: "up",
          vote_breakdown: { human_up: 7, human_down: 2, agent_up: 4, agent_down: 1 },
        }),
    });

    const summary = await client.voteOnPost(postWire.id, "up");
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.body).toEqual({ value: "up" });
    expect(calls[0]?.headers.get("idempotency-key")).toBeTruthy();
    expect(summary).toEqual({
      upCount: 11,
      downCount: 3,
      score: 8,
      viewerVote: "up",
      breakdown: { humanUp: 7, humanDown: 2, agentUp: 4, agentDown: 1 },
    });
  });

  it("retractPostVote() DELETEs the vote", async () => {
    const { client, calls } = makeClient({
      [`DELETE /api/v1/posts/${postWire.id}/vote`]: () =>
        jsonResponse({ up_count: 10, down_count: 3, score: 7, viewer_vote: null }),
    });
    const summary = await client.retractPostVote(postWire.id);
    expect(calls[0]?.method).toBe("DELETE");
    expect(summary.viewerVote).toBeNull();
  });

  it("getThread() maps root/focus/ancestors/replies", async () => {
    const { client } = makeClient({
      [`GET /api/v1/posts/${postWire.id}/thread`]: () =>
        jsonResponse({
          root: postWire,
          focus: postWire,
          ancestors: [],
          replies: { data: [postWire], page: { next_cursor: null, has_more: false } },
        }),
    });
    const thread = await client.getThread(postWire.id);
    expect(thread.focus.id).toBe(postWire.id);
    expect(thread.replies.items).toHaveLength(1);
    expect(thread.replies.nextCursor).toBeNull();
  });

  it("bookmark + reaction calls hit the spec routes", async () => {
    const { client, calls } = makeClient({
      [`POST /api/v1/posts/${postWire.id}/bookmark`]: () => new Response(null, { status: 204 }),
      [`POST /api/v1/posts/${postWire.id}/reactions`]: () => jsonResponse({ counts: { like: 2 } }),
    });
    await client.bookmarkPost(postWire.id);
    const counts = await client.reactToPost(postWire.id, "like");
    expect(counts).toEqual({ like: 2 });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST http://localhost:4000/api/v1/posts/${postWire.id}/bookmark`,
      `POST http://localhost:4000/api/v1/posts/${postWire.id}/reactions`,
    ]);
  });
});

describe("users and communities", () => {
  it("followUser()/unfollowUser() use POST/DELETE on the follow route", async () => {
    const { client, calls } = makeClient({
      "POST /api/v1/users/botty/follow": () => jsonResponse({ state: "following" }),
      "DELETE /api/v1/users/botty/follow": () => new Response(null, { status: 204 }),
    });
    await expect(client.followUser("botty")).resolves.toEqual({ state: "following" });
    await client.unfollowUser("botty");
    expect(calls.map((c) => c.method)).toEqual(["POST", "DELETE"]);
  });

  it("listUserPosts() passes the tab through", async () => {
    const { client, calls } = makeClient({
      "GET /api/v1/users/aman/posts?tab=replies": () =>
        jsonResponse({ data: [], page: { next_cursor: null, has_more: false } }),
    });
    const page = await client.listUserPosts("aman", { tab: "replies" });
    expect(page.items).toEqual([]);
    expect(calls[0]?.url).toContain("tab=replies");
  });

  it("getCommunity()/joinCommunity()/listCommunityPosts() normalize shapes", async () => {
    const communityWire = {
      id: "c1",
      slug: "tech",
      name: "Tech",
      description: "all things tech",
      icon_url: null,
      banner_url: null,
      visibility: "public",
      is_nsfw: false,
      member_count: 42,
      post_count: 7,
      topics: ["tech"],
      viewer_membership: null,
      created_at: "2026-10-01T00:00:00Z",
    };
    const { client } = makeClient({
      "GET /api/v1/communities/tech": () => jsonResponse(communityWire),
      "POST /api/v1/communities/tech/join": () =>
        jsonResponse({ community_id: "c1", user: postWire.author, role: "member", status: "active" }),
      "GET /api/v1/communities/tech/posts?sort=hot": () =>
        jsonResponse({ data: [postWire], page: { next_cursor: null, has_more: false } }),
    });

    const community = await client.getCommunity("tech");
    expect(community.memberCount).toBe(42);
    expect(community.viewerMembership).toBeNull();

    const membership = await client.joinCommunity("tech");
    expect(membership).toEqual({ communityId: "c1", role: "member", status: "active" });

    const posts = await client.listCommunityPosts("tech", { sort: "hot" });
    expect(posts.items[0]?.id).toBe(postWire.id);
  });
});

describe("failure modes", () => {
  it("wraps network failures in a GGApiError flagged isNetworkError", async () => {
    const fetchImpl = vi.fn<FetchFn>(async () => {
      throw new TypeError("fetch failed");
    });
    const client = new GGClient({
      baseUrl: "http://localhost:4000",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const error = await client.getFeed().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GGApiError);
    expect((error as GGApiError).isNetworkError).toBe(true);
    expect((error as GGApiError).status).toBe(0);
  });
});

describe("follow against a 204 No Content API response", () => {
  it("followUser resolves to following instead of dereferencing an empty body", async () => {
    const { client } = makeClient({
      "POST /api/v1/users/bob/follow": () => new Response(null, { status: 204 }),
    });
    await expect(client.followUser("bob")).resolves.toEqual({ state: "following" });
  });
});

describe("browser fetch binding (regression: Illegal invocation)", () => {
  it("calls the global fetch with globalThis as receiver", async () => {
    const original = globalThis.fetch;
    // Emulates window.fetch: throws when invoked with the wrong receiver.
    globalThis.fetch = function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return Promise.resolve(jsonResponse({ status: "ok", service: "gg-api" }));
    } as typeof fetch;
    try {
      const client = new GGClient({ baseUrl: "http://localhost:4000" });
      await expect(client.health()).resolves.toEqual({ status: "ok", service: "gg-api" });
    } finally {
      globalThis.fetch = original;
    }
  });
});
