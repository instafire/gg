/**
 * Image pipeline (ARCHITECTURE §6 step 3): sharp renditions in WebP + AVIF,
 * blurhash placeholder, and EXIF/GPS stripping. Stripping happens by
 * re-encoding: every output (including the stored "original") is produced
 * by sharp without metadata passthrough, and the cleaned bytes replace the
 * uploaded original BEFORE the media row can flip to `ready` — so no
 * rendition or original carrying GPS data is ever publicly served.
 */
import { encode as encodeBlurhash } from "blurhash";
import sharp from "sharp";
import type { FileStore } from "./storage";

export interface Rendition {
  key: string;
  width: number;
  height: number;
  format: string;
}

export interface ImageProcessResult {
  width: number;
  height: number;
  blurhash: string;
  /** Flat rendition map: name -> rendition (`<name>_avif` for the AVIF twin). */
  sizes: Record<string, Rendition>;
  exifStripped: true;
}

/** size name -> target width (height follows the source aspect ratio). */
export const IMAGE_SIZES: Record<string, number> = {
  thumb: 320,
  small: 640,
  medium: 1280,
  large: 2048,
};

const OUTPUT_FORMATS = ["webp", "avif"] as const;

export async function processImage(
  store: FileStore,
  mediaId: string,
  sourceKey: string,
  sourceFormat: string,
): Promise<ImageProcessResult> {
  const sourcePath = store.localPath(sourceKey);
  const animated = sourceFormat === "gif";
  const base = sharp(sourcePath, { animated }).rotate(); // auto-orient, then strip
  const metadata = await base.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height) throw new Error("Image has no dimensions");

  // 1. Cleaned original replaces the uploaded bytes in place.
  const cleaned = await sharp(sourcePath, { animated }).rotate().toBuffer();
  await store.put(sourceKey, cleaned);

  // 2. Renditions (never upscale; a size wider than the source is skipped,
  //    except `thumb`, which falls back to the source width so every image
  //    has at least one small rendition).
  const sizes: Record<string, Rendition> = {};
  for (const [name, targetWidth] of Object.entries(IMAGE_SIZES)) {
    const renditionWidth = Math.min(targetWidth, width);
    if (renditionWidth < targetWidth && name !== "thumb") continue;
    for (const format of OUTPUT_FORMATS) {
      const key = `media/${mediaId}/${name}.${format}`;
      const out = await sharp(sourcePath, { animated })
        .rotate()
        .resize({ width: renditionWidth })
        .toFormat(format, format === "webp" ? { quality: 82 } : { quality: 62 })
        .toBuffer({ resolveWithObject: true });
      await store.put(key, out.data);
      const entry: Rendition = {
        key,
        width: out.info.width,
        height: out.info.height,
        format,
      };
      if (format === "webp") sizes[name] = entry;
      else sizes[`${name}_avif`] = entry;
    }
  }

  // 3. Blurhash from a 32px-wide raw downscale (blurhash encodes RGBA).
  const { data, info } = await sharp(sourcePath)
    .rotate()
    .resize({ width: 32 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const blurhash = encodeBlurhash(
    new Uint8ClampedArray(data),
    info.width,
    info.height,
    4,
    3,
  );

  return { width, height, blurhash, sizes, exifStripped: true };
}
