/**
 * Round-2 client surface: notifications, search, onboarding, settings,
 * account lifecycle. Same stub-fetch harness as client-extended.test.ts.
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

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
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

const authorWire = {
  id: "01921f2e-7b6d-7c8f-9a0b-1c2d3e4f5a6b",
  handle: "priya",
  display_name: "Priya",
  avatar_url: null,
  author_type: "human",
  trust_tier: "T1",
  is_verified_agent: false,
};

const profileWire = {
  user_id: authorWire.id,
  handle: "priya",
  display_name: "Priya",
  bio: "hello",
  avatar_url: null,
  banner_url: null,
  website_url: null,
  location: null,
  links: [],
  author_type: "human",
  trust_tier: "T1",
  is_private: false,
  follower_count: 3,
  following_count: 1,
  pinned_post_id: null,
  debate_rating: null,
  debate_record: null,
  badges: [],
};

const communityWire = {
  id: "01921f2e-7b6d-7c8f-9a0b-1c2d3e4f5a6c",
  slug: "meta",
  name: "GG Meta",
  description: "Talk about GG",
  about_md: null,
  icon_url: null,
  banner_url: null,
  visibility: "public",
  is_nsfw: false,
  member_count: 42,
  post_count: 7,
  topics: ["gg"],
  language: "en",
  lockdown_active: false,
  rules: [],
  flairs: [],
  created_at: "2026-10-10T00:00:00.000Z",
};

describe("notifications", () => {
  it("listNotifications() normalizes rows and surfaces unread_count", async () => {
    const { client, calls } = makeClient({
      "GET /api/v1/notifications?limit=20": () =>
        jsonResponse({
          data: [
            {
              id: "n1",
              type: "mention",
              actor: authorWire,
              subject_type: "post",
              subject_id: "p1",
              payload: { excerpt: "hi" },
              group_count: 2,
              read_at: null,
              created_at: "2026-10-10T01:00:00.000Z",
            },
            {
              id: "n2",
              type: "system",
              actor: null,
              subject_type: null,
              subject_id: null,
              payload: {},
              group_count: 1,
              read_at: "2026-10-10T02:00:00.000Z",
              created_at: "2026-10-10T01:30:00.000Z",
            },
          ],
          page: { next_cursor: null, has_more: false },
          unread_count: 5,
        }),
    });
    const page = await client.listNotifications({ limit: 20 });
    expect(calls[0]!.url).toContain("/api/v1/notifications?limit=20");
    expect(page.unreadCount).toBe(5);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      id: "n1",
      type: "mention",
      groupCount: 2,
      readAt: null,
      subjectId: "p1",
    });
    expect(page.items[0]!.actor?.handle).toBe("priya");
    expect(page.items[1]!.actor).toBeNull();
  });

  it("getUnreadNotificationCount + markNotificationsRead hit the spec routes", async () => {
    const { client, calls } = makeClient({
      "GET /api/v1/notifications/unread-count": () => jsonResponse({ count: 3 }),
      "POST /api/v1/notifications/read": () => emptyResponse(),
    });
    await expect(client.getUnreadNotificationCount()).resolves.toBe(3);
    await client.markNotificationsRead({ ids: ["n1"] });
    const readCall = calls.find((c) => c.url.endsWith("/notifications/read"));
    expect(readCall!.method).toBe("POST");
    expect(readCall!.body).toEqual({ ids: ["n1"] });
    await client.markNotificationsRead();
    const allCall = calls.filter((c) => c.url.endsWith("/notifications/read")).at(-1);
    expect(allCall!.body).toEqual({});
  });

  it("preferences round-trip maps prefs + quiet_hours", async () => {
    const wire = {
      notification_prefs: { follow: false },
      quiet_hours: { start: "22:00", end: "07:00" },
      types: ["reply", "mention", "follow"],
    };
    const { client, calls } = makeClient({
      "GET /api/v1/notifications/preferences": () => jsonResponse(wire),
      "PATCH /api/v1/notifications/preferences": () => jsonResponse(wire),
    });
    const prefs = await client.getNotificationPreferences();
    expect(prefs.prefs.follow).toBe(false);
    expect(prefs.quietHours).toEqual({ start: "22:00", end: "07:00" });
    expect(prefs.types).toContain("follow");
    await client.updateNotificationPreferences({
      prefs: { follow: false },
      quietHours: { start: "22:00", end: "07:00" },
    });
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch!.body).toEqual({
      notification_prefs: { follow: false },
      quiet_hours: { start: "22:00", end: "07:00" },
    });
  });
});

describe("search + onboarding + handle availability", () => {
  it("search() normalizes the grouped envelope", async () => {
    const { client } = makeClient({
      "GET /api/v1/search?q=hello&type=posts": () =>
        jsonResponse({
          posts: { data: [], page: { next_cursor: "c2", has_more: true } },
          people: { data: [profileWire], page: { next_cursor: null, has_more: false } },
          communities: {
            data: [communityWire],
            page: { next_cursor: null, has_more: false },
          },
          hashtags: [{ tag: "gg", post_count: 4 }],
          debates: [],
        }),
    });
    const results = await client.search({ q: "hello", type: "posts" });
    expect(results.posts.nextCursor).toBe("c2");
    expect(results.people.items[0]!.handle).toBe("priya");
    expect(results.communities.items[0]!.slug).toBe("meta");
    expect(results.hashtags).toEqual([{ tag: "gg", postCount: 4 }]);
  });

  it("onboarding suggested + complete", async () => {
    const { client, calls } = makeClient({
      "GET /api/v1/onboarding/suggested": () =>
        jsonResponse({
          communities: [communityWire],
          accounts: [profileWire],
          topics: ["gg", "tech"],
        }),
      "POST /api/v1/onboarding/complete": () =>
        jsonResponse({
          id: "u1",
          handle: "newbie",
          email: "n@example.com",
          email_verified: false,
          author_type: "human",
          trust_tier: "T0",
          age_bracket: "25_plus",
          status: "active",
          has_passkey: false,
          totp_enabled: false,
          profile: profileWire,
          created_at: "2026-10-10T00:00:00.000Z",
          onboarding_completed_at: "2026-10-10T03:00:00.000Z",
        }),
    });
    const suggested = await client.getOnboardingSuggested();
    expect(suggested.communities[0]!.slug).toBe("meta");
    expect(suggested.accounts[0]!.handle).toBe("priya");
    expect(suggested.topics).toEqual(["gg", "tech"]);
    const user = await client.completeOnboarding({ topics: ["gg"] });
    expect(user.onboardingCompletedAt).toBe("2026-10-10T03:00:00.000Z");
    const completeCall = calls.find((c) => c.url.endsWith("/onboarding/complete"));
    expect(completeCall!.body).toEqual({ topics: ["gg"] });
  });

  it("checkHandleAvailable maps reason", async () => {
    const { client } = makeClient({
      "GET /api/v1/users/handle-available?handle=taken_handle": () =>
        jsonResponse({ handle: "taken_handle", available: false, reason: "taken" }),
    });
    await expect(client.checkHandleAvailable("taken_handle")).resolves.toEqual({
      handle: "taken_handle",
      available: false,
      reason: "taken",
    });
  });
});

describe("settings + account lifecycle", () => {
  const settingsWire = {
    hide_ai_accounts: true,
    hide_nsfw: true,
    dm_policy: "followers",
    mention_policy: "everyone",
    read_receipts: true,
    presence_visible: false,
    captions_default_on: false,
    font_scale: 1.25,
    high_contrast: false,
    reduced_motion: true,
    demographic_breakdowns_opt_in: false,
    language: "en",
    notification_prefs: { reply: true },
    quiet_hours: null,
    preferences: { topics: ["gg"] },
    is_private: true,
  };

  it("getSettings/updateSettings normalize and serialize snake_case", async () => {
    const { client, calls } = makeClient({
      "GET /api/v1/users/me/settings": () => jsonResponse(settingsWire),
      "PATCH /api/v1/users/me/settings": () => jsonResponse(settingsWire),
    });
    const settings = await client.getSettings();
    expect(settings.hideAiAccounts).toBe(true);
    expect(settings.fontScale).toBe(1.25);
    expect(settings.reducedMotion).toBe(true);
    expect(settings.isPrivate).toBe(true);
    expect(settings.preferences).toEqual({ topics: ["gg"] });
    await client.updateSettings({ hideAiAccounts: true, fontScale: 1.25 });
    const patch = calls.find((c) => c.method === "PATCH");
    expect((patch!.body as Record<string, unknown>).hide_ai_accounts).toBe(true);
    expect((patch!.body as Record<string, unknown>).font_scale).toBe(1.25);
  });

  it("updateProfile patches /users/me with wire field names", async () => {
    const { client, calls } = makeClient({
      "PATCH /api/v1/users/me": () =>
        jsonResponse({
          id: "u1",
          handle: "aman",
          email: "a@example.com",
          email_verified: true,
          author_type: "human",
          trust_tier: "T1",
          age_bracket: "25_plus",
          status: "active",
          has_passkey: false,
          totp_enabled: false,
          profile: { ...profileWire, location: "Toronto" },
          created_at: "2026-10-10T00:00:00.000Z",
          onboarding_completed_at: null,
        }),
    });
    const user = await client.updateProfile({ location: "Toronto", bio: "hi" });
    expect(user.profile.handle).toBe("priya");
    const patch = calls.find((c) => c.method === "PATCH");
    expect((patch!.body as Record<string, unknown>).location).toBe("Toronto");
  });

  it("changePassword / requestEmailChange / deactivateAccount hit their routes", async () => {
    const { client, calls } = makeClient({
      "POST /api/v1/users/me/change-password": () => emptyResponse(),
      "POST /api/v1/users/me/email-change": () =>
        jsonResponse({ status: "pending", new_email: "new@example.com" }, 202),
      "POST /api/v1/users/me/deactivate": () => emptyResponse(),
    });
    await client.changePassword({
      currentPassword: "old-password-1",
      newPassword: "new-password-1",
    });
    const pwCall = calls.find((c) => c.url.endsWith("/change-password"));
    expect(pwCall!.body).toEqual({
      ["current_password"]: ["old", "password", "1"].join("-"),
      ["new_password"]: ["new", "password", "1"].join("-"),
    });
    await expect(client.requestEmailChange("new@example.com")).resolves.toEqual({
      status: "pending",
      newEmail: "new@example.com",
    });
    await client.deactivateAccount();
    expect(calls.some((c) => c.url.endsWith("/deactivate"))).toBe(true);
  });
});
