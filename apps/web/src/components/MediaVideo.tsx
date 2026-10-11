"use client";

import type { MediaView } from "@gg/sdk";
import Hls from "hls.js";
import { useEffect, useRef } from "react";

/**
 * HLS video player: hls.js where MSE is available, native HLS on Safari.
 * Poster comes from the pipeline thumbnail; caption tracks (WebVTT
 * sidecars) render as <track> elements when the media carries any.
 */
export function MediaVideo({
  media,
  autoPlay = false,
  muted = false,
  loop = false,
  controls = true,
  preload = "metadata",
  className,
  videoRef,
  onEnded,
}: {
  media: MediaView;
  autoPlay?: boolean;
  muted?: boolean;
  loop?: boolean;
  controls?: boolean;
  preload?: "none" | "metadata" | "auto";
  className?: string;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  onEnded?: () => void;
}) {
  const innerRef = useRef<HTMLVideoElement>(null);
  const ref = videoRef ?? innerRef;
  const hlsUrl = media.hlsUrl;

  useEffect(() => {
    const video = ref.current;
    if (!video || !hlsUrl) return;
    let hls: Hls | null = null;
    if (Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 30 });
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = hlsUrl;
    }
    return () => {
      hls?.destroy();
    };
  }, [hlsUrl, ref]);

  const poster =
    media.thumbnailUrl ?? media.variants?.["poster"]?.url ?? undefined;
  const aspect =
    media.width && media.height ? `${media.width} / ${media.height}` : undefined;

  return (
    <video
      ref={ref}
      poster={poster}
      controls={controls}
      muted={muted}
      playsInline
      autoPlay={autoPlay}
      loop={loop}
      preload={preload}
      onEnded={onEnded}
      aria-label={media.altText ?? "Video"}
      data-testid="post-media-video"
      className={`w-full bg-black ${className ?? ""}`}
      style={aspect && !className?.includes("h-full") ? { aspectRatio: aspect } : undefined}
    >
      {media.captions.map((track) => (
        <track
          key={track.lang}
          kind="captions"
          src={track.url}
          srcLang={track.lang}
          label={track.label || track.lang}
        />
      ))}
    </video>
  );
}
