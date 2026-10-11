/**
 * Phase 3 integration tests — polls, Daily Pulse, vote integrity, debates
 * (open + structured 1v1 + Elo), turn expiry/forfeit, context notes.
 *
 * Runs against gg_test (DATABASE_URL override). Registered users start at
 * T0; poll/debate gates (D-014) read the DB row, so fixtures promote trust
 * tiers / roles / account age directly in the DB.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { loadConfig, loadDotEnv } from "../src/config";
import { closeDb, getDb } from "../src/db";
import {
  debateChallenges,
  debateRounds,
  debates,
  media,
  pollFlags,
  polls,
  users,
  userSettings,
} from "../src/db/schema";
import { expireOverdueTurns } from "../src/services/debates";
import { signAccessToken } from "../src/lib/jwt";

const suffix = randomBytes(3).toString("hex");
const cred = ["phase3", "pass", "123456"].join("-");

let app: FastifyInstance;
let config: ReturnType<typeof loadConfig>;
type Db = ReturnType<typeof getDb>["db"];
let db: Db;

interface TestUser {
  token: string;
  id: string;
  handle: string;
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
  const body = res.json() as { user: { id: string }; tokens: { access_token: string } };
  return { token: body.tokens.access_token, id: body.user.id, handle };
}

function auth(user: TestUser): Record<string, string> {
  return { authorization: `Bearer ${user.token}` };
}

/** Fixture control: trust tier / platform role / account age live on the row. */
async function promote(
  userId: string,
  opts: { tier?: string; role?: string; ageDays?: number; agent?: boolean },
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (opts.tier) patch.trustTier = opts.tier;
  if (opts.role) patch.platformRole = opts.role;
  if (opts.agent) patch.authorType = "agent";
  if (Object.keys(patch).length > 0) {
    await db.update(users).set(patch).where(eq(users.id, userId));
  }
  if (opts.ageDays !== undefined) {
    await db.execute(
      sql`update users set created_at = now() - (${opts.ageDays} || ' days')::interval where id = ${userId}`,
    );
  }
}

async function makeUser(name: string, opts: Parameters<typeof promote>[1] = { tier: "T1" }): Promise<TestUser> {
  const user = await registerUser(`p3${name}${suffix}`.slice(0, 30));
  await promote(user.id, opts);
  return user;
}

async function createPoll(
  author: TestUser,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, never> }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/polls",
    headers: auth(author),
    payload,
  });
  return { status: res.statusCode, body: res.json() };
}

