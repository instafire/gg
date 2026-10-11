/**
 * Media processing job (queue `gg-media`, job `media.process`): loads the
 * media row, runs the @gg/media pipeline (scan gate → renditions/HLS),
 * and persists the outcome. Idempotent: rows that are not awaiting
 * processing are skipped, so BullMQ retries and duplicate enqueues are
 * safe.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  processMediaFile,
  type FileStore,
  type MediaProcessorDeps,
} from "@gg/media";
import { mediaTable, type WorkerDb } from "./db";

export interface MediaJobPatch {
  status: string;
  scanVerdict: string;
  contentLabels: Record<string, unknown>;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  blurhash: string | null;
  variants: Record<string, unknown>;
  exifStripped: boolean;
  storageKey: string;
  processingError: string | null;
  updatedAt: Date;
}

export interface MediaJobRepo {
  getMedia(
    id: string,
  ): Promise<{ id: string; kind: string; mimeType: string; storageKey: string; status: string } | null>;
  updateMedia(id: string, patch: MediaJobPatch): Promise<void>;
}

export function drizzleMediaRepo(db: WorkerDb): MediaJobRepo {
  return {
    async getMedia(id) {
      const [row] = await db
        .select()
        .from(mediaTable)
        .where(eq(mediaTable.id, id))
        .limit(1);
      if (!row) return null;
      return {
        id: row.id,
        kind: row.kind,
        mimeType: row.mimeType,
        storageKey: row.storageKey,
        status: row.status,
      };
    },
    async updateMedia(id, patch) {
      await db
        .update(mediaTable)
        .set({
          status: patch.status,
          scanVerdict: patch.scanVerdict,
          contentLabels: patch.contentLabels,
          width: patch.width,
          height: patch.height,
          durationMs: patch.durationMs,
          blurhash: patch.blurhash,
          variants: patch.variants,
          exifStripped: patch.exifStripped,
          storageKey: patch.storageKey,
          processingError: patch.processingError,
          updatedAt: patch.updatedAt,
        })
        .where(eq(mediaTable.id, id));
    },
  };
}

export type MediaJobOutcome = "ready" | "rejected" | "failed" | "skipped";

export async function runMediaJob(
  repo: MediaJobRepo,
  store: FileStore,
  mediaId: string,
  deps: MediaProcessorDeps = {},
): Promise<MediaJobOutcome> {
  const row = await repo.getMedia(mediaId);
  if (!row) return "skipped";
  if (row.status !== "processing") return "skipped";
  const result = await processMediaFile(
    store,
    {
      id: row.id,
      kind: row.kind as "image" | "video" | "audio" | "gif",
      mimeType: row.mimeType,
      storageKey: row.storageKey,
    },
    deps,
  );
  await repo.updateMedia(mediaId, {
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
  });
  return result.status;
}

/**
 * Delete every stored object for a media item (original + renditions + the
 * HLS/captions directories). Used by the story purge; tolerant of missing
 * files.
 */
export async function deleteMediaFiles(
  store: FileStore,
  mediaId: string,
  storageKey: string,
): Promise<void> {
  await store.delete(storageKey).catch(() => undefined);
  const mediaDir = store.localPath(`media/${mediaId}`);
  await rm(mediaDir, { recursive: true, force: true }).catch(() => undefined);
  // storageKey may live outside media/{id} after a quarantine move.
  const keyDir = path.dirname(store.localPath(storageKey));
  if (!keyDir.startsWith(mediaDir)) {
    await rm(keyDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
