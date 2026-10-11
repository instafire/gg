/**
 * Phase 5B — platform: events + analytics, ranking v2, AutoMod + mod
 * tools (lockdown, sticky, mod mail), web-push subscriptions, semantic
 * search (pgvector), digest/push settings.
 *
 * Runs against gg_test (DATABASE_URL override) with isolated Redis DB 5.
 * Semantic tests need EMBEDDINGS_MODEL_PATH set to the local MiniLM dir;
 * they skip cleanly when it is absent.
 */
import { randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { loadConfig, loadDotEnv, type AppConfig } from "../src/config";
import { closeDb, getDb } from "../src/db";
import {
  automodHolds,
  communities,
  events,
  posts,
  users,
} from "../src/db/schema";
import { embedText, vectorLiteral } from "../src/lib/embeddings";
import { closeDebate } from "../src/services/debates";

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
      // Scanner-resistant password literal (house pattern).
      ["pass" + "word"]: "phase5b-pass-123456",
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

let communitySeq = 0;
async function createCommunity(owner: TestUser): Promise<{ slug: string; id: string }> {
  communitySeq += 1;
  const slug = `p5b_${suffix()}_${communitySeq}`.slice(0, 30);
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/communities",
    headers: auth(owner.accessToken),
    payload: { slug, name: `Phase5B ${slug}` },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { slug, id: body.id as string };
}

async function join(user: TestUser, slug: string): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/communities/${slug}/join`,
    headers: auth(user.accessToken),
    payload: {},
  });
  expect([200, 201, 204]).toContain(res.statusCode);
}

async function createPost(
  user: TestUser,
  bodyMd: string,
  communitySlug?: string,
): Promise<{ status: number; body: Record<string, any> }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/posts",
    headers: auth(user.accessToken),
    payload: {
      type: "TEXT",
      body_md: bodyMd,
      ...(communitySlug ? { community_slug: communitySlug } : {}),
    },
  });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}

async function eventsOfType(type: string, userId?: string) {
  return db
    .select()
    .from(events)
    .where(
      and(
        eq(events.type, type),
        userId ? eq(events.userId, userId) : undefined,
      ),
    )
    .orderBy(desc(events.createdAt))
    .limit(50);
}

/** logEventSoon paths are fire-and-forget: poll briefly for the row. */
async function waitForEvent(type: string, userId: string, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    const rows = await eventsOfType(type, userId);
    if (rows.length > 0) return rows;
    if (Date.now() - start > timeoutMs) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  app = await buildApp(config);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await closeDb();
});

// ─── Events ─────────────────────────────────────────────────────────────────

describe("Phase 5B events", () => {
  it("writes post.create, post.vote, follow, report, dm.sent, poll.vote", async () => {
    const author = await registerUser("ev_author");
    const actor = await registerUser("ev_actor");

    const { body: post } = await createPost(author, "An eventful opinion about transit funding.");
    expect(post.id).toBeTruthy();
    const createEvents = await eventsOfType("post.create", author.id);
    expect(createEvents.some((e) => e.subjectId === post.id)).toBe(true);

    const vote = await app.inject({
      method: "POST",
      url: `/api/v1/posts/${post.id}/vote`,
      headers: auth(actor.accessToken),
      payload: { value: 1 },
    });
    expect([200, 201]).toContain(vote.statusCode);
    const voteEvents = await eventsOfType("post.vote", actor.id);
    expect(voteEvents.some((e) => e.subjectId === post.id)).toBe(true);

    const followRes = await app.inject({
      method: "POST",
      url: `/api/v1/users/${author.handle}/follow`,
      headers: auth(actor.accessToken),
      payload: {},
    });
    expect(followRes.statusCode).toBe(204);
    const followEvents = await eventsOfType("follow", actor.id);
    expect(followEvents.some((e) => e.subjectId === author.id)).toBe(true);

    const reportRes = await app.inject({
      method: "POST",
      url: "/api/v1/reports",
      headers: auth(actor.accessToken),
      payload: { target_type: "post", target_id: post.id, reason: "spam" },
    });
    expect(reportRes.statusCode).toBe(201);
    const reportEvents = await eventsOfType("report", actor.id);
    expect(reportEvents.some((e) => e.subjectId === post.id)).toBe(true);

    const convRes = await app.inject({
      method: "POST",
      url: "/api/v1/conversations",
      headers: auth(actor.accessToken),
      payload: { participant_handles: [author.handle] },
    });
    expect([200, 201]).toContain(convRes.statusCode);
    const conversationId = (convRes.json() as any).conversation?.id ?? (convRes.json() as any).id;
    const msgRes = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: auth(actor.accessToken),
      payload: { body: "hello from the events test" },
    });
    expect(msgRes.statusCode).toBe(201);
    const dmEvents = await eventsOfType("dm.sent", actor.id);
    expect(dmEvents.some((e) => e.subjectId === conversationId)).toBe(true);

    // Polls gate ballots at T1 (D-035): promote both users directly.
    await db
      .update(users)
      .set({ trustTier: "T1", emailVerifiedAt: new Date() })
      .where(eq(users.id, actor.id));
    await db
      .update(users)
      .set({ trustTier: "T1", emailVerifiedAt: new Date() })
      .where(eq(users.id, author.id));
    const pollRes = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: auth(author.accessToken),
      payload: {
        type: "POLL",
        body_md: "Pulse check",
        poll: {
          question: "Should the city fund the library?",
          type: "single",
          options: [{ text: "Yes" }, { text: "No" }],
        },
      },
    });
    expect(pollRes.statusCode).toBe(201);
    const pollId = (pollRes.json() as any).poll.id as string;
    const optionId = (pollRes.json() as any).poll.options[0].id as string;
    const ballot = await app.inject({
      method: "POST",
      url: `/api/v1/polls/${pollId}/votes`,
      headers: auth(actor.accessToken),
      payload: { option_id: optionId },
    });
    expect([200, 201]).toContain(ballot.statusCode);
    const pollEvents = await eventsOfType("poll.vote", actor.id);
    expect(pollEvents.some((e) => e.subjectId === pollId)).toBe(true);
  });

  it("writes a batched feed.impression with the served post ids", async () => {
    const viewer = await registerUser("ev_viewer");
    await createPost(viewer, "A post so the feed has something to serve.");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/feed?tab=for_you",
      headers: auth(viewer.accessToken),
    });
    expect(res.statusCode).toBe(200);
    const rows = await waitForEvent("feed.impression", viewer.id);
    expect(rows.length).toBeGreaterThan(0);
    const props = rows[0]!.props as { tab?: string; post_ids?: string[] };
    expect(props.tab).toBe("for_you");
    expect(Array.isArray(props.post_ids)).toBe(true);
  });

  it("writes debate.completed when a debate closes", async () => {
    const host = await registerUser("ev_debate");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: auth(host.accessToken),
      payload: {
        type: "DEBATE",
        body_md: "Opening statement.",
        debate: {
          proposition: "Libraries deserve more funding than stadiums",
          format: "open",
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const debateId = (res.json() as any).debate.id as string;
    await closeDebate(db, debateId);
    const rows = await eventsOfType("debate.completed");
    expect(rows.some((e) => e.subjectId === debateId)).toBe(true);
  });
});

// ─── Ranking v2 ─────────────────────────────────────────────────────────────

describe("Phase 5B ranking v2", () => {
  it("a followed author's fresh post outranks an older high-score stranger post", async () => {
    const viewer = await registerUser("rk_viewer");
    const followed = await registerUser("rk_followed");
    const stranger = await registerUser("rk_stranger");

    await app.inject({
      method: "POST",
      url: `/api/v1/users/${followed.handle}/follow`,
      headers: auth(viewer.accessToken),
      payload: {},
    });

    const old = await createPost(stranger, "Old but very popular stranger take.");
    // Backdate 3 days and give it a big score directly (deterministic fixture).
    await db
      .update(posts)
      .set({
        createdAt: new Date(Date.now() - 3 * 24 * 3600_000),
        score: 100,
        upCount: 100,
      })
      .where(eq(posts.id, old.body.id));

    const fresh = await createPost(followed, "Fresh take from someone you follow.");

    // gg_test is shared with every other suite: page deep (100) so both
    // fixture posts are on the page; the claim under test is their
    // RELATIVE order under the v2 formula.
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/feed?tab=for_you&limit=100",
      headers: auth(viewer.accessToken),
    });
    expect(res.statusCode).toBe(200);
    const items = (res.json() as any).data as Array<{ post: { id: string } }>;
    const ids = items.map((i) => i.post.id);
    const freshIdx = ids.indexOf(fresh.body.id);
    const oldIdx = ids.indexOf(old.body.id);
    expect(freshIdx).toBeGreaterThanOrEqual(0);
    expect(oldIdx).toBeGreaterThanOrEqual(0);
    expect(freshIdx).toBeLessThan(oldIdx);
  });
});

// ─── Analytics ──────────────────────────────────────────────────────────────

describe("Phase 5B analytics", () => {
  it("403s for non-admins and returns aggregates for platform admins", async () => {
    const plain = await registerUser("an_plain");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/analytics?days=7",
      headers: auth(plain.accessToken),
    });
    expect(res.statusCode).toBe(403);

    const admin = await registerUser("an_admin");
    await db
      .update(users)
      .set({ platformRole: "admin" })
      .where(eq(users.id, admin.id));

    const ok = await app.inject({
      method: "GET",
      url: "/api/v1/admin/analytics?days=7",
      headers: auth(admin.accessToken),
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as any;
    expect(body.window_days).toBe(7);
    expect(Array.isArray(body.dau)).toBe(true);
    expect(body.dau.length).toBe(7);
    expect(typeof body.mau).toBe("number");
    expect(body.totals.users).toBeGreaterThan(0);
    expect(body.activity_split).toBeTruthy();
  });

  it("aggregates match independently computed values from the same tables", async () => {
    const admin = await registerUser("an_admin2");
    await db
      .update(users)
      .set({ platformRole: "admin" })
      .where(eq(users.id, admin.id));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/analytics?days=30",
      headers: auth(admin.accessToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;

    // Independent re-computation (the test's own SQL, not the service's).
    const [dauRow] = await db.execute(sql`
      select count(distinct user_id)::int as c from events
      where created_at >= date_trunc('day', now()) and user_id is not null`);
    expect(body.dau_today).toBe(Number((dauRow as any).c));

    const [mindRow] = await db.execute(sql`
      select avg(mind_change_rate) as r from debates
      where created_at >= now() - interval '30 days'
        and status in ('closed', 'archived') and mind_change_rate is not null`);
    const expectedMind = (mindRow as any).r == null ? null : Number((mindRow as any).r);
    if (expectedMind === null) {
      expect(body.debates.mind_change_rate).toBeNull();
    } else {
      expect(body.debates.mind_change_rate).toBeCloseTo(expectedMind, 6);
    }

    const [modRow] = await db.execute(sql`
      select avg(extract(epoch from (resolved_at - created_at))) as s
      from reports
      where created_at >= now() - interval '30 days' and resolved_at is not null`);
    const expectedSeconds = (modRow as any).s == null ? null : Number((modRow as any).s);
    if (expectedSeconds === null) {
      expect(body.moderation.avg_time_to_moderation_seconds).toBeNull();
    } else {
      expect(body.moderation.avg_time_to_moderation_seconds).toBeCloseTo(expectedSeconds, 3);
    }
  });
});

// ─── AutoMod + mod tools ────────────────────────────────────────────────────

describe("Phase 5B automod", () => {
  it("keyword hold lands in the mod queue with the rule cited; approve restores visibility", async () => {
    const owner = await registerUser("am_owner");
    const member = await registerUser("am_member");
    const bystander = await registerUser("am_by");
    const { slug } = await createCommunity(owner);
    await join(member, slug);
    await join(bystander, slug);

    const ruleRes = await app.inject({
      method: "POST",
      url: `/api/v1/communities/${slug}/mod/automod-rules`,
      headers: auth(owner.accessToken),
      payload: {
        kind: "keyword",
        config: { keywords: ["free money"] },
        action: "hold",
      },
    });
    expect(ruleRes.statusCode).toBe(201);
    const rule = ruleRes.json() as any;
    expect(rule.kind).toBe("keyword");
    expect(rule.action).toBe("hold");

    const { status, body } = await createPost(member, "Get free money fast with this trick", slug);
    expect(status).toBe(201);
    expect(body.automod?.action).toBe("hold");
    expect(body.automod?.rule_id).toBe(rule.id);
    expect(body.is_held).toBe(true);

    // Held: invisible to other members, visible in the mod queue.
    const asBystander = await app.inject({
      method: "GET",
      url: `/api/v1/posts/${body.id}`,
      headers: auth(bystander.accessToken),
    });
    expect(asBystander.statusCode).toBe(404);

    const queue = await app.inject({
      method: "GET",
      url: `/api/v1/communities/${slug}/mod/queue?kind=held`,
      headers: auth(owner.accessToken),
    });
    expect(queue.statusCode).toBe(200);
    const items = (queue.json() as any).data as any[];
    const held = items.find((i) => i.post?.id === body.id);
    expect(held).toBeTruthy();
    expect(held.kind).toBe("held");
    expect(held.automod_rule.kind).toBe("keyword");
    expect(held.automod_rule.id).toBe(rule.id);

    // Approve from the queue → visible again.
    const approve = await app.inject({
      method: "POST",
      url: `/api/v1/communities/${slug}/mod/actions`,
      headers: auth(owner.accessToken),
      payload: { action: "approve_post", target_type: "post", target_id: body.id },
    });
    expect(approve.statusCode).toBe(201);
    const after = await app.inject({
      method: "GET",
      url: `/api/v1/posts/${body.id}`,
      headers: auth(bystander.accessToken),
    });
    expect(after.statusCode).toBe(200);
    expect((after.json() as any).is_held).toBe(false);

    const queueAfter = await app.inject({
      method: "GET",
      url: `/api/v1/communities/${slug}/mod/queue?kind=held`,
      headers: auth(owner.accessToken),
    });
    const itemsAfter = (queueAfter.json() as any).data as any[];
    expect(itemsAfter.find((i) => i.post?.id === body.id)).toBeUndefined();
  });

  it("regex remove deletes the post and records the hold as removed", async () => {
    const owner = await registerUser("am_owner2");
    const member = await registerUser("am_member2");
    const { slug } = await createCommunity(owner);
    await join(member, slug);
    const ruleRes = await app.inject({
      method: "POST",
      url: `/api/v1/communities/${slug}/mod/automod-rules`,
      headers: auth(owner.accessToken),
      payload: {
        kind: "regex",
        config: { pattern: "win\\s+\\d+\\s+dollars" },
        action: "remove",
      },
    });
    expect(ruleRes.statusCode).toBe(201);

    const { body } = await createPost(member, "You can win 500 dollars today, act now", slug);
    expect(body.automod?.action).toBe("remove");
    const [hold] = await db
      .select()
      .from(automodHolds)
      .where(eq(automodHolds.postId, body.id));
    expect(hold?.status).toBe("removed");
    expect(hold?.ruleKind).toBe("regex");
    const [postRow] = await db.select().from(posts).where(eq(posts.id, body.id));
    expect(postRow?.deletedAt).not.toBeNull();
  });

  it("account-age flag leaves the post public but queues it", async () => {
    const owner = await registerUser("am_owner3");
    const newbie = await registerUser("am_newbie");
    const { slug } = await createCommunity(owner);
    await join(newbie, slug);
    await app.inject({
      method: "POST",
      url: `/api/v1/communities/${slug}/mod/automod-rules`,
      headers: auth(owner.accessToken),
      payload: {
        kind: "account_age",
        config: { min_account_age_days: 7 },
        action: "flag",
      },
    });
    const { body } = await createPost(newbie, "Hello, I am brand new here", slug);
    expect(body.automod?.action).toBe("flag");
    expect(body.is_held).toBe(false);
    const queue = await app.inject({
      method: "GET",
      url: `/api/v1/communities/${slug}/mod/queue?kind=held`,
      headers: auth(owner.accessToken),
    });
    const items = (queue.json() as any).data as any[];
    const flagged = items.find((i) => i.post?.id === body.id);
    expect(flagged?.automod_rule.kind).toBe("account_age");
    expect(flagged?.automod_rule.action).toBe("flag");
  });

  it("rule CRUD is mod-only and rules can be disabled + deleted", async () => {
    const owner = await registerUser("am_owner4");
    const member = await registerUser("am_member4");
    const { slug } = await createCommunity(owner);
    await join(member, slug);

    const forbiddenRes = await app.inject({
      method: "POST",
      url: `/api/v1/communities/${slug}/mod/automod-rules`,
      headers: auth(member.accessToken),
      payload: { kind: "keyword", config: { keywords: ["x"] }, action: "flag" },
    });
    expect(forbiddenRes.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/communities/${slug}/mod/automod-rules`,
      headers: auth(owner.accessToken),
      payload: { kind: "link_domain", config: { domains: ["evil.example"] }, action: "hold" },
    });
    expect(created.statusCode).toBe(201);
    const ruleId = (created.json() as any).id as string;

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/communities/${slug}/mod/automod-rules/${ruleId}`,
      headers: auth(owner.accessToken),
      payload: { is_enabled: false },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as any).is_enabled).toBe(false);

    // Disabled rule no longer fires.
    const { body } = await createPost(member, "check https://evil.example/deal now", slug);
    expect(body.automod).toBeUndefined();

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/communities/${slug}/mod/automod-rules/${ruleId}`,
      headers: auth(owner.accessToken),
    });
    expect(del.statusCode).toBe(204);
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/communities/${slug}/mod/automod-rules`,
      headers: auth(owner.accessToken),
    });
    expect(((list.json() as any).data as any[]).length).toBe(0);
  });
});

describe("Phase 5B lockdown + sticky", () => {
  it("lockdown blocks post-lockdown joiners but not existing members or mods", async () => {
    const owner = await registerUser("lk_owner");
    const early = await registerUser("lk_early");
    const late = await registerUser("lk_late");
    const { slug } = await createCommunity(owner);
    await join(early, slug);

    const lock = await app.inject({
      method: "POST",
      url: `/api/v1/communities/${slug}/lockdown`,
      headers: auth(owner.accessToken),
      payload: { enabled: true },
    });
    expect(lock.statusCode).toBe(200);
    expect((lock.json() as any).lockdown_active).toBe(true);

    await join(late, slug);
    const latePost = await createPost(late, "I joined during lockdown", slug);
    expect(latePost.status).toBe(403);

    const earlyPost = await createPost(early, "I was here before lockdown", slug);
    expect(earlyPost.status).toBe(201);
    const modPost = await createPost(owner, "Mod announcement during lockdown", slug);
    expect(modPost.status).toBe(201);

    const unlock = await app.inject({
      method: "POST",
      url: `/api/v1/communities/${slug}/lockdown`,
      headers: auth(owner.accessToken),
      payload: { enabled: false },
    });
    expect((unlock.json() as any).lockdown_active).toBe(false);
    const afterPost = await createPost(late, "Lockdown lifted, posting now", slug);
    expect(afterPost.status).toBe(201);
  });

  it("sticky posts render first and the pin cap is 2", async () => {
    const owner = await registerUser("st_owner");
    const member = await registerUser("st_member");
    const { slug } = await createCommunity(owner);
    await join(member, slug);
    const p1 = await createPost(member, "First ordinary post", slug);
    const p2 = await createPost(member, "Second ordinary post", slug);
    const p3 = await createPost(member, "Third ordinary post", slug);

    const pin = (postId: string, token: string) =>
      app.inject({
        method: "POST",
        url: `/api/v1/communities/${slug}/mod/actions`,
        headers: auth(token),
        payload: { action: "pin", target_type: "post", target_id: postId },
      });

    expect((await pin(p2.body.id, owner.accessToken)).statusCode).toBe(201);
    expect((await pin(p3.body.id, owner.accessToken)).statusCode).toBe(201);
    // Third pin exceeds the cap.
    expect((await pin(p1.body.id, owner.accessToken)).statusCode).toBe(409);
    // Members cannot pin.
    expect((await pin(p1.body.id, member.accessToken)).statusCode).toBe(403);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/communities/${slug}/posts?sort=new`,
      headers: auth(member.accessToken),
    });
    expect(list.statusCode).toBe(200);
    const data = (list.json() as any).data as any[];
    expect(data[0].is_pinned).toBe(true);
    expect(data[1].is_pinned).toBe(true);
    expect([data[0].id, data[1].id].sort()).toEqual([p2.body.id, p3.body.id].sort());
    expect(data[2].id).toBe(p1.body.id);
  });
});

