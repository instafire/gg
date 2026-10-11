/**
 * Phase 5B client surface: AutoMod rules, lockdown, mod actions + log,
 * membership requests, mod mail, admin analytics, push subscriptions,
 * semantic search flag, and the new settings fields.
 * Same stub-fetch harness as client-reports.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { GGClient } from "../src/index";

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
    if (!handler)
      return jsonResponse(
        { title: "Not Found", detail: `no route ${method} ${path}` },
        404,
      );
    return handler(call);
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function makeClient(routes: Record<string, (call: RecordedCall) => Response>) {
  const stub = stubFetch(routes);
  const client = new GGClient({
    baseUrl: "http://localhost:4000",
    fetchImpl: stub.fetchImpl,
  });
  return { client, calls: stub.calls };
}

const ruleWire = {
  id: "rule-1",
  community_id: "comm-1",
  kind: "keyword",
  config: { keywords: ["free money"] },
  action: "hold",
  is_enabled: true,
  created_by: "user-1",
  created_at: "2026-10-11T00:00:00.000Z",
  updated_at: "2026-10-11T00:00:00.000Z",
};

describe("Phase 5B SDK — moderation", () => {
  it("lists, creates, updates and deletes AutoMod rules", async () => {
    const { client, calls } = makeClient({
      "GET /api/v1/communities/civic/mod/automod-rules": () =>
        jsonResponse({ data: [ruleWire], page: { next_cursor: null, has_more: false } }),
      "POST /api/v1/communities/civic/mod/automod-rules": () =>
        jsonResponse(ruleWire, 201),
      "PATCH /api/v1/communities/civic/mod/automod-rules/rule-1": () =>
        jsonResponse({ ...ruleWire, is_enabled: false }),
      "DELETE /api/v1/communities/civic/mod/automod-rules/rule-1": () =>
        new Response(null, { status: 204 }),
    });
    const rules = await client.listAutomodRules("civic");
    expect(rules[0]).toMatchObject({
      id: "rule-1",
      kind: "keyword",
      action: "hold",
      isEnabled: true,
      config: { keywords: ["free money"] },
    });
    await client.createAutomodRule("civic", {
      kind: "keyword",
      config: { keywords: ["free money"] },
      action: "hold",
    });
    const createBody = calls.find((c) => c.method === "POST")?.body as Record<string, unknown>;
    expect(createBody).toMatchObject({ kind: "keyword", action: "hold" });
    const updated = await client.updateAutomodRule("civic", "rule-1", {
      isEnabled: false,
    });
    expect(updated.isEnabled).toBe(false);
    await client.deleteAutomodRule("civic", "rule-1");
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("sets lockdown and normalizes lockdown_active", async () => {
    const { client, calls } = makeClient({
      "POST /api/v1/communities/civic/lockdown": () =>
        jsonResponse({
          id: "comm-1",
          slug: "civic",
          name: "Civic",
          description: null,
          icon_url: null,
          banner_url: null,
          visibility: "public",
          is_nsfw: false,
          member_count: 3,
          post_count: 1,
          topics: [],
          viewer_membership: { role: "admin", status: "active" },
          lockdown_active: true,
          created_at: "2026-10-11T00:00:00.000Z",
        }),
    });
    const community = await client.setLockdown("civic", {
      enabled: true,
      minMemberAgeDays: 7,
    });
    expect(community.lockdownActive).toBe(true);
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ enabled: true, min_member_age_days: 7 });
  });

  it("posts mod actions and reads the mod log", async () => {
    const actionWire = {
      id: "act-1",
      community_id: "comm-1",
      actor_id: "mod-1",
      action: "pin",
      target_type: "post",
      target_id: "post-1",
      note: null,
      created_at: "2026-10-11T00:00:00.000Z",
    };
    const { client, calls } = makeClient({
      "POST /api/v1/communities/civic/mod/actions": () =>
        jsonResponse(actionWire, 201),
      "GET /api/v1/communities/civic/mod/log": () =>
        jsonResponse({
          data: [actionWire],
          page_info: { next_cursor: null, has_next_page: false },
        }),
    });
    const action = await client.modAction("civic", {
      action: "pin",
      targetType: "post",
      targetId: "post-1",
    });
    expect(action).toMatchObject({ action: "pin", targetId: "post-1" });
    expect(calls[0]?.body).toMatchObject({ action: "pin", target_type: "post" });
    const log = await client.listModLog("civic");
    expect(log.items[0]?.action).toBe("pin");
  });

  it("lists + decides membership requests", async () => {
    const membershipWire = {
      id: "mem-1",
      community_id: "comm-1",
      user: {
        id: "u-9",
        handle: "newbie",
        display_name: null,
        avatar_url: null,
        author_type: "human",
        trust_tier: "T0",
        is_verified: false,
      },
      role: "member",
      status: "pending",
      muted_until: null,
      joined_at: "2026-10-11T00:00:00.000Z",
    };
    const { client, calls } = makeClient({
      "GET /api/v1/communities/civic/mod/membership-requests": () =>
        jsonResponse({
          data: [membershipWire],
          page_info: { next_cursor: null, has_next_page: false },
        }),
      "POST /api/v1/communities/civic/mod/membership-requests/newbie": () =>
        jsonResponse({ ...membershipWire, status: "active" }),
    });
    const requests = await client.listMembershipRequests("civic");
    expect(requests.items[0]?.user.handle).toBe("newbie");
    const decided = await client.decideMembershipRequest("civic", "newbie", {
      decision: "approve",
    });
    expect(decided.status).toBe("active");
    expect(calls[1]?.body).toMatchObject({ decision: "approve" });
  });
});

describe("Phase 5B SDK — analytics, push, search, settings", () => {
  it("fetches + normalizes the analytics overview", async () => {
    const { client } = makeClient({
      "GET /api/v1/admin/analytics?days=30": () =>
        jsonResponse({
          window_days: 30,
          generated_at: "2026-10-11T04:00:00.000Z",
          dau_today: 12,
          mau: 40,
          new_users: { today: 2, last_7d: 9, last_30d: 30 },
          posts_per_day: 3.5,
          posts_series: [{ date: "2026-10-11", posts: 4, events: 50 }],
          dau_series: [{ date: "2026-10-11", dau: 12 }],
          debates: {
            started: 5,
            completed: 2,
            completion_rate: 0.4,
            mind_change_rate: 0.18,
          },
          moderation: {
            reports_total: 7,
            resolved_count: 3,
            pending_count: 4,
            report_rate_per_100_posts: 2.1,
            avg_time_to_moderation_hours: 1.25,
          },
          activity_split: {
            human_events: 90,
            agent_events: 10,
            human_users: 30,
            agent_users: 2,
          },
        }),
    });
    const overview = await client.getAnalytics(30);
    expect(overview.dauToday).toBe(12);
    expect(overview.newUsers.last7d).toBe(9);
    expect(overview.debates.mindChangeRate).toBe(0.18);
    expect(overview.moderation.avgTimeToModerationHours).toBe(1.25);
    expect(overview.activitySplit.agentEvents).toBe(10);
    expect(overview.postsSeries[0]).toEqual({ date: "2026-10-11", posts: 4, events: 50 });
  });

  it("manages push subscriptions + reads the VAPID key", async () => {
    const subWire = {
      id: "sub-1",
      endpoint: "https://push.example.com/x",
      created_at: "2026-10-11T00:00:00.000Z",
    };
    const { client, calls } = makeClient({
      "GET /api/v1/push/vapid-public-key": () =>
        jsonResponse({ public_key: "BPublicKey" }),
      "GET /api/v1/users/me/push-subscriptions": () => jsonResponse([subWire]),
      "POST /api/v1/users/me/push-subscriptions": () => jsonResponse(subWire, 201),
      "DELETE /api/v1/users/me/push-subscriptions/sub-1": () =>
        new Response(null, { status: 204 }),
    });
    expect((await client.getVapidPublicKey()).publicKey).toBe("BPublicKey");
    const created = await client.createPushSubscription({
      endpoint: "https://push.example.com/x",
      keys: { p256dh: "k", auth: "a" },
    });
    expect(created.id).toBe("sub-1");
    const postCall = calls.find((c) => c.method === "POST");
    expect(postCall?.body).toMatchObject({
      endpoint: "https://push.example.com/x",
      keys: { p256dh: "k", auth: "a" },
    });
    expect((await client.listPushSubscriptions()).length).toBe(1);
    await client.deletePushSubscription("sub-1");
  });

  it("passes the semantic flag and surfaces semantic_applied", async () => {
    const { client, calls } = makeClient({
      GET: () =>
        jsonResponse({
          posts: { data: [], page_info: { next_cursor: null, has_next_page: false } },
          people: { data: [], page_info: { next_cursor: null, has_next_page: false } },
          communities: { data: [], page_info: { next_cursor: null, has_next_page: false } },
          hashtags: [],
          semantic_applied: true,
        }),
    });
    const results = await client.search({ q: "reading halls", semantic: true });
    expect(results.semanticApplied).toBe(true);
    expect(calls[0]?.url).toContain("semantic=true");
  });

  it("sends push_prefs + digest_frequency in settings updates", async () => {
    const { client, calls } = makeClient({
      "PATCH /api/v1/users/me/settings": () =>
        jsonResponse({
          hide_ai_accounts: false,
          hide_nsfw: true,
          dm_policy: "everyone",
          mention_policy: "everyone",
          read_receipts: true,
          presence_visible: true,
          captions_default_on: false,
          font_scale: 1,
          high_contrast: false,
          reduced_motion: false,
          demographic_breakdowns_opt_in: false,
          language: "en",
          notification_prefs: {},
          push_prefs: { reply: false },
          digest_frequency: "weekly",
          quiet_hours: null,
          preferences: {},
          is_private: false,
        }),
    });
    const settings = await client.updateSettings({
      pushPrefs: { reply: false },
      digestFrequency: "weekly",
    });
    expect(settings.pushPrefs).toEqual({ reply: false });
    expect(settings.digestFrequency).toBe("weekly");
    expect(calls[0]?.body).toMatchObject({
      push_prefs: { reply: false },
      digest_frequency: "weekly",
    });
  });
});