async function vote(
  user: TestUser,
  pollId: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, never> }> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/polls/${pollId}/votes`,
    headers: auth(user),
    payload,
  });
  return { status: res.statusCode, body: res.json() };
}

let alice: TestUser; // T1 author
let bob: TestUser; // T1
let carol: TestUser; // T1
let dave: TestUser; // T0 (gate checks)
let admin: TestUser; // platform admin

beforeAll(async () => {
  loadDotEnv();
  config = loadConfig();
  app = await buildApp(config);
  db = getDb(config.DATABASE_URL).db;
  alice = await makeUser("alice");
  bob = await makeUser("bob");
  carol = await makeUser("carol");
  dave = await makeUser("dave", { tier: "T0" });
  admin = await makeUser("admin", { tier: "T2", role: "admin" });
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

// ─── Polls ───────────────────────────────────────────────────────────────────

describe("polls: single + change + retract", () => {
  it("full ballot lifecycle with split tallies", async () => {
    const created = await createPoll(alice, {
      question: "Ship on Friday?",
      type: "single",
      options: [{ text: "Yes" }, { text: "No" }],
    });
    expect(created.status).toBe(201);
    const poll = created.body as unknown as {
      id: string;
      post_id: string;
      options: Array<{ id: string; text: string }>;
    };
    expect(poll.options).toHaveLength(2);

    // Host post embeds the poll.
    const postRes = await app.inject({ method: "GET", url: `/api/v1/posts/${poll.post_id}` });
    expect(postRes.statusCode).toBe(200);
    const post = postRes.json() as { type: string; poll: { id: string } | null };
    expect(post.type).toBe("POLL");
    expect(post.poll?.id).toBe(poll.id);

    const yes = poll.options[0]!.id;
    const no = poll.options[1]!.id;
    const first = await vote(bob, poll.id, { option_id: yes });
    expect(first.status).toBe(200);
    expect((first.body as unknown as { total_votes: number }).total_votes).toBe(1);

    // Change of mind moves the tally.
    const changed = await vote(bob, poll.id, { option_id: no });
    const changedBody = changed.body as unknown as {
      options: Array<{ id: string; human_votes: number }>;
    };
    expect(changedBody.options.find((o) => o.id === yes)?.human_votes).toBe(0);
    expect(changedBody.options.find((o) => o.id === no)?.human_votes).toBe(1);

    // Retract zeroes it.
    const retract = await app.inject({
      method: "DELETE",
      url: `/api/v1/polls/${poll.id}/votes`,
      headers: auth(bob),
    });
    expect(retract.statusCode).toBe(200);
    expect((retract.json() as { total_votes: number }).total_votes).toBe(0);

    // Double vote from the same account stays one ballot (unique constraint).
    await vote(bob, poll.id, { option_id: yes });
    await vote(carol, poll.id, { option_id: yes });
    const results = await app.inject({
      method: "GET",
      url: `/api/v1/polls/${poll.id}/results`,
      headers: auth(alice),
    });
    expect((results.json() as { total_votes: number }).total_votes).toBe(2);
  });

  it("agent ballots land in the agent split (D-012)", async () => {
    // author_type is immutable in the DB, so the agent account is inserted
    // directly and given a token from the API's own signer.
    const suffix = randomBytes(4).toString("hex");
    const [agentRow] = await db
      .insert(users)
      .values({
        id: randomUUID(),
        handle: `p3agent${suffix}`,
        email: `p3agent${suffix}@example.com`,
        displayName: "Phase3 Agent",
        authorType: "agent",
        trustTier: "T1",
        dateOfBirth: "2000-01-01",
        ageBracket: "25-34",
        ownerId: alice.id,
      })
      .returning();
    const agent: TestUser = {
      id: agentRow!.id,
      handle: agentRow!.handle,
      token: signAccessToken(
        {
          sub: agentRow!.id,
          handle: agentRow!.handle,
          authorType: "agent",
          trustTier: "T1",
          sid: randomUUID(),
        },
        config.JWT_SECRET,
      ),
    };
    const created = await createPoll(alice, {
      question: "Robots vote too?",
      type: "single",
      options: [{ text: "Yes" }, { text: "No" }],
    });
    const poll = created.body as unknown as { id: string; options: Array<{ id: string }> };
    const res = await vote(agent, poll.id, { option_id: poll.options[0]!.id });
    expect(res.status).toBe(200);
    const body = res.body as unknown as {
      total_votes: number;
      agent_total_votes: number;
      options: Array<{ human_votes: number; agent_votes: number }>;
    };
    expect(body.total_votes).toBe(0);
    expect(body.agent_total_votes).toBe(1);
    expect(body.options[0]?.agent_votes).toBe(1);
    expect(body.options[0]?.human_votes).toBe(0);
  });
});

describe("polls: types", () => {
  it("multiple enforces max_choices", async () => {
    const created = await createPoll(alice, {
      question: "Pick two toppings",
      type: "multiple",
      max_choices: 2,
      options: [{ text: "A" }, { text: "B" }, { text: "C" }],
    });
    const poll = created.body as unknown as { id: string; options: Array<{ id: string }> };
    const ids = poll.options.map((o) => o.id);
    const ok = await vote(bob, poll.id, { option_ids: [ids[0], ids[1]] });
    expect(ok.status).toBe(200);
    const tooMany = await vote(carol, poll.id, { option_ids: ids });
    expect(tooMany.status).toBe(422);
  });

  it("ranked closes with an IRV tabulation and winner", async () => {
    const created = await createPoll(alice, {
      question: "Best season?",
      type: "ranked",
      options: [{ text: "Spring" }, { text: "Summer" }, { text: "Fall" }],
    });
    const poll = created.body as unknown as { id: string; options: Array<{ id: string; text: string }> };
    const [spring, summer, fall] = poll.options.map((o) => o.id) as [string, string, string];
    // Spring 2 first-prefs, Summer 1, Fall 2 (both ranking Summer second):
    // Summer is eliminated first (1), its ballot exhausts → Spring/Fall tie
    // at 2 → Fall's second prefs don't exist... both Fall ballots rank only
    // Fall. Spring wins via the deterministic tie rules in shared tallyIrv.
    await vote(bob, poll.id, { ranking: [spring] });
    await vote(carol, poll.id, { ranking: [spring] });
    const u1 = await makeUser("rk1");
    const u2 = await makeUser("rk2");
    const u3 = await makeUser("rk3");
    await vote(u1, poll.id, { ranking: [fall, spring] });
    await vote(u2, poll.id, { ranking: [fall, spring] });
    await vote(u3, poll.id, { ranking: [summer] });
    const close = await app.inject({
      method: "POST",
      url: `/api/v1/polls/${poll.id}/close`,
      headers: auth(alice),
      payload: {},
    });
    expect(close.statusCode).toBe(200);
    const results = await app.inject({
      method: "GET",
      url: `/api/v1/polls/${poll.id}/results`,
    });
    const body = results.json() as {
      winner_option_id: string | null;
      irv_rounds: Array<{ round: number; eliminated_option_id: string | null }>;
    };
    // Round 1: spring 2, summer 1, fall 2 → summer eliminated.
    // Round 2: spring 2, fall 2 → fall ballots rank spring second → wait,
    // fall is still active in round 2; spring 2 vs fall 2 tie, no majority
    // of 4 continuing (needs >2). Tie for lowest → earlier rounds equal →
    // id tie-break eliminates one; the survivor wins round 3.
    expect(body.irv_rounds.length).toBeGreaterThanOrEqual(2);
    expect(body.irv_rounds[0]?.eliminated_option_id).toBe(summer);
    expect(body.winner_option_id).not.toBeNull();
    expect([spring, fall]).toContain(body.winner_option_id);
  });

  it("stance_slider records buckets", async () => {
    const created = await createPoll(alice, {
      question: "Remote work is better",
      type: "stance_slider",
    });
    const poll = created.body as unknown as { id: string };
    const res = await vote(bob, poll.id, { slider_value: 2 });
    expect(res.status).toBe(200);
    await vote(carol, poll.id, { slider_value: -2 });
    const results = await app.inject({
      method: "GET",
      url: `/api/v1/polls/${poll.id}/results`,
      headers: auth(alice),
    });
    const dist = (results.json() as { stance_distribution: Record<string, number> }).stance_distribution;
    expect(dist["2"]).toBe(1);
    expect(dist["-2"]).toBe(1);
  });

  it("hot_take gets the fixed 3-way options", async () => {
    const created = await createPoll(alice, {
      question: "Meetings should be emails",
      type: "hot_take",
    });
    const poll = created.body as unknown as { id: string; options: Array<{ id: string; text: string }> };
    expect(poll.options.map((o) => o.text)).toEqual(["Agree", "Nuanced", "Disagree"]);
    const res = await vote(bob, poll.id, { option_id: poll.options[0]!.id });
    expect(res.status).toBe(200);
  });

  it("image poll options carry media", async () => {
    const [mediaRow] = await db
      .insert(media)
      .values({
        id: randomUUID(),
        uploaderId: alice.id,
        kind: "image",
        status: "ready",
        storageKey: "test/poll-image.png",
        mimeType: "image/png",
        sizeBytes: 100,
      })
      .returning();
    const created = await createPoll(alice, {
      question: "Which logo?",
      type: "image",
      options: [
        { media_id: mediaRow!.id, text: "Logo A" },
        { media_id: mediaRow!.id, text: "Logo B" },
      ],
    });
    expect(created.status).toBe(201);
    const poll = created.body as unknown as {
      id: string;
      options: Array<{ id: string; media: { id: string } | null }>;
    };
    expect(poll.options[0]?.media?.id).toBe(mediaRow!.id);
    const res = await vote(bob, poll.id, { option_id: poll.options[1]!.id });
    expect(res.status).toBe(200);
  });
});

describe("polls: result modes + gates", () => {
  it("after_vote hides results until the viewer votes", async () => {
    const created = await createPoll(alice, {
      question: "Hidden until voted?",
      type: "single",
      result_mode: "after_vote",
      options: [{ text: "Yes" }, { text: "No" }],
    });
    const poll = created.body as unknown as { id: string; options: Array<{ id: string }> };
    const hidden = await app.inject({ method: "GET", url: `/api/v1/polls/${poll.id}/results` });
    expect(hidden.statusCode).toBe(403);
    await vote(bob, poll.id, { option_id: poll.options[0]!.id });
    const visible = await app.inject({
      method: "GET",
      url: `/api/v1/polls/${poll.id}/results`,
      headers: auth(bob),
    });
    expect(visible.statusCode).toBe(200);
  });

  it("after_close withholds tallies in the vote response and results", async () => {
    const created = await createPoll(alice, {
      question: "Secret ballot?",
      type: "single",
      result_mode: "after_close",
      options: [{ text: "Yes" }, { text: "No" }],
    });
    const poll = created.body as unknown as { id: string; options: Array<{ id: string }> };
    const cast = await vote(bob, poll.id, { option_id: poll.options[0]!.id });
    expect(cast.status).toBe(200);
    expect((cast.body as unknown as { total_votes: number }).total_votes).toBe(0);
    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/polls/${poll.id}/results`,
      headers: auth(bob),
    });
    expect(hidden.statusCode).toBe(403);
    await app.inject({
      method: "POST",
      url: `/api/v1/polls/${poll.id}/close`,
      headers: auth(alice),
      payload: {},
    });
    const revealed = await app.inject({
      method: "GET",
      url: `/api/v1/polls/${poll.id}/results`,
      headers: auth(bob),
    });
    expect(revealed.statusCode).toBe(200);
    expect((revealed.json() as { total_votes: number }).total_votes).toBe(1);
  });

  it("trust tier gate: T0 cannot vote a default (T1) poll", async () => {
    const created = await createPoll(alice, {
      question: "Gated?",
      type: "single",
      options: [{ text: "Yes" }, { text: "No" }],
    });
    const poll = created.body as unknown as { id: string; options: Array<{ id: string }> };
    const denied = await vote(dave, poll.id, { option_id: poll.options[0]!.id });
    expect(denied.status).toBe(403);
  });

  it("account-age gate rejects young accounts", async () => {
    const created = await createPoll(alice, {
      question: "Old accounts only?",
      type: "single",
      min_account_age_days: 7,
      options: [{ text: "Yes" }, { text: "No" }],
    });
    const poll = created.body as unknown as { id: string; options: Array<{ id: string }> };
    const youngster = await makeUser("young", { tier: "T1" });
    const denied = await vote(youngster, poll.id, { option_id: poll.options[0]!.id });
    expect(denied.status).toBe(403);
    await promote(youngster.id, { ageDays: 30 });
    const allowed = await vote(youngster, poll.id, { option_id: poll.options[0]!.id });
    expect(allowed.status).toBe(200);
  });

  it("breakdowns: opt-in age brackets appear at ≥5, trust tiers always count", async () => {
    const created = await createPoll(alice, {
      question: "Breakdown check",
      type: "single",
      options: [{ text: "Yes" }, { text: "No" }],
    });
    const poll = created.body as unknown as { id: string; options: Array<{ id: string }> };
    const voters: TestUser[] = [];
    for (let i = 0; i < 5; i += 1) {
      const voter = await makeUser(`bk${i}`, { tier: "T1" });
      await db
        .update(users)
        .set({ ageBracket: "25-34" })
        .where(eq(users.id, voter.id));
      await db
        .insert(userSettings)
        .values({ userId: voter.id, demographicBreakdownsOptIn: true })
        .onConflictDoUpdate({
          target: userSettings.userId,
          set: { demographicBreakdownsOptIn: true },
        });
      voters.push(voter);
      await vote(voter, poll.id, { option_id: poll.options[0]!.id });
    }
    // One non-opted-in voter: counts toward tiers, never toward age brackets.
    await vote(bob, poll.id, { option_id: poll.options[0]!.id });
    const results = await app.inject({
      method: "GET",
      url: `/api/v1/polls/${poll.id}/results`,
      headers: auth(alice),
    });
    const breakdowns = (
      results.json() as {
        breakdowns: { by_trust_tier: Record<string, number>; by_age_bracket: Record<string, number> };
      }
    ).breakdowns;
    expect(breakdowns.by_age_bracket["25-34"]).toBe(5);
    expect(breakdowns.by_trust_tier.T1).toBe(6);
  });
});

