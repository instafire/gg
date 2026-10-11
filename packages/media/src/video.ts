/**
 * Video pipeline (ARCHITECTURE §6 step 4): transcoding sits behind the
 * TranscoderAdapter interface — the default implementation shells out to
 * ffmpeg/ffprobe and produces an HLS rendition ladder, a poster frame and
 * a thumbnail. A hosted provider (Mux / Cloudflare Stream) can implement
 * the same interface without API changes.
 *
 * Captions: the caption-track plumbing is real (tracks are stored as WebVTT
 * sidecars and surfaced on the MediaObject), but the transcriber is a STUB
 * adapter — no speech-to-text runs in Phase 2 (free-only rule; no external
 * STT service, no bundled Whisper model). StubTranscriber returns zero
 * tracks; a Whisper implementation drops into the same interface later
 * (DECISIONS D-028).
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import type { FileStore } from "./storage";
import type { Rendition } from "./image";

const execFileAsync = promisify(execFile);

export interface VideoProbe {
  width: number;
  height: number;
  durationMs: number;
  hasAudio: boolean;
}

interface FfprobeOutput {
  streams?: Array<{
    codec_type?: string;
    width?: number;
    height?: number;
  }>;
  format?: { duration?: string };
}

export async function probeVideo(filePath: string): Promise<VideoProbe> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    filePath,
  ]);
  const parsed = JSON.parse(stdout) as FfprobeOutput;
  const videoStream = parsed.streams?.find((s) => s.codec_type === "video");
  if (!videoStream?.width || !videoStream?.height) {
    throw new Error("No video stream found");
  }
  const durationSeconds = Number.parseFloat(parsed.format?.duration ?? "0");
  return {
    width: videoStream.width,
    height: videoStream.height,
    durationMs: Math.round(durationSeconds * 1000),
    hasAudio: parsed.streams?.some((s) => s.codec_type === "audio") ?? false,
  };
}

// ─── Captions ───────────────────────────────────────────────────────────────

export interface CaptionTrack {
  lang: string;
  key: string;
  source: "auto" | "user";
}

export interface TranscriberAdapter {
  /** Return caption tracks for a video (WebVTT files written via `write`). */
  transcribe(input: {
    mediaId: string;
    filePath: string;
    durationMs: number;
    write: (lang: string, vtt: string) => Promise<string>;
  }): Promise<CaptionTrack[]>;
}

/** Phase 2 stub: produces no captions. See the module docstring. */
export class StubTranscriber implements TranscriberAdapter {
  async transcribe(): Promise<CaptionTrack[]> {
    return [];
  }
}

// ─── Transcoder ─────────────────────────────────────────────────────────────

export interface VideoProcessResult {
  width: number;
  height: number;
  durationMs: number;
  hlsPlaylistKey: string;
  poster: Rendition;
  thumbnailKey: string;
  captions: CaptionTrack[];
}

export interface TranscoderAdapter {
  probe(filePath: string): Promise<VideoProbe>;
  transcode(input: {
    store: FileStore;
    mediaId: string;
    sourceKey: string;
  }): Promise<VideoProcessResult>;
}

const LADDER_HEIGHTS = [1080, 720, 360];
const BITRATE_KBPS: Record<number, number> = { 1080: 5000, 720: 2800, 360: 800 };

export class FfmpegTranscoder implements TranscoderAdapter {
  constructor(private readonly transcriber: TranscriberAdapter = new StubTranscriber()) {}

  async probe(filePath: string): Promise<VideoProbe> {
    return probeVideo(filePath);
  }

