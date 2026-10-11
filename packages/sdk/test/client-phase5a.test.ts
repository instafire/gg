import { describe, expect, it } from "vitest";
import { GGClient } from "../src/index";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(fetchImpl: FetchFn): GGClient {
  const client = new GGClient({
    baseUrl: "http://localhost:4000",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  client.setTokens({ accessToken: "token-1", refreshToken: "refresh-1" });
  return client;
}

const authorWire = {
  id: "u-1",
  handle: "aman",
  display_name: "Aman",
  avatar_url: null,
  author_type: "human",
  trust_tier: "T2",
  is_verified_agent: false,
};

const otherWire = { ...authorWire, id: "u-2", handle: "priya", display_name: "Priya" };

const messageWire = {
  id: "m-1",
  conversation_id: "c-1",
  sender: otherWire,
  author_type: "human",
  body: "hello there",
  media: null,
  reply_to_message_id: null,
  reply_to: null,
  shared_post: null,
  reactions: { "👍": 2 },
  viewer_reactions: ["👍"],
  read_by: ["aman"],
  edited_at: null,
  deleted_at: null,
  created_at: "2026-10-11T10:00:00.000Z",
};

const conversationWire = {
  id: "c-1",
  kind: "dm",
  title: null,
  status: "active",
  participants: [authorWire, otherWire],
  last_message: messageWire,
  unread_count: 1,
  muted_until: null,
  last_message_at: "2026-10-11T10:00:00.000Z",
  created_at: "2026-10-11T09:00:00.000Z",
};

describe("phase 5a: conversations", () => {
  it("lists conversations with the box parameter and normalizes participants", async () => {
    let url = "";
    const client = makeClient(async (input) => {
      url = input;
      return jsonResponse({
        data: [conversationWire],
        page: { next_cursor: null, has_more: false },
      });
    });
    const page = await client.listConversations("requests");
    expect(url).toContain("/api/v1/conversations");
    expect(url).toContain("box=requests");
    const conversation = page.items[0]!;
    expect(conversation.participants.map((p) => p.handle)).toEqual(["aman", "priya"]);
    expect(conversation.lastMessage?.body).toBe("hello there");
    expect(conversation.lastMessage?.reactions).toEqual({ "👍": 2 });
    expect(conversation.lastMessage?.readBy).toEqual(["aman"]);
    expect(conversation.unreadCount).toBe(1);
  });

  it("creates a conversation with participant handles", async () => {
    let body: unknown;
    const client = makeClient(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(conversationWire, 201);
    });
    const conversation = await client.createConversation(["priya"]);
    expect(body).toEqual({ participant_handles: ["priya"], title: undefined });
    expect(conversation.id).toBe("c-1");
  });

  it("sends a message with media + reply fields in snake_case", async () => {
    let body: unknown;
    const client = makeClient(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(messageWire, 201);
    });
    const message = await client.sendMessage("c-1", {
      body: "hi",
      mediaId: "media-1",
      replyToMessageId: "m-0",
    });
    expect(body).toEqual({
      body: "hi",
      media_id: "media-1",
      reply_to_message_id: "m-0",
      shared_post_id: undefined,
    });
    expect(message.sender.handle).toBe("priya");
  });

  it("accepts, declines, mutes and reacts through the right endpoints", async () => {
    const calls: string[] = [];
    const client = makeClient(async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${input}`);
      if (input.includes("/reactions")) return jsonResponse(messageWire);
      return jsonResponse(conversationWire);
    });
    await client.acceptConversation("c-1");
    await client.declineConversation("c-1");
    await client.muteConversation("c-1", null);
    await client.reactToMessage("c-1", "m-1", "🔥");
    await client.unreactToMessage("c-1", "m-1", "🔥");
    expect(calls[0]).toContain("POST http://localhost:4000/api/v1/conversations/c-1/accept");
    expect(calls[1]).toContain("/api/v1/conversations/c-1/decline");
    expect(calls[2]).toContain("/api/v1/conversations/c-1/mute");
    expect(calls[3]).toContain("/api/v1/conversations/c-1/messages/m-1/reactions");
    expect(calls[4]).toContain(
      `/api/v1/conversations/c-1/messages/m-1/reactions/${encodeURIComponent("🔥")}`,
    );
  });

  it("reads combined unread counts (notifications + dm_count)", async () => {
    const client = makeClient(async () => jsonResponse({ count: 3, dm_count: 2 }));
    await expect(client.getUnreadCounts()).resolves.toEqual({ notifications: 3, dms: 2 });
  });
});

const listWire = {
  id: "l-1",
  owner: authorWire,
  name: "Punjabi scene",
  description: "Artists + promoters",
  is_public: true,
  member_count: 4,
  created_at: "2026-10-11T09:00:00.000Z",
};

describe("phase 5a: lists + collections + scheduled + trending", () => {
  it("creates a list and normalizes it", async () => {
    let body: unknown;
    const client = makeClient(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(listWire, 201);
    });
    const list = await client.createList({ name: "Punjabi scene", isPublic: true });
    expect(body).toEqual({
      name: "Punjabi scene",
      description: undefined,
      is_public: true,
    });
    expect(list.memberCount).toBe(4);
    expect(list.owner.handle).toBe("aman");
  });

  it("collection CRUD round-trips through the endpoints", async () => {
    const calls: string[] = [];
    const collectionWire = {
      id: "col-1",
      name: "Reads",
      description: null,
      is_public: false,
      item_count: 2,
      created_at: "2026-10-11T09:00:00.000Z",
      updated_at: "2026-10-11T09:00:00.000Z",
    };
    const client = makeClient(async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${input}`);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return jsonResponse(collectionWire, init?.method === "POST" ? 201 : 200);
    });
    const created = await client.createCollection({ name: "Reads" });
    expect(created.itemCount).toBe(2);
    await client.updateCollection("col-1", { name: "Reads v2" });
    await client.deleteCollection("col-1");
    expect(calls[0]).toContain("POST http://localhost:4000/api/v1/collections");
    expect(calls[1]).toContain("PATCH http://localhost:4000/api/v1/collections/col-1");
    expect(calls[2]).toContain("DELETE http://localhost:4000/api/v1/collections/col-1");
  });

  it("createPost passes scheduled_for and updatePost can publish now (null)", async () => {
    const bodies: unknown[] = [];
    const postWire = {
      id: "p-1",
      short_code: "s1",
      type: "TEXT",
      body_md: "later",
      author: authorWire,
      author_type: "human",
      visibility: "public",
      created_at: "2026-10-11T09:00:00.000Z",
      scheduled_for: "2026-10-12T09:00:00.000Z",
    };
    const client = makeClient(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(postWire, init?.method === "POST" ? 201 : 200);
    });
    const post = await client.createPost({
      body: "later",
      scheduledFor: "2026-10-12T09:00:00.000Z",
    });
    expect(post.scheduledFor).toBe("2026-10-12T09:00:00.000Z");
    await client.updatePost("p-1", { scheduledFor: null });
    expect((bodies[0] as { scheduled_for?: string }).scheduled_for).toBe(
      "2026-10-12T09:00:00.000Z",
    );
    expect((bodies[1] as { scheduled_for?: string | null }).scheduled_for).toBeNull();
  });

  it("normalizes the trending snapshot incl. the posts delta", async () => {
    const client = makeClient(async () =>
      jsonResponse({
        hashtags: [{ tag: "ai", post_count: 7 }],
        communities: [],
        debates: [],
        posts: [],
        computed_at: "2026-10-11T10:00:00.000Z",
        window: "trailing_6h",
      }),
    );
    const trending = await client.getTrending();
    expect(trending.hashtags).toEqual([{ tag: "ai", postCount: 7 }]);
    expect(trending.window).toBe("trailing_6h");
    expect(trending.computedAt).toBe("2026-10-11T10:00:00.000Z");
  });
});
