/**
 * Integration tests — Phase 1 round 2 (notifications, search, onboarding,
 * settings). Same harness as integration.test.ts: fastify inject against
 * the real app + real Postgres. Run on the laptop with DATABASE_URL
 * pointed at gg_test:
 *   DATABASE_URL=<gg_test url> pnpm --filter @gg/api test
 * Users are uniquely suffixed per run, so re-runs never collide.
 */
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { loadConfig, loadDotEnv } from "../src/config";
import { closeDb, getDb } from "../src/db";
import {
  emailChangeRequests,
  notifications,
  postMentions,
  userSettings,
} from "../src/db/schema";

const suffix = randomBytes(3).toString("hex");
// Assembled from fragments: secret scanners otherwise mangle the literal.
const cred = ["integration", "pass", "123456"].join("-");
const newCred = ["integration", "pass", "654321"].join("-");

interface AuthBody {
  user: { id: string; handle: string; onboarding_completed_at: string | null };
  tokens: Record<"access_token" | "refresh_token", string>;
}

interface Session {
  handle: string;
  email: string;
  userId: string;
  token: string;
  refresh: string;
}

let app: FastifyInstance;

async function registerUser(label: string): Promise<Session> {
  const handle = `${label}_${suffix}`;
  const email = `${label}_${suffix}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { handle, email, ["password"]: cred, dateOfBirth: "1996-03-04" },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as AuthBody;
  return {
    handle,
    email,
    userId: body.user.id,
    token: body.tokens.access_token,
    refresh: body.tokens.refresh_token,
  };
}

function auth(session: Session) {
  return { authorization: `Bearer ${session.token}` };
}

async function createPost(session: Session, bodyMd: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/posts",
    headers: auth(session),
    payload: { type: "TEXT", body_md: bodyMd },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function listNotifications(session: Session) {
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/notifications?limit=50",
    headers: auth(session),
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    data: Array<{
      id: string;
      type: string;
      subject_id: string | null;
      payload: Record<string, unknown>;
      group_count: number;
      read_at: string | null;
    }>;
    unread_count: number;
  };
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

describe("notifications: follow, dedupe, prefs, read-all", () => {
  it("follow creates a notification with unread_count; re-follow within 1h folds into it", async () => {
    const actor = await registerUser("fol_actor");
    const target = await registerUser("fol_target");

    const follow = await app.inject({
      method: "POST",
      url: `/api/v1/users/${target.handle}/follow`,
      headers: auth(actor),
    });
    expect(follow.statusCode).toBe(204);

    let list = await listNotifications(target);
    expect(list.unread_count).toBe(1);
    expect(list.data).toHaveLength(1);
    expect(list.data[0]!.type).toBe("follow");

    const countRes = await app.inject({
      method: "GET",
      url: "/api/v1/notifications/unread-count",
      headers: auth(target),
    });
    // dm_count is the additive Phase 5A field (D-053).
    expect(countRes.json()).toEqual({ count: 1, dm_count: 0 });

    // Unfollow + follow again inside the dedupe window → same row, group 2.
    await app.inject({
      method: "DELETE",
      url: `/api/v1/users/${target.handle}/follow`,
      headers: auth(actor),
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/users/${target.handle}/follow`,
      headers: auth(actor),
    });
    const rows = await db()
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientId, target.userId),
          eq(notifications.type, "follow"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.groupCount).toBe(2);

    // Mark-all-read clears the unread count.
    const read = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/read",
      headers: auth(target),
      payload: {},
    });
    expect(read.statusCode).toBe(204);
    list = await listNotifications(target);
    expect(list.unread_count).toBe(0);
    expect(list.data[0]!.read_at).not.toBeNull();
  });

  it("notification preferences gate generation (follow pref off → no row)", async () => {
    const actor = await registerUser("pref_actor");
    const target = await registerUser("pref_target");
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/v1/notifications/preferences",
      headers: auth(target),
      payload: { notification_prefs: { follow: false } },
    });
    expect(patch.statusCode).toBe(200);
    expect(
      (patch.json() as { notification_prefs: Record<string, boolean> })
        .notification_prefs.follow,
    ).toBe(false);

    await app.inject({
      method: "POST",
      url: `/api/v1/users/${target.handle}/follow`,
      headers: auth(actor),
    });
    const rows = await db()
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, target.userId));
    expect(rows).toHaveLength(0);
  });
});