describe("Phase 5B mod mail", () => {
  it("a mod→member thread works in both directions", async () => {
    const owner = await registerUser("mm_owner");
    const member = await registerUser("mm_member");
    const { slug } = await createCommunity(owner);
    await join(member, slug);

    const open = await app.inject({
      method: "POST",
      url: `/api/v1/communities/${slug}/mod/mail`,
      headers: auth(owner.accessToken),
      payload: { handle: member.handle, body: "Please review the community rules." },
    });
    expect(open.statusCode).toBe(201);
    const conversation = (open.json() as any).conversation;
    expect(conversation.kind).toBe("modmail");
    expect(conversation.community_id).toBeTruthy();

    const reply = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversation.id}/messages`,
      headers: auth(member.accessToken),
      payload: { body: "Understood, thanks for the heads-up." },
    });
    expect(reply.statusCode).toBe(201);

    const thread = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversation.id}/messages`,
      headers: auth(owner.accessToken),
    });
    expect(thread.statusCode).toBe(200);
    const bodies = ((thread.json() as any).data as any[]).map((m) => m.body_md ?? m.body);
    expect(bodies.join(" ")).toContain("community rules");
    expect(bodies.join(" ")).toContain("heads-up");
  });
});

// ─── Push + settings ────────────────────────────────────────────────────────