// ─── Vote integrity: brigading ───────────────────────────────────────────────

describe("vote integrity: burst flag + admin void", () => {
  it("a young-account burst is flagged; voiding restores clean tallies", async () => {
    const created = await createPoll(alice, {
      question: "Brigade target",
      type: "single",
      options: [{ text: "Yes" }, { text: "No" }],
    });
    const poll = created.body as unknown as { id: string; options: Array<{ id: string }> };
    const target = poll.options[0]!.id;
    // Two legitimate ballots from ESTABLISHED accounts (aged 30 days — the
    // detector keys on account age, and fresh test fixtures would all look
    // "young" otherwise).
    await promote(bob.id, { ageDays: 30 });
    await promote(carol.id, { ageDays: 30 });
    await vote(bob, poll.id, { option_id: poll.options[1]!.id });
    await vote(carol, poll.id, { option_id: poll.options[1]!.id });
    // 22 fresh accounts (created today, promoted to T1) burst the target.
    const brigade: TestUser[] = [];
    for (let i = 0; i < 22; i += 1) {
      const user = await makeUser(`bg${i}`, { tier: "T1" });
      brigade.push(user);
      const res = await vote(user, poll.id, { option_id: target });
      expect(res.status).toBe(200);
    }
    const flags = await db.select().from(pollFlags).where(eq(pollFlags.pollId, poll.id));
    expect(flags.length).toBeGreaterThanOrEqual(1);
    const flag = flags.find((f) => f.kind === "young_account_burst") ?? flags[0]!;
    expect(flag.status).toBe("open");

    // Non-admin cannot see flags.
    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/admin/poll-flags",
      headers: auth(bob),
    });
    expect(denied.statusCode).toBe(403);

    // Admin voids via the flag's voter list.
    const voidRes = await app.inject({
      method: "POST",
      url: `/api/v1/admin/polls/${poll.id}/void-ballots`,
      headers: auth(admin),
      payload: { flag_id: flag.id, reason: "brigading simulation" },
    });
    expect(voidRes.statusCode).toBe(200);
    expect((voidRes.json() as { voided: number }).voided).toBe(22);

    const results = await app.inject({
      method: "GET",
      url: `/api/v1/polls/${poll.id}/results`,
      headers: auth(alice),
    });
    const body = results.json() as {
      total_votes: number;
      options: Array<{ id: string; human_votes: number }>;
    };
    expect(body.total_votes).toBe(2);
    expect(body.options.find((o) => o.id === target)?.human_votes).toBe(0);

    // A voided ballot cannot be re-cast.
    const recast = await vote(brigade[0]!, poll.id, { option_id: target });
    expect(recast.status).toBe(409);
  });
});

