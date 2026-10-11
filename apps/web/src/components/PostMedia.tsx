"use client";

import type { MediaView, PostView } from "@gg/sdk";
import { Play } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { MediaImage } from "./MediaImage";
import { MediaVideo } from "./MediaVideo";

/** Carousel: horizontal scroll-snap track with position dots. */
function MediaCarousel({ items }: { items: MediaView[] }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  return (
    <div className="relative" data-testid="post-media-carousel">
      <div
        ref={trackRef}
        className="flex snap-x snap-mandatory overflow-x-auto scroll-smooth rounded-md"
        onScroll={(event) => {
          const el = event.currentTarget;
          const next = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
          setIndex(Math.min(items.length - 1, Math.max(0, next)));
        }}
      >
        {items.map((item) => (
          <div key={item.id} className="w-full shrink-0 snap-center">
            <MediaImage media={item} className="rounded-md border border-border" />
          </div>
        ))}
      </div>
      <span
        className="absolute top-2 right-2 rounded-full bg-black/60 px-2 py-0.5 font-mono text-xs text-white tabular-nums"
        aria-live="polite"
      >
        {index + 1}/{items.length}
      </span>
      <div className="mt-2 flex justify-center gap-1.5" aria-hidden="true">
        {items.map((item, i) => (
          <span
            key={item.id}
            className={`h-1.5 w-1.5 rounded-full ${i === index ? "bg-accent" : "bg-border-strong"}`}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Post media rendering (Phase 2): images with srcset + BlurHash, carousels,
 * inline HLS video for VIDEO posts, and a reel card that deep-links into
 * the /reels player for REEL posts.
 */
export function PostMedia({ post }: { post: PostView }) {
  const media = post.media.filter((item) => item.status === "ready");
  if (media.length === 0) return null;
  const first = media[0]!;

  if (first.kind === "video") {
    if (post.type === "REEL") {
      return (
        <div className="relative mt-3 overflow-hidden rounded-md border border-border" data-testid="post-media-reel">
          <MediaVideo media={first} muted preload="metadata" className="max-h-[480px]" />
          <Link
            href={`/reels?at=${post.id}`}
            className="absolute right-2 bottom-2 inline-flex min-h-9 items-center gap-1.5 rounded-full bg-black/70 px-3 text-sm font-medium text-white transition-colors hover:bg-black/85"
          >
            <Play size={14} aria-hidden="true" />
            Watch in Reels
          </Link>
        </div>
      );
    }
    return (
      <div className="mt-3 overflow-hidden rounded-md border border-border">
        <MediaVideo media={first} muted={false} />
      </div>
    );
  }

  if (media.length > 1) {
    return (
      <div className="mt-3">
        <MediaCarousel items={media} />
      </div>
    );
  }
  return (
    <div className="mt-3">
      <MediaImage media={first} className="rounded-md border border-border" />
    </div>
  );
}