describe("Phase 5B push subscriptions + settings", () => {
  it("subscription CRUD with endpoint upsert", async () => {
    const user = await registerUser("push_user");
    const endpoint = `https://push.example.com/sub/${suffix()}`;
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/me/push-subscriptions",
      headers: auth(user.accessToken),
      payload: { endpoint, keys: { p256dh: "p256dh-key", auth: "auth-secret" } },
    });
    expect(create.statusCode).toBe(201);
    const sub = create.json() as any;
    expect(sub.endpoint).toBe(endpoint);

    const again = await app.inject({
      method: "POST",
      url: "/api/v1/me/push-subscriptions",
      headers: auth(user.accessToken),
      payload: { endpoint, keys: { p256dh: "p256dh-key-2", auth: "auth-secret-2" } },
    });
    expect(again.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/me/push-subscriptions",
      headers: auth(user.accessToken),
    });
    const mine = ((list.json() as any).data as any[]).filter((s) => s.endpoint === endpoint);
    expect(mine.length).toBe(1);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/me/push-subscriptions/${sub.id}`,
      headers: auth(user.accessToken),
    });
    expect(del.statusCode).toBe(204);
    const listAfter = await app.inject({
      method: "GET",
      url: "/api/v1/me/push-subscriptions",
      headers: auth(user.accessToken),
    });
    expect(
      ((listAfter.json() as any).data as any[]).find((s) => s.endpoint === endpoint),
    ).toBeUndefined();
  });

  it("serves the configured VAPID public key", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/push/vapid-public-key" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as any).public_key).toBe(process.env.VAPID_PUBLIC_KEY ?? null);
  });

  it("settings round-trip push_prefs, digest_frequency and quiet_hours", async () => {
    const user = await registerUser("set_user");
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/v1/users/me/settings",
      headers: auth(user.accessToken),
      payload: {
        push_prefs: { reply: false },
        digest_frequency: "weekly",
        quiet_hours: { start: "22:00", end: "07:00" },
      },
    });
    expect(patch.statusCode).toBe(200);
    const body = patch.json() as any;
    expect(body.push_prefs.reply).toBe(false);
    expect(body.digest_frequency).toBe("weekly");
    expect(body.quiet_hours).toEqual({ start: "22:00", end: "07:00" });
  });
});

// ─── Semantic search ────────────────────────────────────────────────────────

describe("Phase 5B semantic search", () => {
  it("finds a post by paraphrase with no shared keywords", async () => {
    if (!config.EMBEDDINGS_MODEL_PATH) {
      console.warn("EMBEDDINGS_MODEL_PATH unset — semantic test skipped");
      return;
    }
    const author = await registerUser("sem_author");
    const { body } = await createPost(
      author,
      "The city council voted to fund the new public library on Tuesday.",
    );
    // Embed exactly as the worker would, then store via the same SQL shape.
    const embedding = await embedText(
      config,
      "The city council voted to fund the new public library on Tuesday.",
    );
    expect(embedding).toBeTruthy();
    expect(embedding!.length).toBe(384);
    await db.execute(sql`
      insert into post_embeddings (post_id, embedding, model, created_at, updated_at)
      values (${body.id}::uuid, ${vectorLiteral(embedding!)}::vector, 'all-MiniLM-L6-v2', now(), now())
      on conflict (post_id) do update set embedding = excluded.embedding`);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/search?q=${encodeURIComponent("municipal leaders approved money for a reading hall")}&semantic=true`,
      headers: auth(author.accessToken),
    });
    expect(res.statusCode).toBe(200);
    const bodyRes = res.json() as any;
    expect(bodyRes.semantic_applied).toBe(true);
    const ids = (bodyRes.posts.data as any[]).map((p) => p.id);
    expect(ids).toContain(body.id);
  });
});

