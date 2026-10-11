/**
 * Magic-byte content sniffing. The declared MIME type / filename extension
 * is never trusted (ARCHITECTURE §6: validated at session creation and again
 * on completion) — this module decides what a byte stream actually is.
 */

export interface SniffedType {
  kind: "image" | "video" | "gif" | "audio";
  mime: string;
  ext: string;
}

const IMAGE_MIMES: Record<string, { kind: SniffedType["kind"]; ext: string }> = {
  "image/jpeg": { kind: "image", ext: "jpg" },
  "image/png": { kind: "image", ext: "png" },
  "image/webp": { kind: "image", ext: "webp" },
  "image/avif": { kind: "image", ext: "avif" },
  "image/gif": { kind: "gif", ext: "gif" },
  "video/mp4": { kind: "video", ext: "mp4" },
  "video/webm": { kind: "video", ext: "webm" },
  "video/quicktime": { kind: "video", ext: "mov" },
};

/** Map a declared MIME type to its media kind + file extension (null = unsupported). */
export function mimeToKind(
  mime: string,
): { kind: SniffedType["kind"] | "audio"; ext: string } | null {
  const known = IMAGE_MIMES[mime];
  if (known) return known;
  switch (mime) {
    case "audio/mpeg":
      return { kind: "audio", ext: "mp3" };
    case "audio/mp4":
      return { kind: "audio", ext: "m4a" };
    case "audio/ogg":
      return { kind: "audio", ext: "ogg" };
    case "audio/wav":
    case "audio/x-wav":
    case "audio/wave":
      return { kind: "audio", ext: "wav" };
    case "audio/webm":
      return { kind: "audio", ext: "webm" };
    default:
      return null;
  }
}

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

function ascii(buf: Buffer, start: number, length: number): string {
  return buf.subarray(start, start + length).toString("ascii");
}

/** Identify a buffer by its magic bytes; null when unrecognized. */
export function sniffBuffer(buf: Buffer): SniffedType | null {
  if (startsWith(buf, [0xff, 0xd8, 0xff])) {
    return { kind: "image", mime: "image/jpeg", ext: "jpg" };
  }
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: "image", mime: "image/png", ext: "png" };
  }
  if (ascii(buf, 0, 4) === "GIF8") {
    return { kind: "gif", mime: "image/gif", ext: "gif" };
  }
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WEBP") {
    return { kind: "image", mime: "image/webp", ext: "webp" };
  }
  // Audio signatures (Phase 5A): MP3 (ID3v2 tag or MPEG frame sync), WAV
  // (RIFF/WAVE), Ogg container (voice notes from MediaRecorder/Firefox).
  if (ascii(buf, 0, 3) === "ID3" || (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0)) {
    return { kind: "audio", mime: "audio/mpeg", ext: "mp3" };
  }
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WAVE") {
    return { kind: "audio", mime: "audio/wav", ext: "wav" };
  }
  if (ascii(buf, 0, 4) === "OggS") {
    return { kind: "audio", mime: "audio/ogg", ext: "ogg" };
  }
  // ISO-BMFF: bytes 4..8 are "ftyp"; the major brand decides image vs video.
  if (ascii(buf, 4, 4) === "ftyp") {
    const brand = ascii(buf, 8, 4);
    if (brand === "avif" || brand === "avis" || brand === "mif1" || brand === "msf1") {
      return { kind: "image", mime: "image/avif", ext: "avif" };
    }
    if (brand === "M4A " || brand === "M4B " || brand === "M4P ") {
      return { kind: "audio", mime: "audio/mp4", ext: "m4a" };
    }
    if (brand === "qt  ") {
      return { kind: "video", mime: "video/quicktime", ext: "mov" };
    }
    return { kind: "video", mime: "video/mp4", ext: "mp4" };
  }
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { kind: "video", mime: "video/webm", ext: "webm" };
  }
  return null;
}

/**
 * True when the bytes are an executable / script signature — the canonical
 * "blocked test file" (an .exe renamed to .png) must never pass the gate.
 */
export function hasExecutableSignature(buf: Buffer): boolean {
  if (startsWith(buf, [0x4d, 0x5a])) return true; // MZ (DOS/PE)
  if (startsWith(buf, [0x7f, 0x45, 0x4c, 0x46])) return true; // ELF
  if (startsWith(buf, [0x23, 0x21])) return true; // #! shebang
  if (
    startsWith(buf, [0xfe, 0xed, 0xfa, 0xce]) || // Mach-O 32
    startsWith(buf, [0xfe, 0xed, 0xfa, 0xcf]) || // Mach-O 64
    startsWith(buf, [0xce, 0xfa, 0xed, 0xfe]) ||
    startsWith(buf, [0xcf, 0xfa, 0xed, 0xfe])
  ) {
    return true;
  }
  return false;
}

/** Declared-vs-sniffed equivalence (MP4 family brands count as one family). */
export function mimeMatches(declared: string, sniffed: SniffedType): boolean {
  if (declared === sniffed.mime) return true;
  const mp4Family = new Set(["video/mp4", "video/quicktime"]);
  if (mp4Family.has(declared) && mp4Family.has(sniffed.mime)) return true;
  // WAV spellings are one family.
  const wavFamily = new Set(["audio/wav", "audio/x-wav", "audio/wave"]);
  if (wavFamily.has(declared) && wavFamily.has(sniffed.mime)) return true;
  // WebM audio and video share the EBML header, so bytes alone cannot tell
  // audio/webm from video/webm — the audio pipeline's ffprobe step verifies
  // an audio stream actually exists before the file can become ready.
  if (declared === "audio/webm" && sniffed.mime === "video/webm") return true;
  return false;
}