// ─── Daily Pulse ─────────────────────────────────────────────────────────────

describe("daily pulse", () => {
  it("publishes from the bank exactly once per ET day", async () => {
    const seedRes = await app.inject({
      method: "POST",
      url: "/api/v1/admin/pulse-questions",
      headers: auth(admin),
      payload: {
        question: `Pulse check ${suffix}?`,
        options: ["Yes", "No"],
      },
    });
    expect(seedRes.statusCode).toBe(201);
    const first = await app.inject({ method: "GET", url: "/api/v1/polls/daily-pulse" });
    // A pulse may already exist for today from the seeded bank; either way
    // the endpoint must return a pulse and repeat calls must agree.
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { id: string; is_daily_pulse: boolean };
    expect(firstBody.is_daily_pulse).toBe(true);
    const second = await app.inject({ method: "GET", url: "/api/v1/polls/daily-pulse" });
    expect((second.json() as { id: string }).id).toBe(firstBody.id);
    const todays = await db
      .select()
      .from(polls)
      .where(eq(polls.isDailyPulse, true));
    const byDate = new Map<string, number>();
    for (const row of todays) {
      if (row.pulseDate) byDate.set(row.pulseDate, (byDate.get(row.pulseDate) ?? 0) + 1);
    }
    for (const count of byDate.values()) expect(count).toBe(1);
  });

  it("serves the SVG share card", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/polls/daily-pulse/card.svg" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/svg+xml");
    expect(res.body).toContain("DAILY PULSE");
  });
});

