/**
 * Phase 1 exit round client surface: reports + community mod queue.
 * Same stub-fetch harness as client-extended.test.ts.
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

const postId = "01921f2e-7b6d-7c8f-9a0b-1c2d3e4f5a6b";
const reportId = "01921f2e-7b6d-7c8f-9a0b-0000000000aa";

const reportWire = {
  id: reportId,
  target_type: "post",
  target_id: postId,
  reason: "hate",
  status: "open",
  resolution: null,
  created_at: "2026-10-10T12:00:00.000Z",
};

const authorWire = {
  id: "01921f2e-7b6d-7c8f-9a0b-1c2d3e4f5a6c",
  handle: "aman",
  display_name: "Aman",
  avatar_url: null,
  author_type: "human",
  trust_tier: "T1",
  is_verified_agent: false,
};

const postWire = {
  id: postId,
  short_code: "abc123",
  type: "TEXT",
  author: authorWire,
  author_type: "human",
  parent_id: null,
  root_id: postId,
  depth: 0,
  community: null,
  title: null,
  body_md: "a very hateful post",
  body_html: "<p>a very hateful post</p>",
  is_long_form: false,
  link_card: null,
  media: [],
  flair: null,
  visibility: "community",
  reply_policy: "everyone",
  is_nsfw: false,
  is_spoiler: false,
  contains_ai_media: false,
  is_pinned: false,
  is_locked: false,
  up_count: 0,
  down_count: 0,
  score: 0,
  reply_count: 0,
  repost_count: 0,
  quote_count: 0,
  view_count: 1,
  save_count: 0,
  reaction_counts: {},
  vote_breakdown: null,
  edited_at: null,
  deleted_at: null,
  removed: false,
  created_at: "2026-10-10T11:00:00.000Z",
  viewer_state: null,
};

describe("reports", () => {
  it("createReport POSTs the spec wire body with an idempotency key and normalizes", async () => {
    const { client, calls } = makeClient({
      "POST /api/v1/reports": () => jsonResponse(reportWire, 201),
    });
    const view = await client.createReport({
      targetType: "post",
      targetId: postId,
      reason: "hate",
      details: "slurs in the thread",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.get("idempotency-key")).toBeTruthy();
    expect(calls[0]!.body).toEqual({
      target_type: "post",
      target_id: postId,
      reason: "hate",
      details: "slurs in the thread",
    });
    expect(view).toEqual({
      id: reportId,
      targetType: "post",
      targetId: postId,
      reason: "hate",
      status: "open",
      resolution: null,
      createdAt: "2026-10-10T12:00:00.000Z",
    });
  });

  it("getReport + resolveReport hit the report routes", async () => {
    const resolvedWire = {
      ...reportWire,
      status: "actioned",
      resolution: "Post removed",
    };
    const { client, calls } = makeClient({
      [`GET /api/v1/reports/${reportId}`]: () => jsonResponse(reportWire),
      [`PATCH /api/v1/reports/${reportId}`]: () => jsonResponse(resolvedWire),
    });
    const fetched = await client.getReport(reportId);
    expect(fetched.status).toBe("open");
    const resolved = await client.resolveReport(reportId, {
      status: "actioned",
      resolution: "Post removed",
    });
    expect(resolved.status).toBe("actioned");
    expect(resolved.resolution).toBe("Post removed");
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch!.body).toEqual({ status: "actioned", resolution: "Post removed" });
  });

  it("listModQueue normalizes items with nested posts and page envelope", async () => {
    const queueWire = {
      data: [
        {
          id: reportId,
          kind: "report",
          severity: 3,
          report: reportWire,
          post: postWire,
          created_at: "2026-10-10T12:00:00.000Z",
        },
      ],
      page: { next_cursor: null, has_more: false },
    };
    const { client, calls } = makeClient({
      "GET /api/v1/communities/meta/mod/queue?kind=reports": () =>
        jsonResponse(queueWire),
    });
    const page = await client.listModQueue("meta", { kind: "reports" });
    expect(calls[0]!.url).toContain("kind=reports");
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
    const item = page.items[0]!;
    expect(item.kind).toBe("report");
    expect(item.severity).toBe(3);
    expect(item.report.reason).toBe("hate");
    expect(item.post?.id).toBe(postId);
    expect(item.post?.body).toBe("a very hateful post");
  });
});
