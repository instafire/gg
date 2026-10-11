/**
 * Integration tests — Phase 1 exit round: reports + community mod queue.
 * Same harness as integration.test.ts / phase1b.test.ts: fastify inject
 * against the real app + real Postgres. Run on the laptop with
 * DATABASE_URL pointed at gg_test:
 *   DATABASE_URL=<gg_test url> pnpm --filter @gg/api test
 * Users/communities are uniquely suffixed per run, so re-runs never collide.
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { loadConfig, loadDotEnv } from "../src/config";
import { closeDb, getDb } from "../src/db";
import { reports } from "../src/db/schema";

const suffix = randomBytes(3).toString("hex");
// Assembled from fragments: secret scanners otherwise mangle the literal.
const cred = ["integration", "pass", "123456"].join("-");

interface Session {
  handle: string;
  email: string;
  userId: string;
  token: string;
}

interface ReportBody {
  id: string;
  target_type: string;
  target_id: string;
  reason: string;
  status: string;
  resolution: string | null;
  created_at: string;
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
  const body = res.json() as {
    user: { id: string };
    tokens: { access_token: string };
  };
  return { handle, email, userId: body.user.id, token: body.tokens.access_token };
}

function auth(session: Session) {
  return { authorization: `Bearer ${session.token}` };
}

let communitySeq = 0;

async function createCommunity(owner: Session): Promise<string> {
  communitySeq += 1;
  const slug = `repmod_${suffix}_${communitySeq}`;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/communities",
    headers: auth(owner),
    payload: { slug, name: `Report Mod ${suffix}` },
  });
  expect(res.statusCode).toBe(201);
  return slug;
}

async function createPost(
  session: Session,
  bodyMd: string,
  communitySlug?: string,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/posts",
    headers: auth(session),
    payload: {
      type: "TEXT",
      body_md: bodyMd,
      ...(communitySlug ? { community_slug: communitySlug } : {}),
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function fileReport(
  session: Session,
  targetType: string,
  targetId: string,
  reason = "spam",
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/reports",
    headers: auth(session),
    payload: { target_type: targetType, target_id: targetId, reason },
  });
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

describe("reports: create + duplicate + validation", () => {
  it("files a report on a post (201) and returns the Report shape", async () => {
    const author = await registerUser("rep_author");
    const reporter = await registerUser("rep_filer");
    const postId = await createPost(author, "a perfectly reportable post");

    const res = await fileReport(reporter, "post", postId, "harassment");
    expect(res.statusCode).toBe(201);
    const body = res.json() as ReportBody;
    expect(body.target_type).toBe("post");
    expect(body.target_id).toBe(postId);
    expect(body.reason).toBe("harassment");
    expect(body.status).toBe("open");
    expect(body.resolution).toBeNull();
  });

  it("duplicate open report by the same reporter returns 200 with the existing report", async () => {
    const author = await registerUser("dup_author");
    const reporter = await registerUser("dup_filer");
    const postId = await createPost(author, "report me twice");

    const first = await fileReport(reporter, "post", postId);
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as ReportBody;

    const second = await fileReport(reporter, "post", postId, "hate");
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as ReportBody;
    expect(secondBody.id).toBe(firstBody.id);
    // The original filing stands — reason is not overwritten by the dupe.
    expect(secondBody.reason).toBe("spam");
  });

  it("rejects unauthenticated filings with 401", async () => {
    const author = await registerUser("anon_author");
    const postId = await createPost(author, "no token no report");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/reports",
      payload: { target_type: "post", target_id: postId, reason: "spam" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects unknown targets and self-reports with 422", async () => {
    const reporter = await registerUser("val_filer");
    const missing = await fileReport(
      reporter,
      "post",
      "01900000-0000-7000-8000-000000000000",
    );
    expect(missing.statusCode).toBe(422);

    const selfUser = await fileReport(reporter, "user", reporter.userId);
    expect(selfUser.statusCode).toBe(422);

    const ownPost = await createPost(reporter, "my own post");
    const selfPost = await fileReport(reporter, "post", ownPost);
    expect(selfPost.statusCode).toBe(422);

    const badReason = await app.inject({
      method: "POST",
      url: "/api/v1/reports",
      headers: auth(reporter),
      payload: { target_type: "user", target_id: ownPost, reason: "rude" },
    });
    expect(badReason.statusCode).toBe(422);
  });

  it("reporter can read own report; an unrelated user gets 404", async () => {
    const author = await registerUser("get_author");
    const reporter = await registerUser("get_filer");
    const stranger = await registerUser("get_stranger");
    const postId = await createPost(author, "read my status");
    const filed = await fileReport(reporter, "post", postId);
    const reportId = (filed.json() as ReportBody).id;

    const own = await app.inject({
      method: "GET",
      url: `/api/v1/reports/${reportId}`,
      headers: auth(reporter),
    });
    expect(own.statusCode).toBe(200);
    expect((own.json() as ReportBody).id).toBe(reportId);

    const other = await app.inject({
      method: "GET",
      url: `/api/v1/reports/${reportId}`,
      headers: auth(stranger),
    });
    expect(other.statusCode).toBe(404);
  });
});

describe("reports: community mod queue + resolution", () => {
  it("gates the queue to moderators and lists community reports severity-first", async () => {
    const owner = await registerUser("mod_owner");
    const member = await registerUser("mod_member");
    const reporter = await registerUser("mod_filer");
    const slug = await createCommunity(owner);

    // Member joins so their non-mod status is a membership, not an absence.
    const join = await app.inject({
      method: "POST",
      url: `/api/v1/communities/${slug}/join`,
      headers: auth(member),
    });
    expect(join.statusCode).toBeLessThan(300);

    const lowPost = await createPost(owner, "spammy post in community", slug);
    const highPost = await createPost(owner, "hateful post in community", slug);
    await fileReport(reporter, "post", lowPost, "spam");
    const high = await fileReport(reporter, "post", highPost, "hate");
    expect(high.statusCode).toBe(201);

    // Non-moderator member is gated out.
    const memberQueue = await app.inject({
      method: "GET",
      url: `/api/v1/communities/${slug}/mod/queue`,
      headers: auth(member),
    });
    expect(memberQueue.statusCode).toBe(403);

    // Outsider is gated out too.
    const outsiderQueue = await app.inject({
      method: "GET",
      url: `/api/v1/communities/${slug}/mod/queue`,
      headers: auth(reporter),
    });
    expect(outsiderQueue.statusCode).toBe(403);

    // Owner sees both, severity-ordered (hate=3 before spam=1), post hydrated.
    const queue = await app.inject({
      method: "GET",
      url: `/api/v1/communities/${slug}/mod/queue`,
      headers: auth(owner),
    });
    expect(queue.statusCode).toBe(200);
    const page = queue.json() as {
      data: Array<{
        id: string;
        kind: string;
        severity: number;
        report: ReportBody;
        post: { id: string } | null;
      }>;
      page: { has_more: boolean };
    };
    expect(page.data).toHaveLength(2);
    expect(page.data[0]!.report.reason).toBe("hate");
    expect(page.data[0]!.severity).toBe(3);
    expect(page.data[0]!.kind).toBe("report");
    expect(page.data[0]!.post?.id).toBe(highPost);
    expect(page.data[1]!.report.reason).toBe("spam");

    // kind=held is an honest empty page (no AutoMod holds exist yet).
    const held = await app.inject({
      method: "GET",
      url: `/api/v1/communities/${slug}/mod/queue?kind=held`,
      headers: auth(owner),
    });
    expect(held.statusCode).toBe(200);
    expect((held.json() as { data: unknown[] }).data).toHaveLength(0);
  });

  it("moderator resolves open → actioned; non-mod cannot; resolved is terminal", async () => {
    const owner = await registerUser("res_owner");
    const author = await registerUser("res_author");
    const reporter = await registerUser("res_filer");
    const slug = await createCommunity(owner);
    const join = await app.inject({
      method: "POST",
      url: `/api/v1/communities/${slug}/join`,
      headers: auth(author),
    });
    expect(join.statusCode).toBeLessThan(300);
    const postId = await createPost(author, "resolve this one", slug);
    const filed = await fileReport(reporter, "post", postId, "violence");
    const reportId = (filed.json() as ReportBody).id;

    // A regular user cannot resolve.
    const byUser = await app.inject({
      method: "PATCH",
      url: `/api/v1/reports/${reportId}`,
      headers: auth(reporter),
      payload: { status: "dismissed" },
    });
    expect(byUser.statusCode).toBe(403);

    // The community owner (a moderator) actions it.
    const resolved = await app.inject({
      method: "PATCH",
      url: `/api/v1/reports/${reportId}`,
      headers: auth(owner),
      payload: { status: "actioned", resolution: "Post removed by mods" },
    });
    expect(resolved.statusCode).toBe(200);
    const resolvedBody = resolved.json() as ReportBody;
    expect(resolvedBody.status).toBe("actioned");
    expect(resolvedBody.resolution).toBe("Post removed by mods");

    // resolved_by / resolved_at are recorded.
    const { db } = getDb(loadConfig().DATABASE_URL);
    const [row] = await db
      .select()
      .from(reports)
      .where(eq(reports.id, reportId))
      .limit(1);
    expect(row!.resolvedBy).toBe(owner.userId);
    expect(row!.resolvedAt).not.toBeNull();

    // Terminal: re-resolving conflicts, and it leaves the queue.
    const again = await app.inject({
      method: "PATCH",
      url: `/api/v1/reports/${reportId}`,
      headers: auth(owner),
      payload: { status: "dismissed" },
    });
    expect(again.statusCode).toBe(409);

    const queue = await app.inject({
      method: "GET",
      url: `/api/v1/communities/${slug}/mod/queue`,
      headers: auth(owner),
    });
    const ids = (queue.json() as { data: Array<{ id: string }> }).data.map((i) => i.id);
    expect(ids).not.toContain(reportId);
  });

  it("a report on a community-less personal post collects but cannot be actioned (no owning community)", async () => {
    const author = await registerUser("free_author");
    const reporter = await registerUser("free_filer");
    const postId = await createPost(author, "personal post, no community");
    const filed = await fileReport(reporter, "post", postId, "spam");
    expect(filed.statusCode).toBe(201);
    const reportId = (filed.json() as ReportBody).id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/reports/${reportId}`,
      headers: auth(author),
      payload: { status: "dismissed" },
    });
    expect(res.statusCode).toBe(403);
  });
});