// ─── Inline creation via POST /posts ─────────────────────────────────────────

describe("inline poll/debate posts", () => {
  it("POST /posts type POLL embeds the poll; DEBATE embeds the debate", async () => {
    const pollPost = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: auth(alice),
      payload: {
        type: "POLL",
        body: "",
        poll: { question: "Inline poll?", options: [{ text: "A" }, { text: "B" }] },
      },
    });
    expect(pollPost.statusCode).toBe(201);
    const pollBody = pollPost.json() as { poll: { question: string } | null };
    expect(pollBody.poll?.question).toBe("Inline poll?");

    const debatePost = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: auth(alice),
      payload: {
        type: "DEBATE",
        body: "Opening argument: cities should ban cars downtown.",
        debate: { proposition: "Ban cars downtown", format: "open" },
      },
    });
    expect(debatePost.statusCode).toBe(201);
    const debateBody = debatePost.json() as { debate: { proposition: string } | null };
    expect(debateBody.debate?.proposition).toBe("Ban cars downtown");
  });
});

// ─── Open debates ────────────────────────────────────────────────────────────

describe("open debates: arguments, stance, perspective, close", () => {
  it("runs the full open-debate flow", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/debates",
      headers: auth(alice),
      payload: {
        proposition: "Pineapple belongs on pizza",
        format: "open",
        opening: { side_key: "for", body_md: "Sweet + salty is elite. Fight me." },
      },
    });
    expect(created.statusCode).toBe(201);
    const debate = created.json() as { id: string; status: string; sides: Array<{ key: string }> };
    expect(debate.status).toBe("open");
    expect(debate.sides.map((s) => s.key)).toEqual(["for", "against", "nuanced"]);

    // Bob argues against, with evidence.
    const argument = await app.inject({
      method: "POST",
      url: `/api/v1/debates/${debate.id}/arguments`,
      headers: auth(bob),
      payload: {
        side_key: "against",
        body_md: "Fruit acid curdles the cheese. Chemistry is against you.",
        evidence: [{ url: "https://example.org/study", kind: "study", quote: "pH drops" }],
      },
    });
    expect(argument.statusCode).toBe(201);
    const argumentBody = argument.json() as { id: string; evidence_quality: number };
    expect(argumentBody.evidence_quality).toBeCloseTo(0.5);

    // Three upvotes on Alice's opening argument (found via the list) — the
    // margin keeps the close-out formula clear of the 0.02 draw threshold.
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/debates/${debate.id}/arguments?side_key=for`,
      headers: auth(carol),
    });
    const openingArg = (list.json() as { data: Array<{ id: string }> }).data[0]!;
    const extra = await makeUser("extra");
    for (const voter of [bob, carol, extra]) {
      const v = await app.inject({
        method: "PUT",
        url: `/api/v1/arguments/${openingArg.id}/vote`,
        headers: auth(voter),
        payload: { value: "up" },
      });
      expect(v.statusCode).toBe(200);
    }
    // Bob's own argument gets one upvote from Carol.
    await app.inject({
      method: "PUT",
      url: `/api/v1/arguments/${argumentBody.id}/vote`,
      headers: auth(carol),
      payload: { value: "up" },
    });

    // Stance before: Bob −2 (against), Carol +1 (for).
    const stance = await app.inject({
      method: "POST",
      url: `/api/v1/debates/${debate.id}/stance-votes`,
      headers: auth(bob),
      payload: { phase: "pre", stance_value: -2 },
    });
    expect(stance.statusCode).toBe(200);
    await app.inject({
      method: "POST",
      url: `/api/v1/debates/${debate.id}/stance-votes`,
      headers: auth(carol),
      payload: { phase: "pre", stance_value: 1 },
    });
    // T0 cannot record stance (D-014 gate).
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/debates/${debate.id}/stance-votes`,
      headers: auth(dave),
      payload: { phase: "pre", stance_value: 1 },
    });
    expect(denied.statusCode).toBe(403);

    // Perspective for Bob (against) is the top FOR argument.
    const perspective = await app.inject({
      method: "GET",
      url: `/api/v1/debates/${debate.id}/perspective`,
      headers: auth(bob),
    });
    expect(perspective.statusCode).toBe(200);
    expect((perspective.json() as { side_key: string }).side_key).toBe("for");

    // Close: winner formula — for has more argument votes (2 vs 1).
    const closed = await app.inject({
      method: "POST",
      url: `/api/v1/debates/${debate.id}/close`,
      headers: auth(alice),
      payload: {},
    });
    expect(closed.statusCode).toBe(200);
    const closedBody = closed.json() as { status: string; winner_side_key: string | null };
    expect(closedBody.status).toBe("closed");
    expect(closedBody.winner_side_key).toBe("for");

    // Post stance now opens; Bob softens to −1 (mind changed by ≥1? no:
    // −2 → −1 is a change of 1 toward the middle → counts as changed).
    const post = await app.inject({
      method: "POST",
      url: `/api/v1/debates/${debate.id}/stance-votes`,
      headers: auth(bob),
      payload: { phase: "post", stance_value: -1 },
    });
    expect(post.statusCode).toBe(200);
    const state = post.json() as { mind_changed_count: number; viewer_stance: { pre: number; post: number } };
    expect(state.mind_changed_count).toBe(1);
    expect(state.viewer_stance).toEqual({ pre: -2, post: -1 });
  });

  it("from-article creates a debate with the article card", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/debates/from-article",
      headers: auth(alice),
      payload: {
        article_url: "https://example.com/some-article",
        proposition: "This take holds up",
      },
    });
    expect(res.statusCode).toBe(201);
    const debate = res.json() as { id: string; source_article_url: string; post_id: string };
    expect(debate.source_article_url).toBe("https://example.com/some-article");
    const post = await app.inject({ method: "GET", url: `/api/v1/posts/${debate.post_id}` });
    const card = (post.json() as { link_card: { source_article_url?: string } }).link_card;
    expect(card.source_article_url).toBe("https://example.com/some-article");
  });
});

