import { describe, expect, it, vi } from "vitest";
import { GGClient } from "../src/index";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(fetchImpl: FetchFn): GGClient {
  return new GGClient({
    baseUrl: "http://localhost:4000",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

const mediaWire = {
  id: "m-1",
  uploader_id: "u-1",
  kind: "image",
  status: "processing",
  url: null,
  mime_type: "image/png",
  size_bytes: 1234,
  width: 96,
  height: 64,
  duration_ms: null,
  blurhash: null,
  alt_text: null,
  alt_text_source: null,
  variants: null,
  hls_url: null,
  thumbnail_url: null,
  captions: [],
  created_at: "2026-10-11T00:00:00.000Z",
};

describe("GGClient media (Phase 2)", () => {
  it("uploadMedia runs create-session → PUT → complete and normalizes", async () => {
    const calls: { url: string; method: string }[] = [];
    const fetchImpl = vi.fn<FetchFn>(async (url, init) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.endsWith("/api/v1/media/uploads") && method === "POST") {
        return jsonResponse(
          {
            media_id: "m-1",
            status: "uploading",
            tus_url: "/api/v1/media/uploads/m-1",
            signed_put_url: "/api/v1/media/uploads/m-1/content",
            offset: 0,
            length: 4,
            expires_at: "2026-10-12T00:00:00.000Z",
          },
          201,
        );
      }
      if (url.endsWith("/content") && method === "PUT") {
        return jsonResponse({
          media_id: "m-1",
          status: "uploading",
          tus_url: "/api/v1/media/uploads/m-1",
          signed_put_url: "/api/v1/media/uploads/m-1/content",
          offset: 4,
          length: 4,
          expires_at: null,
        });
      }
      if (url.endsWith("/complete")) {
        return jsonResponse(mediaWire, 202);
      }
      throw new Error(`unexpected call ${method} ${url}`);
    });
    const client = makeClient(fetchImpl);
    const progress: number[] = [];
    const file = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
    const media = await client.uploadMedia(file, {
      onProgress: (f) => progress.push(f),
    });
    expect(media.id).toBe("m-1");
    expect(media.status).toBe("processing");
    expect(media.width).toBe(96);
    expect(progress).toEqual([1]);
    expect(calls.map((c) => c.method)).toEqual(["POST", "PUT", "POST"]);
  });

  it("uploadToSession chunks large payloads with tus PATCH offsets", async () => {
    const offsets: string[] = [];
    const fetchImpl = vi.fn<FetchFn>(async (_url, init) => {
      const headers = new Headers(init?.headers);
      const offset = Number.parseInt(headers.get("upload-offset") ?? "0", 10);
      offsets.push(String(offset));
      const body = init?.body as Blob;
      return new Response(null, {
        status: 204,
        headers: { "upload-offset": String(offset + body.size) },
      });
    });
    const client = makeClient(fetchImpl);
    const size = 9 * 1024 * 1024; // over the 8 MB one-shot limit
    const data = new Blob([new Uint8Array(size)], { type: "video/mp4" });
    const progress: number[] = [];
    await client.uploadToSession(
      {
        mediaId: "m-2",
        status: "uploading",
        tusUrl: "/api/v1/media/uploads/m-2",
        signedPutUrl: "/api/v1/media/uploads/m-2/content",
        offset: 0,
        length: size,
        expiresAt: null,
      },
      data,
      (f) => progress.push(f),
    );
    expect(offsets).toEqual(["0", String(4 * 1024 * 1024), String(8 * 1024 * 1024)]);
    expect(progress[progress.length - 1]).toBe(1);
  });

  it("getMedia normalizes variants, hls and captions", async () => {
    const fetchImpl = vi.fn<FetchFn>(async () =>
      jsonResponse({
        ...mediaWire,
        kind: "video",
        status: "ready",
        duration_ms: 12000,
        // The API nests these inside `variants` for video media.
        variants: {
          poster: { url: "/media/m-1/poster", width: 720, height: 1280, format: "webp" },
          hls_url: "/media/m-1/hls/master.m3u8",
          thumbnail_url: "/media/m-1/thumb",
        },
        captions: [{ lang: "en", label: "English", url: "/media/m-1/captions/en" }],
      }),
    );
    const client = makeClient(fetchImpl);
    const media = await client.getMedia("m-1");
    expect(media.hlsUrl).toBe("/media/m-1/hls/master.m3u8");
    expect(media.thumbnailUrl).toBe("/media/m-1/thumb");
    expect(media.durationMs).toBe(12000);
    expect(media.variants?.["poster"]?.width).toBe(720);
    expect(media.captions[0]?.lang).toBe("en");
  });

  it("getReels normalizes a page of posts", async () => {
    const fetchImpl = vi.fn<FetchFn>(async (url) => {
      expect(url).toContain("/api/v1/reels");
      return jsonResponse({ data: [], page: { next_cursor: null, has_more: false } });
    });
    const client = makeClient(fetchImpl);
    await expect(client.getReels()).resolves.toEqual({ items: [], nextCursor: null });
  });
});

describe("GGClient stories (Phase 2)", () => {
  it("createStory posts media_id + audience and normalizes the frame", async () => {
    const fetchImpl = vi.fn<FetchFn>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body["media_id"]).toBe("m-1");
      expect(body["audience"]).toBe("close_friends");
      return jsonResponse(
        {
          id: "s-1",
          author: {
            id: "u-1",
            handle: "aman",
            display_name: "Aman",
            avatar_url: null,
            author_type: "human",
            verified: false,
            trust_tier: "standard",
          },
          media: { ...mediaWire, status: "ready", url: "/media/m-1/medium" },
          audience: "close_friends",
          stickers: [],
          music_ref: null,
          expires_at: "2026-10-12T00:00:00.000Z",
          created_at: "2026-10-11T00:00:00.000Z",
          view_count: 0,
          viewer_has_seen: true,
        },
        201,
      );
    });
    const client = makeClient(fetchImpl);
    const story = await client.createStory({ mediaId: "m-1", audience: "close_friends" });
    expect(story.id).toBe("s-1");
    expect(story.media.url).toBe("/media/m-1/medium");
    expect(story.author.handle).toBe("aman");
  });

  it("getStoriesFeed maps groups with has_unseen", async () => {
    const fetchImpl = vi.fn<FetchFn>(async () =>
      jsonResponse({
        data: [
          {
            author: {
              id: "u-1",
              handle: "aman",
              display_name: "Aman",
              avatar_url: null,
              author_type: "human",
              verified: false,
              trust_tier: "standard",
            },
            stories: [],
            has_unseen: true,
          },
        ],
      }),
    );
    const client = makeClient(fetchImpl);
    const groups = await client.getStoriesFeed();
    expect(groups).toHaveLength(1);
    expect(groups[0]?.hasUnseen).toBe(true);
  });

  it("viewStory and deleteStory hit their endpoints", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn<FetchFn>(async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(null, { status: 204 });
    });
    const client = makeClient(fetchImpl);
    await client.viewStory("s-1");
    await client.deleteStory("s-1");
    expect(calls[0]).toContain("POST");
    expect(calls[0]).toContain("/api/v1/stories/s-1/view");
    expect(calls[1]).toContain("DELETE");
    expect(calls[1]).toContain("/api/v1/stories/s-1");
  });
});
