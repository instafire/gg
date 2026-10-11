"use client";

import type { MediaView } from "@gg/sdk";
import { decode } from "blurhash";
import { useMemo, useState } from "react";

/** Decode a BlurHash to a tiny data-URL placeholder (cached per hash). */
const placeholderCache = new Map<string, string>();
export function blurhashDataUrl(hash: string | null): string | null {
  if (!hash) return null;
  const cached = placeholderCache.get(hash);
  if (cached) return cached;
  try {
    const pixels = decode(hash, 32, 32);
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const imageData = context.createImageData(32, 32);
    imageData.data.set(pixels);
    context.putImageData(imageData, 0, 0);
    const url = canvas.toDataURL();
    placeholderCache.set(hash, url);
    return url;
  } catch {
    return null;
  }
}

const SIZE_ORDER = ["thumb", "small", "medium", "large"] as const;

/**
 * Responsive image from a MediaView: AVIF <source> when the pipeline
 * produced AVIF twins, WebP srcset across the rendition ladder, and a
 * BlurHash placeholder that fades out as the real image loads.
 */
export function MediaImage({
  media,
  className,
  sizes = "(max-width: 640px) 100vw, 640px",
  eager = false,
}: {
  media: MediaView;
  className?: string;
  sizes?: string;
  eager?: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  const placeholder = useMemo(() => blurhashDataUrl(media.blurhash), [media.blurhash]);
  const variants = media.variants ?? {};
  const srcSetFor = (suffix: string) =>
    SIZE_ORDER.filter((name) => variants[`${name}${suffix}`])
      .map((name) => {
        const variant = variants[`${name}${suffix}`]!;
        return `${variant.url} ${variant.width ?? ""}w`;
      })
      .join(", ");
  const webpSrcSet = srcSetFor("");
  const avifSrcSet = srcSetFor("_avif");
  const fallbackSrc =
    variants["medium"]?.url ?? variants["small"]?.url ?? media.url ?? undefined;
  const aspect =
    media.width && media.height ? `${media.width} / ${media.height}` : undefined;

  return (
    <div
      className={`relative overflow-hidden bg-surface-sunken ${className ?? ""}`}
      style={aspect ? { aspectRatio: aspect } : undefined}
    >
      {placeholder ? (
        <img
          src={placeholder}
          alt=""
          aria-hidden="true"
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${
            loaded ? "opacity-0" : "opacity-100"
          }`}
        />
      ) : null}
      <picture>
        {avifSrcSet ? <source srcSet={avifSrcSet} sizes={sizes} type="image/avif" /> : null}
        <img
          src={fallbackSrc}
          srcSet={webpSrcSet || undefined}
          sizes={sizes}
          alt={media.altText ?? ""}
          width={media.width ?? undefined}
          height={media.height ?? undefined}
          loading={eager ? "eager" : "lazy"}
          onLoad={() => setLoaded(true)}
          className={`h-full w-full object-cover transition-opacity duration-300 ${
            loaded ? "opacity-100" : "opacity-0"
          }`}
          data-testid="post-media-image"
        />
      </picture>
    </div>
  );
}
