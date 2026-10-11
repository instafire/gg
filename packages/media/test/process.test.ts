import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import {
  LocalStorageAdapter,
  hasExecutableSignature,
  mimeMatches,
  processMediaFile,
  sniffBuffer,
} from "../src/index";

const execFileAsync = promisify(execFile);

let store: LocalStorageAdapter;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "gg-media-test-"));
  store = new LocalStorageAdapter(root);
});

/** A real 96x64 PNG carrying GPS EXIF, generated in-test. */
async function makePngWithExif(): Promise<Buffer> {
  return sharp({
    create: { width: 96, height: 64, channels: 3, background: { r: 40, g: 120, b: 200 } },
  })
    .withExif({
      IFD2: { GPSLatitude: "43.5", GPSLongitude: "-80.2" },
    })
    .png()
    .toBuffer();
}

describe("sniffing", () => {
  it("identifies PNG / MP4 / executable signatures by magic bytes", async () => {
    const png = await makePngWithExif();
    expect(sniffBuffer(png)?.mime).toBe("image/png");
    const mp4 = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftypisom", "ascii"),
      Buffer.alloc(16),
    ]);
    expect(sniffBuffer(mp4)?.mime).toBe("video/mp4");
    const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
    expect(hasExecutableSignature(exe)).toBe(true);
    expect(sniffBuffer(exe)).toBeNull();
    expect(mimeMatches("video/mp4", { kind: "video", mime: "video/quicktime", ext: "mov" })).toBe(true);
    expect(mimeMatches("image/png", { kind: "video", mime: "video/mp4", ext: "mp4" })).toBe(false);
  });
});

describe("processMediaFile — image round trip", () => {
  it("produces renditions + blurhash and strips EXIF from the stored original", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const key = `media/${id}/original.png`;
    await store.put(key, await makePngWithExif());

    const result = await processMediaFile(store, {
      id,
      kind: "image",
      mimeType: "image/png",
      storageKey: key,
    });

    expect(result.status).toBe("ready");
    expect(result.scanVerdict).toBe("clean");
    expect(result.width).toBe(96);
    expect(result.height).toBe(64);
    expect(result.blurhash).toBeTruthy();
    expect(result.exifStripped).toBe(true);
    // The scanner honestly labels its NSFW stub (no fake scores).
    expect(result.contentLabels.classifier).toBe("stub-passthrough-v1");
    expect(result.contentLabels.nsfw).toBeNull();

    const sizes = (result.variants as { sizes: Record<string, { key: string; width: number; format: string }> }).sizes;
    expect(sizes.thumb).toBeDefined();
    expect(sizes.thumb!.width).toBeLessThanOrEqual(96);
    expect(sizes.thumb_avif).toBeDefined();
    for (const rendition of Object.values(sizes)) {
      expect(await store.exists(rendition.key)).toBe(true);
    }

    // EXIF/GPS is gone from the stored original.
    const storedMeta = await sharp(store.localPath(key)).metadata();
    expect(storedMeta.exif).toBeUndefined();
  });
});

describe("processMediaFile — moderation gate", () => {
  it("rejects an executable renamed to .png and quarantines the bytes", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const key = `media/${id}/original.png`;
    const exeBytes = Buffer.concat([
      Buffer.from([0x4d, 0x5a]), // MZ
      Buffer.alloc(2048, 7),
    ]);
    await store.put(key, exeBytes);

    const result = await processMediaFile(store, {
      id,
      kind: "image",
      mimeType: "image/png",
      storageKey: key,
    });

    expect(result.status).toBe("rejected");
    expect(result.scanVerdict).toBe("rejected");
    expect(result.storageKey).toContain("quarantine/");
    expect(await store.exists(result.storageKey)).toBe(true);
    expect(await store.exists(key)).toBe(false);
  });

  it("rejects a real PNG whose declared type lies (declared video/mp4)", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const key = `media/${id}/original.mp4`;
    await store.put(key, await makePngWithExif());
    const result = await processMediaFile(store, {
      id,
      kind: "video",
      mimeType: "video/mp4",
      storageKey: key,
    });
    expect(result.status).toBe("rejected");
  });
});

describe("processMediaFile — video round trip (ffmpeg)", () => {
  it("transcodes a 1s clip to HLS with poster + probed duration", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const key = `media/${id}/original.mp4`;
    const tmpSource = path.join(root, "fixture-src.mp4");
    await execFileAsync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x240:d=1",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=44100:cl=stereo",
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      tmpSource,
    ]);
    const { readFile } = await import("node:fs/promises");
    await store.put(key, await readFile(tmpSource));

    const result = await processMediaFile(
      store,
      { id, kind: "video", mimeType: "video/mp4", storageKey: key },
    );

    expect(result.status).toBe("ready");
    expect(result.width).toBe(320);
    expect(result.height).toBe(240);
    expect(result.durationMs).toBeGreaterThan(500);
    expect(result.durationMs).toBeLessThan(2500);
    const variants = result.variants as {
      hls_playlist_key: string;
      thumbnail_key: string;
      sizes: { poster: { key: string } };
      captions: unknown[];
    };
    expect(await store.exists(variants.hls_playlist_key)).toBe(true);
    const master = (await store.read(variants.hls_playlist_key)).toString("utf8");
    expect(master).toContain("#EXT-X-STREAM-INF");
    expect(master).toContain("240p.m3u8"); // ladder capped by the 240p source
    expect(await store.exists(variants.sizes.poster.key)).toBe(true);
    expect(await store.exists(variants.thumbnail_key)).toBe(true);
    // Caption plumbing exists; the stub transcriber honestly returns none.
    expect(variants.captions).toEqual([]);
  }, 120_000);
});
