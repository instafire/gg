import { describe, expect, it, vi } from "vitest";
import { GGClient } from "../src/index";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GGClient", () => {
  it("health() calls /api/v1/health and trims the trailing slash", async () => {
    const fetchImpl = vi.fn<FetchFn>(async () =>
      jsonResponse({ status: "ok", service: "gg-api" }),
    );
    const client = new GGClient({
      baseUrl: "http://localhost:4000/",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.health()).resolves.toEqual({ status: "ok", service: "gg-api" });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://localhost:4000/api/v1/health");
  });

  it("listPosts() passes pagination params and the api key header", async () => {
    const fetchImpl = vi.fn<FetchFn>(async () =>
      jsonResponse({ items: [], nextCursor: null }),
    );
    const client = new GGClient({
      baseUrl: "http://localhost:4000",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.listPosts({ limit: 5 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:4000/api/v1/posts?limit=5");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("test-key");
  });

  it("throws with the problem+json detail on error responses", async () => {
    const fetchImpl = vi.fn<FetchFn>(async () =>
      jsonResponse({ title: "Not Found", detail: "no such post" }, 404),
    );
    const client = new GGClient({
      baseUrl: "http://localhost:4000",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.health()).rejects.toThrow("GG API 404: no such post");
  });
});