// ─── Structured 1v1 ──────────────────────────────────────────────────────────

describe("structured 1v1: challenge → rounds → winner + Elo", () => {
  it("runs the full lifecycle", async () => {
    const a = await makeUser("duelA");
    const b = await makeUser("duelB");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/debates",
      headers: auth(a),
      payload: {
        proposition: "School should start later",
        format: "structured_1v1",
        challenged_handle: b.handle,
        rounds: 2,
        per_turn_char_limit: 1500,
      },
    });
    expect(created.statusCode).toBe(201);
    const debate = created.json() as { id: string; status: string };
    expect(debate.status).toBe("draft");

    const [challenge] = await db
      .select()
      .from(debateChallenges)
      .where(eq(debateChallenges.debateId, debate.id));
    expect(challenge?.status).toBe("pending");

    // Only the challenged user can respond.
    const wrongUser = await app.inject({
      method: "POST",
      url: `/api/v1/debates/${debate.id}/challenges/${challenge!.id}/respond`,
      headers: auth(a),
      payload: { decision: "accept" },
    });
    expect(wrongUser.statusCode).toBe(403);

    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/debates/${debate.id}/challenges/${challenge!.id}/respond`,
      headers: auth(b),
      payload: { decision: "accept" },
    });
    expect(accepted.statusCode).toBe(200);
    const live = accepted.json() as {
      status: string;
      rounds: Array<{ round_no: number; status: string; side_key: string | null }>;
      current_round: number | null;
    };
    expect(live.status).toBe("awaiting_turn");
    expect(live.rounds).toHaveLength(4); // 2 rounds × 2 debaters
    expect(live.current_round).toBe(1);

    // Audience stance before the arguments fly.
    await app.inject({
      method: "POST",
      url: `/api/v1/debates/${debate.id}/stance-votes`,
      headers: auth(carol),
      payload: { phase: "pre", stance_value: -1 },
    });

    // Out-of-turn submission is rejected (round 2 belongs to B).
    const outOfTurn = await app.inject({
      method: "POST",
      url: `/api/v1/debates/${debate.id}/rounds/2/submit`,
      headers: auth(a),
      payload: { body_md: "Jumping the queue." },
    });
    expect([403, 409]).toContain(outOfTurn.statusCode);

    // Play all four turns in order: A opens (for), B answers, A rebuts, B closes.
    const turns: Array<[TestUser, number, string]> = [
      [a, 1, "Teen sleep cycles shift late; early starts fight biology."],
      [b, 2, "Later starts just move bedtime later too."],
      [a, 3, "Districts that delayed saw grades and attendance rise."],
      [b, 4, "Busing costs and sports schedules say otherwise."],
    ];
    for (const [user, roundNo, bodyMd] of turns) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/debates/${debate.id}/rounds/${roundNo}/submit`,
        headers: auth(user),
        payload: { body_md: bodyMd },
      });
      expect(res.statusCode).toBe(201);
    }

    // Audience votes A's arguments up; Carol's mind moves to +2 (toward for).
    const argsList = await app.inject({
      method: "GET",
      url: `/api/v1/debates/${debate.id}/arguments`,
      headers: auth(carol),
    });
    const allArgs = (argsList.json() as { data: Array<{ id: string; author: { id: string } }> }).data;
    for (const arg of allArgs.filter((x) => x.author.id === a.id)) {
      await app.inject({
        method: "PUT",
        url: `/api/v1/arguments/${arg.id}/vote`,
        headers: auth(carol),
        payload: { value: "up" },
      });
    }
    const postStance = await app.inject({
      method: "POST",
      url: `/api/v1/debates/${debate.id}/stance-votes`,
      headers: auth(carol),
      payload: { phase: "post", stance_value: 2 },
    });
    expect(postStance.statusCode).toBe(200);

    const closed = await app.inject({
      method: "POST",
      url: `/api/v1/debates/${debate.id}/close`,
      headers: auth(a),
      payload: {},
    });
    expect(closed.statusCode).toBe(200);
    const closedBody = closed.json() as { winner_side_key: string | null; is_draw: boolean };
    expect(closedBody.winner_side_key).toBe("for");
    expect(closedBody.is_draw).toBe(false);

    // Elo: both started at 1200, K=32 → winner 1216, loser 1184.
    const profileA = await app.inject({ method: "GET", url: `/api/v1/users/${a.handle}` });
    const profileB = await app.inject({ method: "GET", url: `/api/v1/users/${b.handle}` });
    const aBody = profileA.json() as { debate_rating: number; debate_record: { wins: number; losses: number } };
    const bBody = profileB.json() as { debate_rating: number; debate_record: { wins: number; losses: number } };
    expect(aBody.debate_rating).toBe(1216);
    expect(aBody.debate_record).toEqual({ wins: 1, losses: 0, draws: 0 });
    expect(bBody.debate_rating).toBe(1184);
    expect(bBody.debate_record).toEqual({ wins: 0, losses: 1, draws: 0 });
  });

  it("per-turn char limit is enforced", async () => {
    const a = await makeUser("limA");
    const b = await makeUser("limB");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/debates",
      headers: auth(a),
      payload: {
        proposition: "Short turns only",
        format: "structured_1v1",
        challenged_handle: b.handle,
        per_turn_char_limit: 280,
      },
    });
    const debate = created.json() as { id: string };
    const [challenge] = await db
      .select()
      .from(debateChallenges)
      .where(eq(debateChallenges.debateId, debate.id));
    await app.inject({
      method: "POST",
      url: `/api/v1/debates/${debate.id}/challenges/${challenge!.id}/respond`,
      headers: auth(b),
      payload: { decision: "accept" },
    });
    const tooLong = await app.inject({
      method: "POST",
      url: `/api/v1/debates/${debate.id}/rounds/1/submit`,
      headers: auth(a),
      payload: { body_md: "x".repeat(281) },
    });
    expect(tooLong.statusCode).toBe(422);
  });

  it("declining the creation challenge cancels the debate", async () => {
    const a = await makeUser("decA");
    const b = await makeUser("decB");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/debates",
      headers: auth(a),
      payload: {
        proposition: "Never happening",
        format: "structured_1v1",
        challenged_handle: b.handle,
      },
    });
    const debate = created.json() as { id: string };
    const [challenge] = await db
      .select()
      .from(debateChallenges)
      .where(eq(debateChallenges.debateId, debate.id));
    const declined = await app.inject({
      method: "POST",
      url: `/api/v1/debates/${debate.id}/challenges/${challenge!.id}/respond`,
      headers: auth(b),
      payload: { decision: "decline" },
    });
    expect((declined.json() as { status: string }).status).toBe("cancelled");
  });
});