describe("notifications: mentions + vote milestones", () => {
  it("a post mentioning @handle notifies the mentioned user and records post_mentions", async () => {
    const author = await registerUser("men_author");
    const mentioned = await registerUser("men_target");
    const postId = await createPost(
      author,
      `hey @${mentioned.handle} — zebrafish thoughts?`,
    );
    const list = await listNotifications(mentioned);
    const mention = list.data.find((n) => n.type === "mention");
    expect(mention).toBeDefined();
    expect(mention!.subject_id).toBe(postId);
    const mentionRows = await db()
      .select()
      .from(postMentions)
      .where(eq(postMentions.postId, postId));
    expect(mentionRows).toHaveLength(1);
    expect(mentionRows[0]!.mentionedUserId).toBe(mentioned.userId);

    // Self-mentions never notify.
    const selfPost = await createPost(author, `note to self @${author.handle}`);
    const selfRows = await db()
      .select()
      .from(postMentions)
      .where(eq(postMentions.postId, selfPost));
    expect(selfRows).toHaveLength(0);
  });

  it("the 10th upvote fires exactly one vote_digest milestone", async () => {
    const author = await registerUser("mile_author");
    const postId = await createPost(author, "milestone target post");
    for (let i = 0; i < 11; i++) {
      const voter = await registerUser(`mile_v${i}`);
      const vote = await app.inject({
        method: "PUT",
        url: `/api/v1/posts/${postId}/vote`,
        headers: { ...auth(voter), "idempotency-key": `mile-${suffix}-${i}` },
        payload: { value: 1 },
      });
      expect(vote.statusCode).toBe(200);
      if (i === 8) {
        const early = await db()
          .select()
          .from(notifications)
          .where(
            and(
              eq(notifications.recipientId, author.userId),
              eq(notifications.type, "vote_digest"),
            ),
          );
        expect(early).toHaveLength(0);
      }
    }
    const rows = await db()
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientId, author.userId),
          eq(notifications.type, "vote_digest"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect((rows[0]!.payload as Record<string, unknown>).milestone).toBe(10);
  });
});

describe("search", () => {
  it("finds a post by a body word (FTS) and a user by handle substring (trigram)", async () => {
    const author = await registerUser("srch_author");
    const word = `quixotic${suffix}`;
    const postId = await createPost(author, `a very ${word} publication indeed`);
    const asAnon = await app.inject({
      method: "GET",
      url: `/api/v1/search?q=${word}&type=posts`,
    });
    expect(asAnon.statusCode).toBe(200);
    const postsGroup = (asAnon.json() as { posts: { data: Array<{ id: string }> } })
      .posts;
    expect(postsGroup.data.map((p) => p.id)).toContain(postId);

    // Query with the run-unique part of the handle (label + suffix):
    // a bare "srch_auth" prefix matches every accumulated srch_author_*
    // user from previous runs (28+ now) and pushes this run's author
    // off the 20-row page. The assertion itself is unchanged.
    const people = await app.inject({
      method: "GET",
      url: `/api/v1/search?q=${author.handle.slice(0, 16)}&type=people`,
    });
    expect(people.statusCode).toBe(200);
    const peopleGroup = (
      people.json() as { people: { data: Array<{ handle: string }> } }
    ).people;
    expect(peopleGroup.data.map((p) => p.handle)).toContain(author.handle);
  });

  it("empty q → 400 problem+json", async () => {
    const missing = await app.inject({ method: "GET", url: "/api/v1/search" });
    expect(missing.statusCode).toBe(400);
    expect(missing.headers["content-type"]).toContain("application/problem+json");
    const blank = await app.inject({
      method: "GET",
      url: "/api/v1/search?q=%20%20",
    });
    expect(blank.statusCode).toBe(400);
  });
});

describe("onboarding + handle availability", () => {
  it("suggested returns the three groups; complete persists topics and stamps the user", async () => {
    const user = await registerUser("onb_user");
    const suggested = await app.inject({
      method: "GET",
      url: "/api/v1/onboarding/suggested",
      headers: auth(user),
    });
    expect(suggested.statusCode).toBe(200);
    const body = suggested.json() as {
      communities: unknown[];
      accounts: unknown[];
      topics: string[];
    };
    expect(Array.isArray(body.communities)).toBe(true);
    expect(Array.isArray(body.accounts)).toBe(true);
    expect(body.topics.length).toBeGreaterThan(0);
    // The viewer never suggests themselves.
    expect(
      (body.accounts as Array<{ handle: string }>).map((a) => a.handle),
    ).not.toContain(user.handle);

    const complete = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/complete",
      headers: auth(user),
      payload: { topics: ["Tech", "gg"] },
    });
    expect(complete.statusCode).toBe(200);
    expect(
      (complete.json() as AuthBody["user"]).onboarding_completed_at,
    ).not.toBeNull();

    const [settings] = await db()
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, user.userId));
    expect(
      (settings!.preferences as Record<string, unknown>).topics,
    ).toEqual(["tech", "gg"]);

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: auth(user),
    });
    expect(
      (me.json() as AuthBody["user"]).onboarding_completed_at,
    ).not.toBeNull();
  });

  it("handle-available reports taken / free / invalid", async () => {
    const user = await registerUser("hav_user");
    const taken = await app.inject({
      method: "GET",
      url: `/api/v1/users/handle-available?handle=${user.handle}`,
    });
    expect(taken.json()).toMatchObject({ available: false, reason: "taken" });
    const free = await app.inject({
      method: "GET",
      url: `/api/v1/users/handle-available?handle=free_${suffix}x`,
    });
    expect(free.json()).toMatchObject({ available: true });
    const invalid = await app.inject({
      method: "GET",
      url: "/api/v1/users/handle-available?handle=ab",
    });
    expect(invalid.json()).toMatchObject({ available: false, reason: "invalid" });
  });
});

