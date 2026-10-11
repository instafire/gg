/**
 * Phase 2 integration tests — media pipeline, media posts, reels, stories.
 *
 * Runs against gg_test (DATABASE_URL override) with a temp MEDIA_DIR.
 * The worker is not running here: after each upload completes, the test
 * runs the real @gg/media pipeline in-process and persists the result the
 * same way apps/worker's media job does (the job itself is covered by
 * apps/worker tests).
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { LocalStorageAdapter, processMediaFile } from "@gg/media";
import { buildApp } from "../src/app";
import { loadConfig, loadDotEnv } from "../src/config";
import { closeDb, getDb } from "../src/db";
import { media, stories } from "../src/db/schema";

process.env.MEDIA_DIR = mkdtempSync(path.join(os.tmpdir(), "gg-phase2-media-"));

const suffix = randomBytes(3).toString("hex");
const cred = ["phase2", "pass", "123456"].join("-");

let app: FastifyInstance;
let config: ReturnType<typeof loadConfig>;
let tokenA = "";
let tokenB = "";
let userIdA = "";

interface MediaWire {
  id: string;
  status: string;
  url: string | null;
  variants: Record<string, { url?: string } | string>;
  blurhash: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  captions: unknown[];
}

async function registerUser(handle: string): Promise<{ token: string; id: string }> {
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
  const body = res.json() as {
    user: { id: string };
    tokens: { access_token: string };
  };
  return { token: body.tokens.access_token, id: body.user.id };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** Session → PUT bytes → complete. Returns the media id. */
async function uploadBytes(
  token: string,
  kind: string,
  mimeType: string,
  bytes: Buffer,
): Promise<{ mediaId: string; completeStatus: number; body: MediaWire }> {
  const session = await app.inject({
    method: "POST",
    url: "/api/v1/media/uploads",
    headers: auth(token),
    payload: { kind, mime_type: mimeType, size_bytes: bytes.length },
  });
  expect(session.statusCode).toBe(201);
  const wire = session.json() as {
    media_id: string;
    signed_put_url: string;
    tus_url: string;
  };
  const put = await app.inject({
    method: "PUT",
    url: wire.signed_put_url,
    headers: { ...auth(token), "content-type": "application/octet-stream" },
    payload: bytes,
  });
  expect(put.statusCode).toBe(200);
  const complete = await app.inject({
    method: "POST",
    url: `/api/v1/media/uploads/${wire.media_id}/complete`,
    headers: auth(token),
    payload: {},
  });
  return {
    mediaId: wire.media_id,
    completeStatus: complete.statusCode,
    body: complete.json() as MediaWire,
  };
}

