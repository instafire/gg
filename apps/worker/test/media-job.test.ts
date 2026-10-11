import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { LocalStorageAdapter } from "@gg/media";
import { runMediaJob, type MediaJobPatch, type MediaJobRepo } from "../src/media-job";
import {
  purgeExpiredStories,
  type PurgeableStory,
  type StorySweepRepo,
} from "../src/story-sweep";

let root: string;
let store: LocalStorageAdapter;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "gg-worker-test-"));
  store = new LocalStorageAdapter(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function pngWithGps(): Promise<Buffer> {
  return sharp({
    create: { width: 96, height: 64, channels: 3, background: { r: 40, g: 120, b: 200 } },
  })
    .png()
    .withMetadata({ exif: { GPS: { GPSLatitudeRef: "N", GPSLatitude: "43/1 28/1 0/1" } } })
    .toBuffer();
}

describe("runMediaJob", () => {
  it("marks an image ready and persists renditions + blurhash", async () => {
    const id = "0190a000-0000-7000-8000-000000000001";
    const key = `media/${id}/original.png`;
    await store.put(key, await pngWithGps());
    let patch: MediaJobPatch | null = null;
    const repo: MediaJobRepo = {
      getMedia: async () => ({
        id,
        kind: "image",
        mimeType: "image/png",
        storageKey: key,
        status: "processing",
      }),
      updateMedia: async (_id, p) => {
        patch = p;
      },
    };
    const outcome = await runMediaJob(repo, store, id);
    expect(outcome).toBe("ready");
    expect(patch).not.toBeNull();
    const persisted = patch as unknown as MediaJobPatch;
    expect(persisted.status).toBe("ready");
    expect(persisted.scanVerdict).toBe("clean");
    expect(persisted.width).toBe(96);
    expect(persisted.height).toBe(64);
    expect(typeof persisted.blurhash).toBe("string");
    const sizes = (persisted.variants as { sizes: Record<string, { key: string }> }).sizes;
    expect(Object.keys(sizes)).toContain("thumb");
    for (const rendition of Object.values(sizes)) {
      expect(await store.exists(rendition.key)).toBe(true);
    }
  });

  it("skips media that is not awaiting processing (idempotent)", async () => {
    const repo: MediaJobRepo = {
      getMedia: async () => ({
        id: "x",
        kind: "image",
        mimeType: "image/png",
        storageKey: "media/x/original.png",
        status: "ready",
      }),
      updateMedia: async () => {
        throw new Error("must not be called");
      },
    };
    expect(await runMediaJob(repo, store, "x")).toBe("skipped");
  });
});

describe("purgeExpiredStories", () => {
  it("purges old stories and deletes unreferenced media files", async () => {
    const mediaId = "0190a000-0000-7000-8000-0000000000aa";
    const key = `media/${mediaId}/original.png`;
    await store.put(key, Buffer.from("fake"));
    const purged: string[] = [];
    const deletedRows: string[] = [];
    const repo: StorySweepRepo = {
      listPurgeable: async (): Promise<PurgeableStory[]> => [
        { postId: "story-1", mediaId, mediaStorageKey: key },
      ],
      mediaReferenceCount: async () => 0,
      purgeStory: async (postId) => {
        purged.push(postId);
      },
      deleteMediaRow: async (id) => {
        deletedRows.push(id);
      },
    };
    const result = await purgeExpiredStories(repo, store);
    expect(result).toEqual({ purged: 1, mediaDeleted: 1 });
    expect(purged).toEqual(["story-1"]);
    expect(deletedRows).toEqual([mediaId]);
    expect(await store.exists(key)).toBe(false);
  });

  it("keeps media that other content still references", async () => {
    const mediaId = "0190a000-0000-7000-8000-0000000000bb";
    const key = `media/${mediaId}/original.png`;
    await store.put(key, Buffer.from("fake"));
    const repo: StorySweepRepo = {
      listPurgeable: async () => [{ postId: "story-2", mediaId, mediaStorageKey: key }],
      mediaReferenceCount: async () => 2,
      purgeStory: async () => undefined,
      deleteMediaRow: async () => {
        throw new Error("must not delete referenced media");
      },
    };
    const result = await purgeExpiredStories(repo, store);
    expect(result.mediaDeleted).toBe(0);
    expect(await store.exists(key)).toBe(true);
  });
});