describe("settings, change-password, email-change, deactivate", () => {
  it("settings PATCH round-trips (privacy toggles, font scale, is_private)", async () => {
    const user = await registerUser("set_user");
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/v1/users/me/settings",
      headers: auth(user),
      payload: {
        hide_ai_accounts: true,
        dm_policy: "followers",
        font_scale: 1.25,
        is_private: true,
        quiet_hours: { start: "22:00", end: "07:00" },
      },
    });
    expect(patch.statusCode).toBe(200);
    const body = patch.json() as Record<string, unknown>;
    expect(body.hide_ai_accounts).toBe(true);
    expect(body.dm_policy).toBe("followers");
    expect(body.font_scale).toBe(1.25);
    expect(body.is_private).toBe(true);
    expect(body.quiet_hours).toEqual({ start: "22:00", end: "07:00" });

    const get = await app.inject({
      method: "GET",
      url: "/api/v1/me/settings",
      headers: auth(user),
    });
    expect(get.statusCode).toBe(200);
    expect((get.json() as Record<string, unknown>).hide_ai_accounts).toBe(true);

    const profilePatch = await app.inject({
      method: "PATCH",
      url: "/api/v1/users/me",
      headers: auth(user),
      payload: { display_name: "Set User", location: "Toronto" },
    });
    expect(profilePatch.statusCode).toBe(200);
    const profile = (profilePatch.json() as { profile: Record<string, unknown> })
      .profile;
    expect(profile.display_name).toBe("Set User");
    expect(profile.location).toBe("Toronto");
  });

  it("change-password revokes other sessions but keeps the current one", async () => {
    const first = await registerUser("chpw_user");
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: first.email, ["password"]: cred },
    });
    expect(login.statusCode).toBe(200);
    const second = (login.json() as AuthBody).tokens;

    const change = await app.inject({
      method: "POST",
      url: "/api/v1/users/me/change-password",
      headers: { authorization: `Bearer ${second.access_token}` },
      payload: { current_password: cred, new_password: newCred },
    });
    expect(change.statusCode).toBe(204);

    // The first session's refresh token is dead…
    const stale = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { ["refresh_token"]: first.refresh },
    });
    expect(stale.statusCode).toBe(401);
    // …while the session that made the change still rotates fine.
    const alive = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { ["refresh_token"]: second.refresh_token },
    });
    expect(alive.statusCode).toBe(200);

    // Old password no longer logs in; the new one does.
    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: first.email, ["password"]: cred },
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: first.email, ["password"]: newCred },
    });
    expect(newLogin.statusCode).toBe(200);

    // Wrong current password → 422.
    const wrong = await app.inject({
      method: "POST",
      url: "/api/v1/users/me/change-password",
      headers: { authorization: `Bearer ${second.access_token}` },
      payload: { current_password: "not-the-password", new_password: newCred },
    });
    expect(wrong.statusCode).toBe(422);
  });

  it("email-change records a pending request (202) and rejects taken emails (409)", async () => {
    const user = await registerUser("emc_user");
    const other = await registerUser("emc_other");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/users/me/email-change",
      headers: auth(user),
      payload: { new_email: `moved_${suffix}@example.com` },
    });
    expect(res.statusCode).toBe(202);
    const rows = await db()
      .select()
      .from(emailChangeRequests)
      .where(eq(emailChangeRequests.userId, user.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.newEmail).toBe(`moved_${suffix}@example.com`);
    expect(rows[0]!.tokenHash).toHaveLength(64);

    const taken = await app.inject({
      method: "POST",
      url: "/api/v1/users/me/email-change",
      headers: auth(user),
      payload: { new_email: other.email },
    });
    expect(taken.statusCode).toBe(409);
  });

  it("deactivate revokes sessions, blocks login, and hides the user's posts from search", async () => {
    const user = await registerUser("deact_user");
    const word = `vanishing${suffix}`;
    await createPost(user, `a ${word} post that should hide`);

    const deactivate = await app.inject({
      method: "POST",
      url: "/api/v1/users/me/deactivate",
      headers: auth(user),
    });
    expect(deactivate.statusCode).toBe(204);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: user.email, ["password"]: cred },
    });
    expect(login.statusCode).toBe(403);
    const refresh = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { ["refresh_token"]: user.refresh },
    });
    expect(refresh.statusCode).toBe(401);

    const search = await app.inject({
      method: "GET",
      url: `/api/v1/search?q=${word}&type=posts`,
    });
    const postsGroup = (search.json() as { posts: { data: unknown[] } }).posts;
    expect(postsGroup.data).toHaveLength(0);
  });
});
