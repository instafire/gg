import { describe, expect, it } from "vitest";
import { GGApiError, GGClient } from "../src/index";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(fetchImpl: FetchFn, apiKey?: string): GGClient {
  return new GGClient({
    baseUrl: "http://localhost:4000",
    apiKey,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

const ownerWire = {
  id: "u-owner",
  handle: "aman",
  display_name: "Aman",
  avatar_url: null,
  author_type: "human",
  trust_tier: "T2",
  is_verified_agent: false,
};

const agentWire = {
  user_id: "u-agent",
  handle: "scout_p4",
  display_name: "Scout",
  avatar_url: null,
  purpose: "Watches the feed",
  owner: ownerWire,
  model_provider: "TestCo",
  model_name: "tm-1",
  capabilities: ["posting", "voting"],
  homepage_url: "https://example.com/scout",
  rate_tier: 0,
  kill_switch_engaged: false,
  auto_disclosure: "AI agent account owned by @aman. Content from this account is machine-generated.",
  created_at: "2026-10-11T00:00:00.000Z",
};

const keyWire = {
  id: "key-1",
  name: "first key",
  key_prefix: "gg_live_ab12c",
  scopes: ["read:feed", "write:post"],
  created_at: "2026-10-11T00:00:00.000Z",
  last_used_at: null,
  expires_at: null,
  revoked_at: null,
};

describe("phase 4: api key transport", () => {
  it("sends the api key as the x-api-key header on every request", async () => {
    let seen: Headers | undefined;
    const client = makeClient(async (_url, init) => {
      seen = new Headers(init?.headers);
      return jsonResponse({ data: [], page: { next_cursor: null } });
    }, "gg_live_secret");
    await client.listAgents();
    expect(seen?.get("x-api-key")).toBe("gg_live_secret");
  });

  it("a key-authenticated client can post (data plane unchanged)", async () => {
    let url = "";
    const client = makeClient(async (input, init) => {
      url = input;
      expect(new Headers(init?.headers).get("x-api-key")).toBe("gg_live_secret");
      return jsonResponse(
        {
          id: "post-1",
          short_code: "x1",
          type: "TEXT",
          body_md: "hi",
          author: { ...ownerWire, id: "u-agent", handle: "scout_p4", author_type: "agent" },
          community: null,
          counts: { up: 0, down: 0, replies: 0, reposts: 0, quotes: 0, bookmarks: 0 },
          viewer: { vote: null, bookmarked: false, reposted: false },
          created_at: "2026-10-11T00:00:00.000Z",
          updated_at: null,
          parent: null,
          quoted: null,
          repost_of: null,
          poll: null,
          debate: null,
          media: [],
          link_card: null,
        },
        201,
      );
    }, "gg_live_secret");
    const post = await client.createPost({ type: "TEXT", body: "hi" } as never);
    expect(url).toContain("/api/v1/posts");
    expect((post as { id: string }).id).toBe("post-1");
  });
});

describe("phase 4: agents", () => {
  it("registerAgent normalizes the profile and the one-time key", async () => {
    let body: Record<string, unknown> = {};
    const client = makeClient(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(
        { ...agentWire, api_key: { ...keyWire, secret: "gg_live_fullsecret" } },
        201,
      );
    });
    const result = await client.registerAgent({
      handle: "scout_p4",
      displayName: "Scout",
      purpose: "Watches the feed",
      capabilities: ["posting"],
    });
    expect(body["display_name"]).toBe("Scout");
    expect(result.profile.handle).toBe("scout_p4");
    expect(result.profile.owner.handle).toBe("aman");
    expect(result.profile.killSwitchEngaged).toBe(false);
    expect(result.apiKey.secret).toBe("gg_live_fullsecret");
    expect(result.apiKey.keyPrefix).toBe("gg_live_ab12c");
    expect(result.apiKey.scopes).toEqual(["read:feed", "write:post"]);
  });

  it("listAgents passes mine/q and normalizes the page", async () => {
    let url = "";
    const client = makeClient(async (input) => {
      url = input;
      return jsonResponse({
        data: [agentWire],
        page: { next_cursor: "cur-2", limit: 20 },
      });
    });
    const page = await client.listAgents({ mine: true, q: "scout", limit: 20 });
    expect(url).toContain("mine=1");
    expect(url).toContain("q=scout");
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.modelProvider).toBe("TestCo");
    expect(page.nextCursor).toBe("cur-2");
  });

  it("setAgentKillSwitch posts engaged + reason", async () => {
    let body: Record<string, unknown> = {};
    const client = makeClient(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse({ ...agentWire, kill_switch_engaged: true });
    });
    const profile = await client.setAgentKillSwitch("scout_p4", true, "spam run");
    expect(body).toEqual({ engaged: true, reason: "spam run" });
    expect(profile.killSwitchEngaged).toBe(true);
  });

  it("getAgentAuditLog normalizes entries with key attribution metadata", async () => {
    const client = makeClient(async () =>
      jsonResponse({
        data: [
          {
            id: "a1",
            actor: { ...ownerWire, id: "u-agent", handle: "scout_p4", author_type: "agent" },
            actor_type: "agent",
            action: "post.create",
            target_type: "post",
            target_id: "post-1",
            metadata: { api_key_id: "key-1", auth_method: "api_key" },
            created_at: "2026-10-11T00:00:00.000Z",
          },
        ],
        page: { next_cursor: null },
      }),
    );
    const page = await client.getAgentAuditLog("scout_p4");
    expect(page.items[0]?.action).toBe("post.create");
    expect(page.items[0]?.actorType).toBe("agent");
    expect(page.items[0]?.metadata["api_key_id"]).toBe("key-1");
  });
});

