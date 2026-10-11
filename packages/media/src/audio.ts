/**
 * Audio pipeline (Phase 5A, D-046): voice notes and audio uploads get a
 * probe + metadata strip, NOT a rendition ladder. The stored original is
 * re-muxed with `ffmpeg -c copy -map_metadata -1` so embedded tags (which
 * can carry GPS / device strings in ID3v2) never reach the public file;
 * if the re-mux fails the original is kept and `exifStripped` stays false
 * (honest flag — the caller surfaces it on the media row).
 */
import { execFile } from "node:child_process";
import { rename, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import type { FileStore } from "./storage";

const execFileAsync = promisify(execFile);

export interface AudioProbe {
  durationMs: number;
  codec: string | null;
  hasAudio: boolean;
}

interface FfprobeAudioOutput {
  streams?: Array<{ codec_type?: string; codec_name?: string }>;
  format?: { duration?: string };
}

/** Probe a file expected to contain an audio stream (decode validation). */
export async function probeAudio(filePath: string): Promise<AudioProbe> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    filePath,
  ]);
  const parsed = JSON.parse(stdout) as FfprobeAudioOutput;
  const audioStream = parsed.streams?.find((s) => s.codec_type === "audio");
  if (!audioStream) {
    throw new Error("No audio stream found");
  }
  const durationSeconds = Number.parseFloat(parsed.format?.duration ?? "0");
  return {
    durationMs: Math.round(durationSeconds * 1000),
    codec: audioStream.codec_name ?? null,
    hasAudio: true,
  };
}

export interface AudioProcessResult {
  durationMs: number;
  codec: string | null;
  exifStripped: boolean;
}

/**
 * Probe + strip metadata in place. The storage key does not change (the
 * re-muxed file replaces the original bytes under the same key via a
 * temp file + rename on the same filesystem).
 */
export async function processAudio(
  store: FileStore,
  storageKey: string,
): Promise<AudioProcessResult> {
  const filePath = store.localPath(storageKey);
  const probe = await probeAudio(filePath);
  let exifStripped = false;
  const tmpPath = `${filePath}.stripped`;
  try {
    await execFileAsync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-i",
      filePath,
      "-map",
      "0:a:0",
      "-c",
      "copy",
      "-map_metadata",
      "-1",
      tmpPath,
    ]);
    await rename(tmpPath, filePath);
    exifStripped = true;
  } catch {
    // Re-mux failed (exotic codec/container): keep the original bytes and
    // report the honest flag rather than failing the upload.
    await unlink(tmpPath).catch(() => undefined);
  }
  return { durationMs: probe.durationMs, codec: probe.codec, exifStripped };
}
