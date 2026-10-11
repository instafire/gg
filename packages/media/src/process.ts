/**
 * Media processing orchestration: scan gate first, then the kind-specific
 * pipeline. Pure with respect to the database — it takes a media snapshot
 * and returns the field patch the caller persists, which keeps it unit
 * testable and reusable from the worker and from API tests alike.
 *
 * Gate semantics: a `rejected` scan moves the original into `quarantine/`
 * and the media can never be served (the file route only serves `ready`).
 */
import { processAudio } from "./audio";
import { processImage } from "./image";
import { LocalScanner, type MediaScanner } from "./scanner";
import { sniffBuffer } from "./sniff";
import type { FileStore } from "./storage";
import { FfmpegTranscoder, type TranscoderAdapter } from "./video";

export interface MediaSnapshot {
  id: string;
  kind: "image" | "video" | "audio" | "gif";
  mimeType: string;
  storageKey: string;
}

export interface MediaProcessResult {
  status: "ready" | "rejected" | "failed";
  scanVerdict: "pending" | "clean" | "review" | "rejected";
  contentLabels: Record<string, unknown>;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  blurhash: string | null;
  variants: Record<string, unknown>;
  exifStripped: boolean;
  /** New storage key when the original was moved (quarantine). */
  storageKey: string;
  error?: string;
}

export interface MediaProcessorDeps {
  scanner?: MediaScanner;
  transcoder?: TranscoderAdapter;
}

export async function processMediaFile(
  store: FileStore,
  media: MediaSnapshot,
  deps: MediaProcessorDeps = {},
): Promise<MediaProcessResult> {
  const scanner = deps.scanner ?? new LocalScanner();
  const transcoder = deps.transcoder ?? new FfmpegTranscoder();
  const base: MediaProcessResult = {
    status: "failed",
    scanVerdict: "pending",
    contentLabels: {},
    width: null,
    height: null,
    durationMs: null,
    blurhash: null,
    variants: {},
    exifStripped: false,
    storageKey: media.storageKey,
  };

  // 1. Scan gate — nothing is processed (or served) before this passes.
  const scan = await scanner.scan({
    path: store.localPath(media.storageKey),
    declaredMime: media.mimeType,
  });
  base.contentLabels = scan.labels;
  if (scan.verdict === "rejected") {
    const quarantineKey = `quarantine/${media.id}/${media.storageKey.split("/").pop() ?? "original"}`;
    await store.move(media.storageKey, quarantineKey);
    return {
      ...base,
      status: "rejected",
      scanVerdict: "rejected",
      storageKey: quarantineKey,
      error: scan.reason ?? "rejected",
    };
  }
  base.scanVerdict = scan.verdict;

  // 2. Pipeline per kind.
  try {
    if (media.kind === "image" || media.kind === "gif") {
      const sniffed =
        scan.sniffed ?? sniffBuffer(await store.read(media.storageKey));
      const result = await processImage(
        store,
        media.id,
        media.storageKey,
        sniffed?.ext ?? "png",
      );
      return {
        ...base,
        status: "ready",
        width: result.width,
        height: result.height,
        blurhash: result.blurhash,
        variants: { sizes: result.sizes },
        exifStripped: result.exifStripped,
      };
    }
    if (media.kind === "video") {
      const result = await transcoder.transcode({
        store,
        mediaId: media.id,
        sourceKey: media.storageKey,
      });
      return {
        ...base,
        status: "ready",
        width: result.width,
        height: result.height,
        durationMs: result.durationMs,
        variants: {
          sizes: { poster: result.poster },
          hls_playlist_key: result.hlsPlaylistKey,
          thumbnail_key: result.thumbnailKey,
          captions: result.captions,
        },
        // Video containers can carry location metadata; ffmpeg re-encode
        // (libx264 output above) does not copy source metadata by default.
        exifStripped: true,
      };
    }
    if (media.kind === "audio") {
      // Voice notes / audio (Phase 5A): probe duration + strip embedded
      // metadata by re-mux; no rendition ladder (D-046).
      const result = await processAudio(store, media.storageKey);
      return {
        ...base,
        status: "ready",
        durationMs: result.durationMs,
        variants: {},
        exifStripped: result.exifStripped,
        contentLabels: { ...base.contentLabels, audio_codec: result.codec },
      };
    }
    return { ...base, status: "failed", error: `Unsupported kind: ${media.kind}` };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