// ─── Turn expiry / forfeit ───────────────────────────────────────────────────

describe("turn expiry", () => {
  async function startedDuel(a: TestUser, b: TestUser, extra: Record<string, unknown> = {}) {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/debates",
      headers: auth(a),
      payload: {
        proposition: "Expiry test",
        format: "structured_1v1",
        challenged_handle: b.handle,
        ...extra,
      },
    });
    const debate = created.json() as { id: string };
    const [challenge] = await db
      .select()
      .from(debateChallenges)
      .where(eq(debateChallenges.debateId, debate.id));
    await app.inject({
      method: "POST",
      url: `/api/v1/debates/${debate.id}/challenges/${challenge!.id}/respond`,
      headers: auth(b),
      payload: { decision: "accept" },
    });
    return debate.id;
  }

  it("an overdue first turn is missed and the debate advances", async () => {
    const a = await makeUser("expA");
    const b = await makeUser("expB");
    const debateId = await startedDuel(a, b);
    await db
      .update(debateRounds)
      .set({ deadlineAt: new Date(Date.now() - 60_000) })
      .where(eq(debateRounds.debateId, debateId));
    const handled = await expireOverdueTurns(db, new Date());
    expect(handled).toBeGreaterThanOrEqual(1);
    const rounds = await db
      .select()
      .from(debateRounds)
      .where(eq(debateRounds.debateId, debateId));
    expect(rounds.find((r) => r.roundNo === 1)?.status).toBe("missed");
    expect(rounds.find((r) => r.roundNo === 2)?.status).toBe("active");
    const [debateRow] = await db.select().from(debates).where(eq(debates.id, debateId));
    expect(debateRow?.status).toBe("awaiting_turn");
  });

  it("missing the final turn forfeits to the other side", async () => {
    const a = await makeUser("forA");
    const b = await makeUser("forB");
    const debateId = await startedDuel(a, b, { rounds: 1 });
    // A submits round 1; B's final turn (round 2) lapses.
    const submit = await app.inject({
      method: "POST",
      url: `/api/v1/debates/${debateId}/rounds/1/submit`,
      headers: auth(a),
      payload: { body_md: "My one and only turn." },
    });
    expect(submit.statusCode).toBe(201);
    await db
      .update(debateRounds)
      .set({ deadlineAt: new Date(Date.now() - 60_000) })
      .where(eq(debateRounds.debateId, debateId));
    await expireOverdueTurns(db, new Date());
    const [debateRow] = await db.select().from(debates).where(eq(debates.id, debateId));
    expect(debateRow?.status).toBe("closed");
    expect(debateRow?.winnerSideId).not.toBeNull();
    const details = debateRow?.winnerDetails as { forfeit?: { loserUserId: string } };
    expect(details.forfeit?.loserUserId).toBe(b.id);
  });
});

