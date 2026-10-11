"use client";

import type { PostView } from "@gg/sdk";
import { Heart, MessageCircle } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "../../../components/Avatar";
import { MediaVideo } from "../../../components/MediaVideo";
import { EmptyState, FeedSkeleton } from "../../../components/States";
import { api } from "../../../lib/api";
import { formatCount } from "../../../lib/format";
import { useSession } from "../../../lib/session";

/**
 * Reels player (Phase 2): full-screen vertical snap-scroll feed. The
 * visible reel autoplays muted; neighbours preload metadata. Like toggles
 * a reaction; comments jump to the thread. `?at=<postId>` deep-links a
 * reel to the front when it is in the first pages.
 */
export default function ReelsPage() {
  const [reels, setReels] = useState<PostView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (nextCursor?: string) => {
    const page = await api.getReels({ cursor: nextCursor, limit: 10 });
    setReels((current) => {
      const seen = new Set(current.map((r) => r.id));
      return [...current, ...page.items.filter((r) => !seen.has(r.id))];
    });
    setCursor(page.nextCursor);
    return page;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const page = await load();
        if (cancelled) return;
        const at = new URLSearchParams(window.location.search).get("at");
        if (at && !page.items.some((r) => r.id === at)) {
          // One extra page of headroom for deep links from feed cards.
          await load(page.nextCursor ?? undefined);
        }
        if (at) {
          requestAnimationFrame(() => {
            document
              .querySelector(`[data-reel-id="${at}"]`)
              ?.scrollIntoView({ block: "start" });
          });
        }
      } catch {
        if (!cancelled) setError("Couldn't load reels.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  // Autoplay the reel that is mostly on screen; pause the rest.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const videos = container.querySelectorAll<HTMLVideoElement>("video");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const video = entry.target as HTMLVideoElement;
          const slide = video.closest<HTMLElement>("[data-reel-id]");
          if (entry.intersectionRatio >= 0.6) {
            setActiveId(slide?.dataset.reelId ?? null);
            void video.play().catch(() => undefined);
          } else {
            video.pause();
          }
        }
      },
      { root: container, threshold: [0, 0.6, 1] },
    );
    videos.forEach((video) => observer.observe(video));
    return () => observer.disconnect();
  }, [reels]);

  // Page in more reels as the user nears the end.
  useEffect(() => {
    if (!activeId || !cursor) return;
    const index = reels.findIndex((r) => r.id === activeId);
    if (index >= reels.length - 3) {
      void load(cursor).catch(() => undefined);
    }
  }, [activeId, cursor, reels, load]);

  if (loading) return <FeedSkeleton count={1} />;
  if (error) {
    return <EmptyState title="Reels unavailable" body={error} testId="reels-error" />;
  }
  if (reels.length === 0) {
    return (
      <EmptyState
        title="No reels yet"
        body="Post a short video as a Reel and it will play here."
        testId="reels-empty"
      />
    );
  }

  return (
    <div
      ref={containerRef}
      data-testid="reels-feed"
      className="h-[calc(100dvh-8rem)] snap-y snap-mandatory overflow-y-auto rounded-lg bg-black"
    >
      {reels.map((reel, index) => (
        <ReelSlide
          key={reel.id}
          reel={reel}
          active={reel.id === activeId}
          eager={index < 2}
        />
      ))}
    </div>
  );
}

function ReelSlide({
  reel,
  active,
  eager,
}: {
  reel: PostView;
  active: boolean;
  eager: boolean;
}) {
  const { requireAuth } = useSession();
  const [liked, setLiked] = useState(reel.viewerReactions.includes("like"));
  const [likeCount, setLikeCount] = useState(reel.reactionCounts["like"] ?? 0);
  const media = reel.media[0];

  async function toggleLike() {
    if (!requireAuth()) return;
    const previous = liked;
    setLiked(!previous);
    setLikeCount((count) => count + (previous ? -1 : 1));
    try {
      if (previous) await api.removeReaction(reel.id, "like");
      else await api.reactToPost(reel.id, "like");
    } catch {
      setLiked(previous);
      setLikeCount((count) => count + (previous ? 1 : -1));
    }
  }

  return (
    <section
      data-reel-id={reel.id}
      data-testid="reel-slide"
      aria-label={`Reel by ${reel.author.displayName}`}
      className="relative flex h-full snap-start snap-always items-center justify-center"
    >
      {media ? (
        <MediaVideo
          media={media}
          muted
          loop
          controls={false}
          preload={active || eager ? "auto" : "metadata"}
          className="h-full max-h-full w-auto max-w-full object-contain"
        />
      ) : null}
      <div className="pointer-events-none absolute right-3 bottom-24 flex flex-col items-center gap-4">
        <button
          type="button"
          onClick={() => void toggleLike()}
          aria-label={liked ? "Unlike reel" : "Like reel"}
          aria-pressed={liked}
          data-testid="reel-like-button"
          className={`pointer-events-auto flex h-12 w-12 flex-col items-center justify-center rounded-full bg-black/50 text-white transition-colors ${
            liked ? "text-danger" : ""
          }`}
        >
          <Heart size={22} aria-hidden="true" fill={liked ? "currentColor" : "none"} />
        </button>
        <span className="-mt-2 text-xs font-medium text-white tabular-nums">
          {formatCount(likeCount)}
        </span>
        <Link
          href={`/post/${reel.id}`}
          aria-label={`Open comments, ${reel.replyCount} replies`}
          data-testid="reel-comments-link"
          className="pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full bg-black/50 text-white"
        >
          <MessageCircle size={22} aria-hidden="true" />
        </Link>
        <span className="-mt-2 text-xs font-medium text-white tabular-nums">
          {formatCount(reel.replyCount)}
        </span>
      </div>
      <div className="absolute bottom-4 left-4 max-w-[70%] text-white">
        <Link href={`/u/${reel.author.handle}`} className="flex items-center gap-2">
          <Avatar name={reel.author.displayName} avatarUrl={reel.author.avatarUrl} size={32} />
          <span className="font-medium">@{reel.author.handle}</span>
        </Link>
        {reel.body ? (
          <p className="mt-2 line-clamp-2 text-sm whitespace-pre-wrap">{reel.body}</p>
        ) : null}
      </div>
    </section>
  );
}