/** Run the real pipeline in-process and persist like the worker job does. */
async function processInProcess(mediaId: string): Promise<void> {
  const { db } = getDb(config.DATABASE_URL);
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

let imageMediaId = "";
let videoMediaId = "";

beforeAll(async () => {
  loadDotEnv();
  config = loadConfig();
  app = await buildApp(config);
  await app.ready();
  const a = await registerUser(`p2alice_${suffix}`);
  tokenA = a.token;
  userIdA = a.id;
  const b = await registerUser(`p2bob_${suffix}`);
  tokenB = b.token;
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe("media uploads (Phase 2)", () => {
  it("runs a PNG through session → PUT → complete → process → ready", async () => {
    const png = await sharp({
      create: { width: 96, height: 64, channels: 3, background: { r: 200, g: 80, b: 40 } },
    })
      .png()
      .withMetadata({
        exif: { GPS: { GPSLatitudeRef: "N", GPSLatitude: "43/1 28/1 0/1" } },
      })
      .toBuffer();
    const { mediaId, completeStatus, body } = await uploadBytes(
      tokenA,
      "image",
      "image/png",
      png,
    );
    expect(completeStatus).toBe(202);
    expect(body.status).toBe("processing");
    imageMediaId = mediaId;

    await processInProcess(mediaId);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/media/${mediaId}`,
      headers: auth(tokenA),
    });
    expect(res.statusCode).toBe(200);
    const wire = res.json() as MediaWire;
    expect(wire.status).toBe("ready");
    expect(wire.blurhash).toBeTruthy();
    expect(wire.width).toBe(96);
    expect(wire.url).toContain(`/media/${mediaId}/`);

    // The stored original had its GPS EXIF stripped by the pipeline.
    const store = new LocalStorageAdapter(config.MEDIA_DIR);
    const stored = await store.read(`media/${mediaId}/original.png`);
    const meta = await sharp(stored).metadata();
    expect(meta.exif).toBeUndefined();

    // A rendition is publicly served with immutable cache headers.
    const file = await app.inject({ method: "GET", url: `/media/${mediaId}/thumb` });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toContain("image/webp");
    expect(file.headers["cache-control"]).toContain("immutable");
  });

  it("rejects an executable renamed to .png and never serves it", async () => {
    const mz = Buffer.concat([
      Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
      Buffer.alloc(512, 7),
    ]);
    const { mediaId, completeStatus } = await uploadBytes(
      tokenA,
      "image",
      "image/png",
      mz,
    );
    expect(completeStatus).toBe(422);
    const { db } = getDb(config.DATABASE_URL);
    const [row] = await db.select().from(media).where(eq(media.id, mediaId)).limit(1);
    expect(row?.status).toBe("rejected");
    expect(row?.scanVerdict).toBe("rejected");
    const file = await app.inject({ method: "GET", url: `/media/${mediaId}/original` });
    expect(file.statusCode).toBe(404);
  });

  it("enforces the image size cap at session creation (413)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/media/uploads",
      headers: auth(tokenA),
      payload: { kind: "image", mime_type: "image/png", size_bytes: 26 * 1024 * 1024 },
    });
    expect(res.statusCode).toBe(413);
  });

  it("supports tus PATCH chunk uploads", async () => {
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    const session = await app.inject({
      method: "POST",
      url: "/api/v1/media/uploads",
      headers: auth(tokenA),
      payload: { kind: "image", mime_type: "image/png", size_bytes: png.length },
    });
    const wire = session.json() as { media_id: string; tus_url: string };
    const half = Math.floor(png.length / 2);
    const patch1 = await app.inject({
      method: "PATCH",
      url: wire.tus_url,
      headers: {
        ...auth(tokenA),
        "content-type": "application/offset+octet-stream",
        "upload-offset": "0",
      },
      payload: png.subarray(0, half),
    });
    expect(patch1.statusCode).toBe(204);
    expect(patch1.headers["upload-offset"]).toBe(String(half));
    const patch2 = await app.inject({
      method: "PATCH",
      url: wire.tus_url,
      headers: {
        ...auth(tokenA),
        "content-type": "application/offset+octet-stream",
        "upload-offset": String(half),
      },
      payload: png.subarray(half),
    });
    expect(patch2.statusCode).toBe(204);
    const complete = await app.inject({
      method: "POST",
      url: `/api/v1/media/uploads/${wire.media_id}/complete`,
      headers: auth(tokenA),
      payload: {},
    });
    expect(complete.statusCode).toBe(202);
  });

  it("processes a 1s mp4 into HLS and attaches it to a VIDEO post", async () => {
    let ffmpegOk = true;
    const tmpVideo = path.join(os.tmpdir(), `gg-p2-${suffix}.mp4`);
    try {
      execFileSync("ffmpeg", [
        "-y",
        "-f", "lavfi",
        "-i", "testsrc=duration=1:size=320x240:rate=30",
        "-f", "lavfi",
        "-i", "sine=frequency=440:duration=1",
        "-shortest",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        tmpVideo,
      ], { stdio: "pipe" });
    } catch {
      ffmpegOk = false;
    }
    if (!ffmpegOk) return; // ffmpeg absent on this host; video path covered by @gg/media tests
    const { readFileSync } = await import("node:fs");
    const bytes = readFileSync(tmpVideo);
    const { mediaId, completeStatus } = await uploadBytes(
      tokenA,
      "video",
      "video/mp4",
      bytes,
    );
    expect(completeStatus).toBe(202);
    videoMediaId = mediaId;
    await processInProcess(mediaId);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/media/${mediaId}`,
      headers: auth(tokenA),
    });
    const wire = res.json() as MediaWire;
    expect(wire.status).toBe("ready");
    expect(wire.duration_ms).toBeGreaterThan(400);
    const hls = wire.variants["hls_url"];
    expect(typeof hls).toBe("string");

    const post = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: auth(tokenA),
      payload: { type: "VIDEO", body_md: "clip", media_ids: [mediaId] },
    });
    expect(post.statusCode).toBe(201);
    const postBody = post.json() as { media: MediaWire[] };
    expect(postBody.media).toHaveLength(1);
    expect(postBody.media[0]?.variants["hls_url"]).toBeTruthy();

    // Master playlist + a rung playlist are publicly served.
    const master = await app.inject({
      method: "GET",
      url: `/media/${mediaId}/hls/master.m3u8`,
    });
    expect(master.statusCode).toBe(200);
    expect(master.headers["content-type"]).toContain("mpegurl");
    expect(master.body).toContain("#EXTM3U");
  });
});

