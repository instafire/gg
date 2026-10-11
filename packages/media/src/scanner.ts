/**
 * Moderation gate (ARCHITECTURE §6 step 2, PLAN Phase 2: "every upload
 * passes type/size validation, malware scanning, and NSFW/gore
 * classification before publication").
 *
 * The local implementation performs the structural checks that are real:
 * magic-byte identification, declared-type match, executable-signature
 * rejection, and full decode validation (sharp metadata for images,
 * ffprobe for video). A file that fails any check is rejected and never
 * becomes publicly reachable.
 *
 * NSFW/gore classification is an ADAPTER STUB: no local classifier model
 * is bundled, so the stub records `nsfw: null, gore: null` with
 * `classifier: "stub-passthrough-v1"` and does not influence the verdict.
 * It does NOT fake a score. A real classifier (or hosted moderation API)
 * implements MediaScanner later (DECISIONS D-027).
 */
import { open } from "node:fs/promises";
import sharp from "sharp";
import {
  hasExecutableSignature,
  mimeMatches,
  sniffBuffer,
  type SniffedType,
} from "./sniff";
import { probeAudio } from "./audio";
import { probeVideo } from "./video";

export interface ScanResult {
  verdict: "clean" | "review" | "rejected";
  /** Stored verbatim on media.content_labels. */
  labels: Record<string, unknown>;
  sniffed: SniffedType | null;
  /** Machine-readable rejection reason when verdict = rejected. */
  reason?: string;
}

export interface MediaScanner {
  scan(input: {
    path: string;
    declaredMime: string;
  }): Promise<ScanResult>;
}

async function readHead(path: string, bytes = 65536): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export class LocalScanner implements MediaScanner {
  async scan(input: { path: string; declaredMime: string }): Promise<ScanResult> {
    const checks: string[] = [];
    const head = await readHead(input.path);

    if (hasExecutableSignature(head)) {
      return {
        verdict: "rejected",
        labels: { checks, classifier: "stub-passthrough-v1", nsfw: null, gore: null },
        sniffed: null,
        reason: "executable-signature",
      };
    }
    checks.push("executable-signature:pass");

    const sniffed = sniffBuffer(head);
    if (!sniffed) {
      return {
        verdict: "rejected",
        labels: { checks, classifier: "stub-passthrough-v1", nsfw: null, gore: null },
        sniffed: null,
        reason: "unrecognized-format",
      };
    }
    checks.push("magic-bytes:pass");

    if (!mimeMatches(input.declaredMime, sniffed)) {
      return {
        verdict: "rejected",
        labels: { checks, classifier: "stub-passthrough-v1", nsfw: null, gore: null },
        sniffed,
        reason: "mime-mismatch",
      };
    }
    checks.push("mime-match:pass");

    // Full decode validation: catches truncated/corrupt payloads whose
    // headers sniff correctly.
    try {
      if (sniffed.kind === "video") {
        // WebM bytes may actually be audio-only (voice notes): when the
        // declared type is audio/webm, an audio probe is the decode check.
        if (input.declaredMime === "audio/webm") await probeAudio(input.path);
        else await probeVideo(input.path);
      } else if (sniffed.kind === "audio") {
        await probeAudio(input.path);
      } else {
        await sharp(input.path, { animated: sniffed.kind === "gif" }).metadata();
      }
    } catch {
      return {
        verdict: "rejected",
        labels: { checks, classifier: "stub-passthrough-v1", nsfw: null, gore: null },
        sniffed,
        reason: "decode-failed",
      };
    }
    checks.push("decode:pass");

    return {
      verdict: "clean",
      labels: {
        checks,
        // NSFW/gore: stub adapter — no classifier is bundled (D-027).
        classifier: "stub-passthrough-v1",
        nsfw: null,
        gore: null,
      },
      sniffed,
    };
  }
}