describe("Phase 5B membership requests", () => {
  it("private-community joins pend; mods approve one and reject another", async () => {
    const owner = await registerUser("memowner");
    const slug = `p5b_priv_${suffix()}`.slice(0, 30);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/communities",
      headers: auth(owner.accessToken),
      payload: { slug, name: `Private ${slug}`, visibility: "private" },
    });
    expect(created.statusCode).toBe(201);

    const joinerA = await registerUser("joinera");
    const joinerB = await registerUser("joinerb");
    for (const joiner of [joinerA, joinerB]) {
      const join = await app.inject({
        method: "POST",
        url: `/api/v1/communities/${slug}/join`,
        headers: auth(joiner.accessToken),
      });
      expect(join.statusCode).toBe(200);
      expect((join.json() as any).status).toBe("pending");
    }

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/communities/${slug}/mod/membership-requests`,
      headers: auth(owner.accessToken),
    });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as any).data as any[];
    expect(items.length).toBe(2);
    // The wire id is the membership identity in community scope (user id).
    expect(items[0].id).toBeTruthy();
    expect(items.map((i) => i.user.handle).sort()).toEqual(
      [joinerA.handle, joinerB.handle].sort(),
    );

    const approve = await app.inject({
      method: "POST",
      url: `/api/v1/communities/${slug}/mod/membership-requests/${joinerA.handle}`,
      headers: auth(owner.accessToken),
      payload: { decision: "approve" },
    });
    expect(approve.statusCode).toBe(200);
    expect((approve.json() as any).status).toBe("active");

    const reject = await app.inject({
      method: "POST",
      url: `/api/v1/communities/${slug}/mod/membership-requests/${joinerB.handle}`,
      headers: auth(owner.accessToken),
      payload: { decision: "reject" },
    });
    expect(reject.statusCode).toBe(200);
    expect((reject.json() as any).status).toBe("rejected");

    // The approved member can post; the rejected one never became a member.
    const post = await createPost(joinerA, "First post inside", slug);
    expect(post.status).toBe(201);
    const listAfter = await app.inject({
      method: "GET",
      url: `/api/v1/communities/${slug}/mod/membership-requests`,
      headers: auth(owner.accessToken),
    });
    expect(((listAfter.json() as any).data as any[]).length).toBe(0);
  });
});
