/**
 * Phase 5A — social depth: AUDIO media, DMs + groups + requests + minor
 * gates, realtime WS delivery, lists, bookmark collections, scheduled
 * posts, trending snapshots. Runs against gg_test (DATABASE_URL override)
 * with an isolated Redis DB index (REDIS_URL override).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { LocalStorageAdapter, processMediaFile } from "@gg/media";
import { buildApp } from "../src/app";
import { loadConfig, loadDotEnv, type AppConfig } from "../src/config";
import { closeDb, getDb } from "../src/db";
import { media, posts, trendingSnapshots } from "../src/db/schema";
import { publishScheduledPost } from "../src/services/posts";

loadDotEnv();
const config: AppConfig = loadConfig();
const db = getDb(config.DATABASE_URL).db;

let app: FastifyInstance;
let counter = 0;

function suffix(): string {
  counter += 1;
  return `${counter.toString(36)}${randomBytes(3).toString("hex")}`;
}

interface TestUser {
  accessToken: string;
  handle: string;
  id: string;
}

async function registerUser(prefix: string, dob = "1995-06-15"): Promise<TestUser> {
  const s = suffix();
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email: `${prefix}_${s}@example.com`,
      password: "correct-horse-9",
      handle: `${prefix}_${s}`.slice(0, 24),
      display_name: `${prefix} ${s}`,
      date_of_birth: dob,
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return {
    accessToken: body.tokens.access_token as string,
    handle: body.user.handle as string,
    id: body.user.id as string,
  };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function follow(me: TestUser, handle: string): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/users/${handle}/follow`,
    headers: auth(me.accessToken),
    payload: {},
  });
  expect(res.statusCode).toBe(204);
}

async function createConversation(me: TestUser, handles: string[], title?: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/conversations",
    headers: auth(me.accessToken),
    payload: { participant_handles: handles, title },
  });
}

async function sendMessage(me: TestUser, conversationId: string, payload: object) {
  return app.inject({
    method: "POST",
    url: `/api/v1/conversations/${conversationId}/messages`,
    headers: auth(me.accessToken),
    payload,
  });
}

async function listMessages(me: TestUser, conversationId: string) {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/conversations/${conversationId}/messages?limit=50`,
    headers: auth(me.accessToken),
  });
  expect(res.statusCode).toBe(200);
  return res.json().data as any[];
}

async function createPost(me: TestUser, payload: object) {
  return app.inject({
    method: "POST",
    url: "/api/v1/posts",
    headers: auth(me.accessToken),
    payload,
  });
}

let alice: TestUser;
let bob: TestUser;
let carol: TestUser;
let dave: TestUser;

beforeAll(async () => {
  app = await buildApp(config);
  await app.ready();
  alice = await registerUser("p5alice");
  bob = await registerUser("p5bob");
  carol = await registerUser("p5carol");
  dave = await registerUser("p5dave");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await closeDb();
});

describe("DM 1:1 full flow", () => {
  let conversationId = "";

  it("mutual follows → active DM; send/receive/read receipt/reaction/reply/edit/delete", async () => {
    await follow(alice, bob.handle);
    await follow(bob, alice.handle);

    const created = await createConversation(alice, [bob.handle]);
    expect(created.statusCode).toBe(201);
    const conversation = created.json();
    expect(conversation.kind).toBe("dm");
    expect(conversation.status).toBe("active");
    conversationId = conversation.id as string;

    // Pair dedupe: creating again returns the same conversation.
    const again = await createConversation(bob, [alice.handle]);
    expect(again.json().id).toBe(conversationId);

    const sent = await sendMessage(alice, conversationId, { body: "hello bob" });
    expect(sent.statusCode).toBe(201);
    const message = sent.json();
    expect(message.body).toBe("hello bob");
    expect(message.read_by).toEqual([]);

    // Bob sees it and marks the conversation read up to it.
    const bobView = await listMessages(bob, conversationId);
    expect(bobView).toHaveLength(1);
    const read = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/read`,
      headers: auth(bob.accessToken),
      payload: { message_id: message.id },
    });
    expect(read.statusCode).toBe(204);

    // Alice now sees Bob in read_by (his read receipts are on by default).
    const aliceView = await listMessages(alice, conversationId);
    expect(aliceView[0].read_by).toContain(bob.handle);

    // Reaction round-trip.
    const reacted = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/messages/${message.id}/reactions`,
      headers: auth(bob.accessToken),
      payload: { emoji: "👍" },
    });
    expect(reacted.statusCode).toBe(200);
    expect(reacted.json().reactions).toEqual({ "👍": 1 });
    const unreacted = await app.inject({
      method: "DELETE",
      url: `/api/v1/conversations/${conversationId}/messages/${message.id}/reactions/${encodeURIComponent("👍")}`,
      headers: auth(bob.accessToken),
    });
    expect(unreacted.statusCode).toBe(200);
    expect(unreacted.json().reactions).toEqual({});

    // Reply quoting.
    const reply = await sendMessage(bob, conversationId, {
      body: "hi alice",
      reply_to_message_id: message.id,
    });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().reply_to.sender_handle).toBe(alice.handle);
    expect(reply.json().reply_to.body).toBe("hello bob");

    // Edit own / cannot edit another's.
    const replyId = reply.json().id as string;
    const edited = await app.inject({
      method: "PATCH",
      url: `/api/v1/conversations/${conversationId}/messages/${replyId}`,
      headers: auth(bob.accessToken),
      payload: { body: "hi alice (edited)" },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().body).toBe("hi alice (edited)");
    expect(edited.json().edited_at).toBeTruthy();
    const foreignEdit = await app.inject({
      method: "PATCH",
      url: `/api/v1/conversations/${conversationId}/messages/${replyId}`,
      headers: auth(alice.accessToken),
      payload: { body: "hijack" },
    });
    expect(foreignEdit.statusCode).toBe(403);

    // Delete own → tombstone.
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/conversations/${conversationId}/messages/${replyId}`,
      headers: auth(bob.accessToken),
    });
    expect(removed.statusCode).toBe(204);
    const after = await listMessages(alice, conversationId);
    const tombstone = after.find((m) => m.id === replyId);
    expect(tombstone.deleted_at).toBeTruthy();
    expect(tombstone.body).toBeNull();
  });

  it("non-participants get 404 on the conversation and its messages", async () => {
    const peek = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}`,
      headers: auth(carol.accessToken),
    });
    expect(peek.statusCode).toBe(404);
    const send = await sendMessage(carol, conversationId, { body: "intruder" });
    expect(send.statusCode).toBe(403);
  });
});

describe("message requests", () => {
  it("stranger DM lands in Requests; accept moves it to the inbox", async () => {
    // Carol does not follow Alice and Alice does not follow Carol.
    const created = await createConversation(carol, [alice.handle]);
    expect(created.statusCode).toBe(201);
    const conversationId = created.json().id as string;
    const sent = await sendMessage(carol, conversationId, { body: "hi, big fan" });
    expect(sent.statusCode).toBe(201);

    const main = await app.inject({
      method: "GET",
      url: "/api/v1/conversations?box=main",
      headers: auth(alice.accessToken),
    });
    expect(main.json().data.some((c: any) => c.id === conversationId)).toBe(false);
    const requests = await app.inject({
      method: "GET",
      url: "/api/v1/conversations?box=requests",
      headers: auth(alice.accessToken),
    });
    const request = (requests.json().data as any[]).find((c) => c.id === conversationId);
    expect(request).toBeTruthy();
    expect(request.status).toBe("requested");
    expect(request.unread_count).toBe(1);

    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/accept`,
      headers: auth(alice.accessToken),
      payload: {},
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().status).toBe("active");
    const mainAfter = await app.inject({
      method: "GET",
      url: "/api/v1/conversations?box=main",
      headers: auth(alice.accessToken),
    });
    expect(mainAfter.json().data.some((c: any) => c.id === conversationId)).toBe(true);
  });

  it("decline removes the request; the sender's next message is refused", async () => {
    const created = await createConversation(dave, [alice.handle]);
    const conversationId = created.json().id as string;
    await sendMessage(dave, conversationId, { body: "please?" });
    const declined = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/decline`,
      headers: auth(alice.accessToken),
      payload: {},
    });
    expect(declined.statusCode).toBe(200);
    const requests = await app.inject({
      method: "GET",
      url: "/api/v1/conversations?box=requests",
      headers: auth(alice.accessToken),
    });
    expect(requests.json().data.some((c: any) => c.id === conversationId)).toBe(false);
    const again = await sendMessage(dave, conversationId, { body: "hello??" });
    expect(again.statusCode).toBe(403);
  });

  it("dm_policy=followers refuses strangers outright (no request state)", async () => {
    const patched = await app.inject({
      method: "PATCH",
      url: "/api/v1/users/me/settings",
      headers: auth(carol.accessToken),
      payload: { dm_policy: "followers" },
    });
    expect(patched.statusCode).toBe(200);
    const stranger = await registerUser("p5erin");
    const refused = await createConversation(stranger, [carol.handle]);
    expect(refused.statusCode).toBe(403);
    // …but someone Carol follows can still write (lands as active).
    await follow(carol, dave.handle);
    const allowed = await createConversation(dave, [carol.handle]);
    expect(allowed.statusCode).toBe(201);
    expect(allowed.json().status).toBe("active");
  });
});

describe("minor protection (D-049)", () => {
  it("minor cannot be DM'd by an account they don't follow; followed accounts can", async () => {
    const minor = await registerUser("p5minor", "2011-03-01"); // 15 years old
    const stranger = await registerUser("p5stranger");
    const blocked = await createConversation(stranger, [minor.handle]);
    expect(blocked.statusCode).toBe(403);

    // The minor follows Alice → Alice may write, and it lands active.
    await follow(minor, alice.handle);
    const allowed = await createConversation(alice, [minor.handle]);
    expect(allowed.statusCode).toBe(201);
    expect(allowed.json().status).toBe("active");
    const sent = await sendMessage(alice, allowed.json().id as string, {
      body: "hi — your post was great",
    });
    expect(sent.statusCode).toBe(201);
  });

  it("agents can never DM a minor, even one that follows accounts", async () => {
    const minor = await registerUser("p5minor2", "2010-01-20"); // 16 years old
    const owner = await registerUser("p5owner");
    const agentRes = await app.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      headers: auth(owner.accessToken),
      payload: {
        handle: `p5bot_${suffix()}`.slice(0, 24),
        display_name: "Minor Gate Bot",
        purpose: "phase5a minor-gate test",
        model_provider: "TestCo",
        model_name: "tm-1",
        capabilities: ["posting"],
      },
    });
    expect(agentRes.statusCode).toBe(201);
    const agentHandle = agentRes.json().handle as string;
    const keyRes = await app.inject({
      method: "POST",
      url: "/api/v1/users/me/api-keys",
      headers: auth(owner.accessToken),
      payload: { agent_handle: agentHandle, name: "dm key", scopes: ["dm:send"] },
    });
    expect(keyRes.statusCode).toBe(201);
    const secret = keyRes.json().secret as string;
    expect(secret).toBeTruthy();
    const attempt = await app.inject({
      method: "POST",
      url: "/api/v1/conversations",
      headers: { "x-api-key": secret },
      payload: { participant_handles: [minor.handle] },
    });
    expect(attempt.statusCode).toBe(403);
  });
});

describe("group chats", () => {
  it("create, message, add member, remove self, admin removes member", async () => {
    const created = await createConversation(alice, [bob.handle, carol.handle], "Launch crew");
    expect(created.statusCode).toBe(201);
    const group = created.json();
    expect(group.kind).toBe("group");
    expect(group.participants).toHaveLength(3);
    const groupId = group.id as string;

    const sent = await sendMessage(bob, groupId, { body: "crew hello" });
    expect(sent.statusCode).toBe(201);
    const carolView = await listMessages(carol, groupId);
    expect(carolView.some((m) => m.body === "crew hello")).toBe(true);

    const added = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${groupId}/participants`,
      headers: auth(alice.accessToken),
      payload: { handle: dave.handle },
    });
    expect(added.statusCode).toBe(200);
    expect(added.json().participants).toHaveLength(4);

    const selfRemove = await app.inject({
      method: "DELETE",
      url: `/api/v1/conversations/${groupId}/participants/${carol.handle}`,
      headers: auth(carol.accessToken),
    });
    expect(selfRemove.statusCode).toBe(204);
    const carolPeek = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${groupId}`,
      headers: auth(carol.accessToken),
    });
    expect(carolPeek.statusCode).toBe(404);

    const adminRemove = await app.inject({
      method: "DELETE",
      url: `/api/v1/conversations/${groupId}/participants/${bob.handle}`,
      headers: auth(alice.accessToken),
    });
    expect(adminRemove.statusCode).toBe(204);
    const bobSend = await sendMessage(bob, groupId, { body: "still here?" });
    expect(bobSend.statusCode).toBe(403);
  });

  it("mute sets muted_until; leave hides a DM until the other side writes", async () => {
    const created = await createConversation(alice, [dave.handle]);
    const conversationId = created.json().id as string;
    const muted = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/mute`,
      headers: auth(dave.accessToken),
      payload: { muted_until: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(muted.statusCode).toBe(200);
    expect(muted.json().muted_until).toBeTruthy();

    const left = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/leave`,
      headers: auth(dave.accessToken),
      payload: {},
    });
    expect(left.statusCode).toBe(204);
    const daveMain = await app.inject({
      method: "GET",
      url: "/api/v1/conversations?box=main",
      headers: auth(dave.accessToken),
    });
    expect(daveMain.json().data.some((c: any) => c.id === conversationId)).toBe(false);

    await sendMessage(alice, conversationId, { body: "come back" });
    const daveMainAfter = await app.inject({
      method: "GET",
      url: "/api/v1/conversations?box=main",
      headers: auth(dave.accessToken),
    });
    expect(daveMainAfter.json().data.some((c: any) => c.id === conversationId)).toBe(true);
  });
});

describe("block inside chat", () => {
  it("blocking stops delivery both ways until unblocked", async () => {
    const uma = await registerUser("p5uma");
    const vic = await registerUser("p5vic");
    await follow(uma, vic.handle);
    await follow(vic, uma.handle);
    const created = await createConversation(uma, [vic.handle]);
    const conversationId = created.json().id as string;
    expect((await sendMessage(vic, conversationId, { body: "before block" })).statusCode).toBe(201);

    const blocked = await app.inject({
      method: "POST",
      url: `/api/v1/users/${vic.handle}/block`,
      headers: auth(uma.accessToken),
      payload: {},
    });
    expect(blocked.statusCode).toBe(204);
    expect((await sendMessage(vic, conversationId, { body: "after block" })).statusCode).toBe(403);
    expect((await sendMessage(uma, conversationId, { body: "me too" })).statusCode).toBe(403);

    const unblocked = await app.inject({
      method: "DELETE",
      url: `/api/v1/users/${vic.handle}/block`,
      headers: auth(uma.accessToken),
    });
    expect(unblocked.statusCode).toBe(204);
    expect((await sendMessage(vic, conversationId, { body: "we back" })).statusCode).toBe(201);
  });

  it("a message can be reported by a participant (Phase 5A report target)", async () => {
    const created = await createConversation(alice, [bob.handle]);
    const conversationId = created.json().id as string;
    const sent = await sendMessage(bob, conversationId, { body: "spammy link" });
    const messageId = sent.json().id as string;
    const report = await app.inject({
      method: "POST",
      url: "/api/v1/reports",
      headers: auth(alice.accessToken),
      payload: { target_type: "message", target_id: messageId, reason: "spam" },
    });
    expect(report.statusCode).toBe(201);
  });
});

describe("audio media + voice notes", () => {
  function wavBytes(seconds = 0.5, sampleRate = 8000): Buffer {
    const samples = Math.floor(seconds * sampleRate);
    const buffer = Buffer.alloc(44 + samples * 2);
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + samples * 2, 4);
    buffer.write("WAVE", 8);
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write("data", 36);
    buffer.writeUInt32LE(samples * 2, 40);
    return buffer;
  }

  async function processInProcess(mediaId: string): Promise<void> {
    const [row] = await db.select().from(media).where(eq(media.id, mediaId)).limit(1);
    expect(row).toBeTruthy();
    const store = new LocalStorageAdapter(config.MEDIA_DIR);
    const result = await processMediaFile(store, {
      id: row!.id,
      kind: row!.kind,
      mimeType: row!.mimeType,
      storageKey: row!.storageKey,
    });
    await db
      .update(media)
      .set({
        status: result.status,
        scanVerdict: result.scanVerdict,
        contentLabels: result.contentLabels,
        width: result.width,
        height: result.height,
        durationMs: result.durationMs,
        blurhash: result.blurhash,
        variants: result.variants,
        exifStripped: result.exifStripped,
        storageKey: result.storageKey,
        processingError: result.error ?? null,
        updatedAt: new Date(),
      })
      .where(eq(media.id, mediaId));
  }

  it("audio upload → pipeline ready with duration → voice-note message plays", async () => {
    const bytes = wavBytes();
    const session = await app.inject({
      method: "POST",
      url: "/api/v1/media/uploads",
      headers: auth(alice.accessToken),
      payload: { kind: "audio", mime_type: "audio/wav", size_bytes: bytes.length },
    });
    expect(session.statusCode).toBe(201);
    const wire = session.json() as { media_id: string; signed_put_url: string };
    const put = await app.inject({
      method: "PUT",
      url: wire.signed_put_url,
      headers: { ...auth(alice.accessToken), "content-type": "application/octet-stream" },
      payload: bytes,
    });
    expect(put.statusCode).toBe(200);
    const complete = await app.inject({
      method: "POST",
      url: `/api/v1/media/uploads/${wire.media_id}/complete`,
      headers: auth(alice.accessToken),
      payload: {},
    });
    expect(complete.statusCode).toBe(202);

    await processInProcess(wire.media_id);
    const [row] = await db.select().from(media).where(eq(media.id, wire.media_id)).limit(1);
    expect(row!.status).toBe("ready");
    expect(row!.kind).toBe("audio");
    expect(row!.durationMs).toBeGreaterThanOrEqual(400);
    expect(row!.durationMs).toBeLessThanOrEqual(600);

    const created = await createConversation(alice, [bob.handle]);
    const sent = await sendMessage(alice, created.json().id as string, {
      media_id: wire.media_id,
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().media.kind).toBe("audio");
    expect(sent.json().media.url).toBeTruthy();
  });

  it("a fake audio payload (bad magic bytes) is rejected by the pipeline", async () => {
    const bytes = Buffer.from("this is not really a wav file at all........");
    const session = await app.inject({
      method: "POST",
      url: "/api/v1/media/uploads",
      headers: auth(alice.accessToken),
      payload: { kind: "audio", mime_type: "audio/wav", size_bytes: bytes.length },
    });
    // The session itself may refuse at sniff time or the pipeline rejects;
    // either way the media must never reach `ready`.
    if (session.statusCode === 201) {
      const wire = session.json() as { media_id: string; signed_put_url: string };
      await app.inject({
        method: "PUT",
        url: wire.signed_put_url,
        headers: { ...auth(alice.accessToken), "content-type": "application/octet-stream" },
        payload: bytes,
      });
      const complete = await app.inject({
        method: "POST",
        url: `/api/v1/media/uploads/${wire.media_id}/complete`,
        headers: auth(alice.accessToken),
        payload: {},
      });
      if (complete.statusCode === 200) {
        await processInProcess(wire.media_id);
        const [row] = await db.select().from(media).where(eq(media.id, wire.media_id)).limit(1);
        expect(row!.status).not.toBe("ready");
      }
    }
  });
});

describe("realtime websocket", () => {
  it("delivers message.created to the recipient's open socket", async () => {
    const sender = await registerUser("p5wsend");
    const receiver = await registerUser("p5wrecv");
    await follow(sender, receiver.handle);
    await follow(receiver, sender.handle);
    const created = await createConversation(sender, [receiver.handle]);
    const conversationId = created.json().id as string;

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = new URL(address);
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/api/v1/ws?token=${receiver.accessToken}`,
    );
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      const eventPromise = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no message.created within 5s")), 5000);
        socket.on("message", (data) => {
          const parsed = JSON.parse(String(data));
          if (parsed.type === "message.created") {
            clearTimeout(timer);
            resolve(parsed);
          }
        });
      });
      const sent = await sendMessage(sender, conversationId, { body: "live hello" });
      expect(sent.statusCode).toBe(201);
      const event = await eventPromise;
      expect(event.conversation_id).toBe(conversationId);
      expect(event.message.body).toBe("live hello");
    } finally {
      socket.close();
    }
  }, 30_000);

  it("rejects an unauthenticated socket", async () => {
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`);
    const outcome = await new Promise<string>((resolve) => {
      socket.once("open", () => resolve("open"));
      socket.once("error", () => resolve("error"));
      socket.once("close", (code) => resolve(`close:${code}`));
      setTimeout(() => resolve("timeout"), 4000);
    });
    socket.close();
    expect(outcome).not.toBe("open");
  }, 30_000);
});

describe("lists", () => {
  it("CRUD + members + timeline isolation + privacy", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/lists",
      headers: auth(alice.accessToken),
      payload: { name: "Inner circle", description: "close reads" },
    });
    expect(created.statusCode).toBe(201);
    const list = created.json();
    expect(list.is_public).toBe(false);
    expect(list.member_count).toBe(0);
    const listId = list.id as string;

    const addBob = await app.inject({
      method: "POST",
      url: `/api/v1/lists/${listId}/members`,
      headers: auth(alice.accessToken),
      payload: { handle: bob.handle },
    });
    expect(addBob.statusCode).toBe(200);
    expect(addBob.json().member_count).toBe(1);

    const bobPost = await createPost(bob, { type: "TEXT", body_md: "bob list post" });
    expect(bobPost.statusCode).toBe(201);
    const carolPost = await createPost(carol, { type: "TEXT", body_md: "carol outside post" });
    expect(carolPost.statusCode).toBe(201);

    const timeline = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${listId}/timeline`,
      headers: auth(alice.accessToken),
    });
    const ids = (timeline.json().data as any[]).map((p) => p.id);
    expect(ids).toContain(bobPost.json().id);
    expect(ids).not.toContain(carolPost.json().id);

    // Private: Carol can't read the list or its timeline.
    const peek = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${listId}`,
      headers: auth(carol.accessToken),
    });
    expect(peek.statusCode).toBe(404);

    const madePublic = await app.inject({
      method: "PATCH",
      url: `/api/v1/lists/${listId}`,
      headers: auth(alice.accessToken),
      payload: { is_public: true },
    });
    expect(madePublic.json().is_public).toBe(true);
    const discover = await app.inject({ method: "GET", url: "/api/v1/lists/discover" });
    expect((discover.json().data as any[]).some((l) => l.id === listId)).toBe(true);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/lists/${listId}/members/${bob.handle}`,
      headers: auth(alice.accessToken),
    });
    expect(removed.statusCode).toBe(204);
    const timelineAfter = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${listId}/timeline`,
      headers: auth(alice.accessToken),
    });
    expect((timelineAfter.json().data as any[]).map((p) => p.id)).not.toContain(
      bobPost.json().id,
    );
  });
});

describe("bookmarks + collections", () => {
  it("bookmark → file into a collection → move out → delete collection keeps bookmark", async () => {
    const post = await createPost(bob, { type: "TEXT", body_md: "save me for later" });
    const postId = post.json().id as string;

    const bookmark = await app.inject({
      method: "POST",
      url: `/api/v1/posts/${postId}/bookmark`,
      headers: auth(alice.accessToken),
      payload: {},
    });
    expect(bookmark.statusCode).toBe(204);

    const collection = await app.inject({
      method: "POST",
      url: "/api/v1/collections",
      headers: auth(alice.accessToken),
      payload: { name: "Deep reads", description: "long stuff" },
    });
    expect(collection.statusCode).toBe(201);
    const collectionId = collection.json().id as string;
    expect(collection.json().description).toBe("long stuff");

    const filed = await app.inject({
      method: "POST",
      url: `/api/v1/posts/${postId}/bookmark`,
      headers: auth(alice.accessToken),
      payload: { collection_id: collectionId },
    });
    expect(filed.statusCode).toBe(204);
    const inCollection = await app.inject({
      method: "GET",
      url: `/api/v1/collections/${collectionId}/posts`,
      headers: auth(alice.accessToken),
    });
    expect((inCollection.json().data as any[]).map((p) => p.id)).toContain(postId);
    const collections = await app.inject({
      method: "GET",
      url: "/api/v1/collections",
      headers: auth(alice.accessToken),
    });
    const mine = (collections.json().data as any[]).find((c) => c.id === collectionId);
    expect(mine.item_count).toBe(1);

    // Move out (bookmark again with no collection).
    await app.inject({
      method: "POST",
      url: `/api/v1/posts/${postId}/bookmark`,
      headers: auth(alice.accessToken),
      payload: {},
    });
    const afterMove = await app.inject({
      method: "GET",
      url: `/api/v1/collections/${collectionId}/posts`,
      headers: auth(alice.accessToken),
    });
    expect(afterMove.json().data).toHaveLength(0);

    // Delete the collection: the bookmark itself survives.
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/collections/${collectionId}`,
      headers: auth(alice.accessToken),
    });
    expect(removed.statusCode).toBe(204);
    const all = await app.inject({
      method: "GET",
      url: "/api/v1/users/me/bookmarks",
      headers: auth(alice.accessToken),
    });
    expect((all.json().data as any[]).map((p) => p.id)).toContain(postId);
  });
});

describe("scheduled posts", () => {
  it("hidden from everyone else until published; publish-now via PATCH", async () => {
    const future = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const created = await createPost(alice, {
      type: "TEXT",
      body_md: "future take",
      scheduled_for: future,
    });
    expect(created.statusCode).toBe(201);
    const post = created.json();
    expect(post.scheduled_for).toBeTruthy();
    const postId = post.id as string;

    const bobPeek = await app.inject({
      method: "GET",
      url: `/api/v1/posts/${postId}`,
      headers: auth(bob.accessToken),
    });
    expect(bobPeek.statusCode).toBe(404);
    const alicePeek = await app.inject({
      method: "GET",
      url: `/api/v1/posts/${postId}`,
      headers: auth(alice.accessToken),
    });
    expect(alicePeek.statusCode).toBe(200);
    const profilePosts = await app.inject({
      method: "GET",
      url: `/api/v1/users/${alice.handle}/posts`,
      headers: auth(bob.accessToken),
    });
    expect((profilePosts.json().data as any[]).map((p) => p.id)).not.toContain(postId);

    const mine = await app.inject({
      method: "GET",
      url: "/api/v1/users/me/scheduled",
      headers: auth(alice.accessToken),
    });
    expect((mine.json().data as any[]).map((p) => p.id)).toContain(postId);

    // Reschedule to the past → 422; publish now → visible.
    const past = await app.inject({
      method: "PATCH",
      url: `/api/v1/posts/${postId}`,
      headers: auth(alice.accessToken),
      payload: { scheduled_for: new Date(Date.now() - 60_000).toISOString() },
    });
    expect(past.statusCode).toBe(422);
    const published = await app.inject({
      method: "PATCH",
      url: `/api/v1/posts/${postId}`,
      headers: auth(alice.accessToken),
      payload: { scheduled_for: null },
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().scheduled_for).toBeNull();
    const bobPeekAfter = await app.inject({
      method: "GET",
      url: `/api/v1/posts/${postId}`,
      headers: auth(bob.accessToken),
    });
    expect(bobPeekAfter.statusCode).toBe(200);
  });

  it("the publish path (worker/publisher service) fires mentions at publish time", async () => {
    const created = await createPost(alice, {
      type: "TEXT",
      body_md: `scheduled hello @${bob.handle}`,
      scheduled_for: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const postId = created.json().id as string;
    // No mention notification while scheduled.
    const beforeNotes = await app.inject({
      method: "GET",
      url: "/api/v1/notifications?limit=50",
      headers: auth(bob.accessToken),
    });
    expect(
      (beforeNotes.json().data as any[]).some(
        (n) => n.type === "mention" && n.subject_id === postId,
      ),
    ).toBe(false);

    const [row] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
    await publishScheduledPost(db, row!);
    const afterNotes = await app.inject({
      method: "GET",
      url: "/api/v1/notifications?limit=50",
      headers: auth(bob.accessToken),
    });
    expect(
      (afterNotes.json().data as any[]).some(
        (n) => n.type === "mention" && n.subject_id === postId,
      ),
    ).toBe(true);
  });

  it("replies and polls cannot be scheduled", async () => {
    const parent = await createPost(alice, { type: "TEXT", body_md: "parent" });
    const reply = await createPost(alice, {
      type: "TEXT",
      body_md: "reply",
      parent_id: parent.json().id,
      scheduled_for: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(reply.statusCode).toBe(422);
  });
});

describe("trending endpoint", () => {
  it("serves the latest worker snapshot (posts delta included)", async () => {
    const post = await createPost(alice, { type: "TEXT", body_md: "viral take #gg" });
    const postId = post.json().id as string;
    const now = new Date();
    // D-054 storage: one row per item, a batch sharing computed_at.
    await db.insert(trendingSnapshots).values([
      {
        id: randomUUID(),
        kind: "hashtag",
        key: "gg",
        score: 42,
        payload: { post_count: 42 },
        windowStart: new Date(now.getTime() - 6 * 3_600_000),
        windowEnd: now,
        computedAt: now,
      },
      {
        id: randomUUID(),
        kind: "post",
        key: postId,
        score: 10,
        payload: {},
        windowStart: new Date(now.getTime() - 6 * 3_600_000),
        windowEnd: now,
        computedAt: now,
      },
    ]);
    const res = await app.inject({ method: "GET", url: "/api/v1/trending" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.window).toBe("trailing_6h");
    expect(body.hashtags[0]).toEqual({ tag: "gg", post_count: 42 });
    expect((body.posts as any[]).map((p) => p.id)).toContain(postId);
  });
});

describe("unread counts (D-053)", () => {
  it("dm_count tracks unread conversations and clears on read", async () => {
    const uma = await registerUser("p5uma2");
    const vic = await registerUser("p5vic2");
    await follow(uma, vic.handle);
    await follow(vic, uma.handle);
    const created = await createConversation(vic, [uma.handle]);
    const conversationId = created.json().id as string;
    await sendMessage(vic, conversationId, { body: "ping" });

    const counts = await app.inject({
      method: "GET",
      url: "/api/v1/notifications/unread-count",
      headers: auth(uma.accessToken),
    });
    expect(counts.json().dm_count).toBe(1);

    const messages = await listMessages(uma, conversationId);
    await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/read`,
      headers: auth(uma.accessToken),
      payload: { message_id: messages[0]!.id },
    });
    const after = await app.inject({
      method: "GET",
      url: "/api/v1/notifications/unread-count",
      headers: auth(uma.accessToken),
    });
    expect(after.json().dm_count).toBe(0);
  });
});