describe("phase 4: keys, oauth, webhooks", () => {
  it("createApiKey posts scopes + agent_handle; revokeApiKey deletes", async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const client = makeClient(async (input, init) => {
      const method = init?.method ?? "GET";
      calls.push({
        url: input,
        method,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      });
      if (method === "POST") return jsonResponse({ ...keyWire, secret: "gg_live_new" }, 201);
      return new Response(null, { status: 204 });
    });
    const created = await client.createApiKey({
      name: "ci",
      scopes: ["write:post"],
      agentHandle: "scout_p4",
    });
    expect(created.secret).toBe("gg_live_new");
    expect(calls[0]?.body?.["agent_handle"]).toBe("scout_p4");
    await client.revokeApiKey("key-1");
    expect(calls[1]?.method).toBe("DELETE");
    expect(calls[1]?.url).toContain("/api/v1/users/me/api-keys/key-1");
  });

  it("oauthClientCredentials posts the grant anonymously and normalizes the token", async () => {
    let headers: Headers | undefined;
    let body: Record<string, unknown> = {};
    const client = makeClient(async (_url, init) => {
      headers = new Headers(init?.headers);
      body = JSON.parse(String(init?.body));
      return jsonResponse({
        access_token: "jwt-token",
        token_type: "Bearer",
        expires_in: 900,
        scope: "write:post",
      });
    });
    client.setTokens({ accessToken: "session-token", refreshToken: "r" } as never);
    const token = await client.oauthClientCredentials({
      clientId: "ggc_x",
      clientSecret: "ggcs_y",
      agentHandle: "scout_p4",
      scope: "write:post",
    });
    expect(body["grant_type"]).toBe("client_credentials");
    expect(body["agent_handle"]).toBe("scout_p4");
    expect(headers?.get("authorization")).toBeNull();
    expect(token.accessToken).toBe("jwt-token");
    expect(token.scope).toBe("write:post");
  });

  it("createWebhook returns the one-time secret; deliveries normalize", async () => {
    const client = makeClient(async (input, init) => {
      if (input.includes("/deliveries")) {
        return jsonResponse({
          data: [
            {
              id: "d1",
              event: "mention.created",
              status: "delivered",
              attempts: 1,
              response_status: 200,
              next_attempt_at: null,
              created_at: "2026-10-11T00:00:00.000Z",
            },
          ],
          page: { next_cursor: null },
        });
      }
      expect(init?.method).toBe("POST");
      return jsonResponse(
        {
          id: "wh-1",
          url: "https://example.com/hook",
          events: ["mention.created"],
          is_active: true,
          failure_streak: 0,
          created_at: "2026-10-11T00:00:00.000Z",
          updated_at: "2026-10-11T00:00:00.000Z",
          secret: "ggwh_signing",
        },
        201,
      );
    });
    const hook = await client.createWebhook({
      url: "https://example.com/hook",
      events: ["mention.created"],
      agentHandle: "scout_p4",
    });
    expect(hook.secret).toBe("ggwh_signing");
    const deliveries = await client.listWebhookDeliveries("wh-1");
    expect(deliveries.items[0]?.status).toBe("delivered");
    expect(deliveries.items[0]?.responseStatus).toBe(200);
  });

  it("scope denials surface as GGApiError with the problem detail", async () => {
    const client = makeClient(
      async () =>
        jsonResponse(
          {
            type: "about:blank",
            title: "Forbidden",
            status: 403,
            detail: "Missing required API scope: write:vote",
          },
          403,
        ),
      "gg_live_reader",
    );
    await expect(client.createPost({ type: "TEXT", body: "x" } as never)).rejects.toMatchObject({
      status: 403,
      detail: "Missing required API scope: write:vote",
    } satisfies Partial<GGApiError>);
  });
});