  async transcode(input: {
    store: FileStore;
    mediaId: string;
    sourceKey: string;
  }): Promise<VideoProcessResult> {
    const { store, mediaId, sourceKey } = input;
    const sourcePath = store.localPath(sourceKey);
    const probe = await probeVideo(sourcePath);

    const heights = LADDER_HEIGHTS.filter((h) => h <= probe.height);
    if (heights.length === 0) heights.push(probe.height - (probe.height % 2));

    const hlsDirKey = `media/${mediaId}/hls`;
    const hlsDir = store.localPath(hlsDirKey);
    await mkdir(hlsDir, { recursive: true });

    // Rungs encode in parallel and at `veryfast`: the staging host is a
    // 2010-era dual-core, where the previous serial encodes at the default
    // (medium) preset took ~80s for a 90s 720p clip and users watched the
    // composer sit on "Processing…" until it timed out. veryfast + parallel
    // rungs cut that to roughly a third at the same bitrates.
    await Promise.all(
      heights.map(async (height) => {
        const args = [
          "-y",
          "-i",
          sourcePath,
          "-map",
          "0:v:0",
          "-vf",
          `scale=-2:${height}`,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-profile:v",
          "main",
          "-pix_fmt",
          "yuv420p",
          "-b:v",
          `${BITRATE_KBPS[height] ?? 800}k`,
          "-hls_time",
          "6",
          "-hls_playlist_type",
          "vod",
          "-hls_segment_filename",
          path.join(hlsDir, `${height}p-seg-%05d.ts`),
        ];
        if (probe.hasAudio) {
          args.push("-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k", "-ac", "2");
        }
        args.push(path.join(hlsDir, `${height}p.m3u8`));
        await execFileAsync("ffmpeg", args, { maxBuffer: 16 * 1024 * 1024 });
      }),
    );

    // Master playlist (bandwidth figures are nominal per-rung estimates).
    const master = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      ...heights.flatMap((height) => {
        const width = Math.round((probe.width / probe.height) * height);
        return [
          `#EXT-X-STREAM-INF:BANDWIDTH=${(BITRATE_KBPS[height] ?? 800) * 1000},RESOLUTION=${width}x${height}`,
          `${height}p.m3u8`,
        ];
      }),
      "",
    ].join("\n");
    const hlsPlaylistKey = `${hlsDirKey}/master.m3u8`;
    await writeFile(store.localPath(hlsPlaylistKey), master);

    // Poster: a frame at min(1s, 10% in), as WebP ≤720 wide; the same image
    // doubles as the feed thumbnail at 320 wide.
    const posterSeek = Math.min(1, probe.durationMs / 10000).toFixed(2);
    const posterRawKey = `media/${mediaId}/poster-frame.jpg`;
    await execFileAsync("ffmpeg", [
      "-y",
      "-ss",
      posterSeek,
      "-i",
      sourcePath,
      "-frames:v",
      "1",
      store.localPath(posterRawKey),
    ]);
    const posterKey = `media/${mediaId}/poster.webp`;
    const posterOut = await sharp(store.localPath(posterRawKey))
      .resize({ width: Math.min(720, probe.width) })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    await store.put(posterKey, posterOut.data);
    const thumbKey = `media/${mediaId}/thumb.webp`;
    const thumbOut = await sharp(store.localPath(posterRawKey))
      .resize({ width: 320 })
      .webp({ quality: 75 })
      .toBuffer({ resolveWithObject: true });
    await store.put(thumbKey, thumbOut.data);
    await store.delete(posterRawKey);

    const captions = await this.transcriber.transcribe({
      mediaId,
      filePath: sourcePath,
      durationMs: probe.durationMs,
      write: async (lang, vtt) => {
        const key = `media/${mediaId}/captions/${lang}.vtt`;
        await store.put(key, Buffer.from(vtt, "utf8"));
        return key;
      },
    });

    return {
      width: probe.width,
      height: probe.height,
      durationMs: probe.durationMs,
      hlsPlaylistKey,
      poster: {
        key: posterKey,
        width: posterOut.info.width,
        height: posterOut.info.height,
        format: "webp",
      },
      thumbnailKey: thumbKey,
      captions,
    };
  }
}