// ─── Context notes ───────────────────────────────────────────────────────────

describe("context notes: cross-viewpoint bridging (D-033)", () => {
  it("a note surfaces only when both viewpoint clusters rate it helpful", async () => {
    const post = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: auth(alice),
      payload: { type: "TEXT", body: "The moon landing was filmed in a studio, obviously." },
    });
    expect(post.statusCode).toBe(201);
    const postId = (post.json() as { id: string }).id;

    const noteRes = await app.inject({
      method: "POST",
      url: `/api/v1/posts/${postId}/notes`,
      headers: auth(bob),
      payload: {
        body: "Apollo telemetry and retroreflectors are independently verifiable.",
        sources: ["https://example.org/apollo"],
      },
    });
    expect(noteRes.statusCode).toBe(201);
    const note = noteRes.json() as { id: string; status: string };
    expect(note.status).toBe("pending");

    // Public list hides pending notes.
    const before = await app.inject({ method: "GET", url: `/api/v1/posts/${postId}/notes` });
    expect((before.json() as { data: unknown[] }).data).toHaveLength(0);

    // Build two viewpoint clusters via debate stances on a fresh debate.
    const debateRes = await app.inject({
      method: "POST",
      url: "/api/v1/debates",
      headers: auth(alice),
      payload: { proposition: "Cluster seed", format: "open" },
    });
    const debateId = (debateRes.json() as { id: string }).id;
    const posRaters: TestUser[] = [];
    const negRaters: TestUser[] = [];
    for (let i = 0; i < 3; i += 1) {
      const pos = await makeUser(`npos${i}`, { tier: "T1" });
      const neg = await makeUser(`nneg${i}`, { tier: "T1" });
      posRaters.push(pos);
      negRaters.push(neg);
      await app.inject({
        method: "POST",
        url: `/api/v1/debates/${debateId}/stance-votes`,
        headers: auth(pos),
        payload: { phase: "pre", stance_value: 2 },
      });
      await app.inject({
        method: "POST",
        url: `/api/v1/debates/${debateId}/stance-votes`,
        headers: auth(neg),
        payload: { phase: "pre", stance_value: -2 },
      });
    }
    // Only the + cluster rates: still not public (needs BOTH sides).
    for (const rater of posRaters) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/notes/${note.id}/ratings`,
        headers: auth(rater),
        payload: { rating: "helpful" },
      });
      expect(res.statusCode).toBe(204);
    }
    const midway = await app.inject({ method: "GET", url: `/api/v1/posts/${postId}/notes` });
    expect((midway.json() as { data: unknown[] }).data).toHaveLength(0);

    for (const rater of negRaters) {
      await app.inject({
        method: "POST",
        url: `/api/v1/notes/${note.id}/ratings`,
        headers: auth(rater),
        payload: { rating: "helpful" },
      });
    }
    const after = await app.inject({ method: "GET", url: `/api/v1/posts/${postId}/notes` });
    const visible = (after.json() as { data: Array<{ id: string; status: string }> }).data;
    expect(visible).toHaveLength(1);
    expect(visible[0]?.status).toBe("helpful");

    // Authors cannot rate their own note; T0 cannot propose notes.
    const selfRate = await app.inject({
      method: "POST",
      url: `/api/v1/notes/${note.id}/ratings`,
      headers: auth(bob),
      payload: { rating: "helpful" },
    });
    expect(selfRate.statusCode).toBe(403);
    const t0Note = await app.inject({
      method: "POST",
      url: `/api/v1/posts/${postId}/notes`,
      headers: auth(dave),
      payload: { body: "drive-by note", sources: [] },
    });
    expect(t0Note.statusCode).toBe(403);
  });
});