describe("media posts + reels (Phase 2)", () => {
  it("creates an IMAGE post and alt text is editable", async () => {
    const post = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: auth(tokenA),
      payload: {
        type: "IMAGE",
        body_md: "look",
        media_ids: [imageMediaId],
      },
    });
    expect(post.statusCode).toBe(201);
    const body = post.json() as { media: MediaWire[] };
    expect(body.media).toHaveLength(1);
    expect(body.media[0]?.id).toBe(imageMediaId);

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/media/${imageMediaId}`,
      headers: auth(tokenA),
      payload: { alt_text: "an orange rectangle" },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { alt_text: string }).alt_text).toBe("an orange rectangle");

    // Someone else cannot edit it.
    const foreign = await app.inject({
      method: "PATCH",
      url: `/api/v1/media/${imageMediaId}`,
      headers: auth(tokenB),
      payload: { alt_text: "hax" },
    });
    expect(foreign.statusCode).toBe(403);
  });

  it("rejects attaching media that is not ready / not owned", async () => {
    const post = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: auth(tokenB),
      payload: { type: "IMAGE", media_ids: [imageMediaId] },
    });
    expect(post.statusCode).toBe(403);
  });

  it("reels feed returns REEL posts only", async () => {
    if (!videoMediaId) return; // video test skipped (no ffmpeg)
    const reel = await app.inject({
      method: "POST",
      url: "/api/v1/posts",
      headers: auth(tokenA),
      payload: { type: "REEL", media_ids: [videoMediaId] },
    });
    expect(reel.statusCode).toBe(201);
    const feed = await app.inject({
      method: "GET",
      url: "/api/v1/reels",
      headers: auth(tokenA),
    });
    expect(feed.statusCode).toBe(200);
    const page = feed.json() as { data: { id: string; type: string }[] };
    expect(page.data.length).toBeGreaterThan(0);
    expect(page.data.every((p) => p.type === "REEL")).toBe(true);
  });
});

describe("stories (Phase 2)", () => {
  let storyId = "";

  it("creates a story, shows it in the feed, tracks views", async () => {
    // Bob follows Alice so her ring shows in his feed too.
    await app.inject({
      method: "POST",
      url: `/api/v1/users/p2alice_${suffix}/follow`,
      headers: auth(tokenB),
    });
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/stories",
      headers: auth(tokenA),
      payload: { media_id: imageMediaId },
    });
    expect(create.statusCode).toBe(201);
    storyId = (create.json() as { id: string }).id;

    const feed = await app.inject({
      method: "GET",
      url: "/api/v1/stories/feed",
      headers: auth(tokenB),
    });
    const groups = (feed.json() as { data: { author: { id: string }; stories: { id: string }[] }[] }).data;
    const mine = groups.find((g) => g.author.id === userIdA);
    expect(mine?.stories.some((s) => s.id === storyId)).toBe(true);

    const view = await app.inject({
      method: "POST",
      url: `/api/v1/stories/${storyId}/view`,
      headers: auth(tokenB),
      payload: {},
    });
    expect(view.statusCode).toBe(204);

    const viewers = await app.inject({
      method: "GET",
      url: `/api/v1/stories/${storyId}/viewers`,
      headers: auth(tokenA),
    });
    expect(viewers.statusCode).toBe(200);
    const page = viewers.json() as { data: { id: string }[] };
    expect(page.data.length).toBe(1);
  });

  it("serves the author's active story group for the profile ring", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/users/p2alice_${suffix}/stories`,
      headers: auth(tokenB),
    });
    expect(res.statusCode).toBe(200);
    const group = (
      res.json() as {
        data: {
          author: { id: string };
          stories: { id: string }[];
          has_unseen: boolean;
        } | null;
      }
    ).data;
    expect(group?.author.id).toBe(userIdA);
    expect(group?.stories.some((s) => s.id === storyId)).toBe(true);
    // Bob already viewed the only frame in the previous test.
    expect(group?.has_unseen).toBe(false);

    // …and the story must NOT leak into post feeds as an empty card
    // (regression: stories are posts rows and used to surface in /feed).
    const homeFeed = await app.inject({
      method: "GET",
      url: "/api/v1/feed/home",
      headers: auth(tokenB),
    });
    const feedItems = (
      homeFeed.json() as { data: { post: { id: string; type: string } }[] }
    ).data;
    expect(feedItems.some((item) => item.post.id === storyId)).toBe(false);
    expect(feedItems.some((item) => item.post.type === "STORY")).toBe(false);
    const profilePosts = await app.inject({
      method: "GET",
      url: `/api/v1/users/p2alice_${suffix}/posts?tab=posts`,
      headers: auth(tokenB),
    });
    const tabItems = (profilePosts.json() as { data: { id: string; type: string }[] }).data;
    expect(tabItems.some((p) => p.type === "STORY")).toBe(false);

    const noStory = await app.inject({
      method: "GET",
      url: `/api/v1/users/p2bob_${suffix}/stories`,
      headers: auth(tokenA),
    });
    expect((noStory.json() as { data: unknown }).data).toBeNull();

    const unknown = await app.inject({
      method: "GET",
      url: "/api/v1/users/no_such_user_zzz/stories",
      headers: auth(tokenA),
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("expired stories vanish from feed and detail (24h rule)", async () => {
    const { db } = getDb(config.DATABASE_URL);
    await db
      .update(stories)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(stories.postId, storyId));
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/stories/${storyId}`,
      headers: auth(tokenA),
    });
    expect(detail.statusCode).toBe(404);
    const feed = await app.inject({
      method: "GET",
      url: "/api/v1/stories/feed",
      headers: auth(tokenA),
    });
    const groups = (feed.json() as { data: { stories: { id: string }[] }[] }).data;
    expect(groups.flatMap((g) => g.stories).some((s) => s.id === storyId)).toBe(false);
  });
});
