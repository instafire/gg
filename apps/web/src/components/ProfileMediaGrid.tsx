"use client";

import type { PostView } from "@gg/sdk";
import { Button } from "@gg/ui";
import { Play } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { EmptyState, FeedSkeleton } from "./States";

/**
 * Profile media grid (Phase 2): the profile "Media" tab as a thumbnail
 * grid over the user's media posts (tab=media on the posts route). Video
 * cells show the poster with a play glyph; every cell links to the post.
 */
export function ProfileMediaGrid({ handle }: { handle: string }) {
  const [posts, setPosts] = useState<PostView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (nextCursor?: string) => {
      const page = await api.listUserPosts(handle, {
        tab: "media",
        cursor: nextCursor,
        limit: 30,
      });
      setPosts((current) => {
        const seen = new Set(current.map((p) => p.id));
        return [...current, ...page.items.filter((p) => !seen.has(p.id))];
      });
      setCursor(page.nextCursor);
    },
    [handle],
  );

  useEffect(() => {
    let cancelled = false;
    setPosts([]);
    setLoading(true);
    load()
      .catch(() => {
        if (!cancelled) setError("Couldn't load media.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  if (loading) return <FeedSkeleton count={2} />;
  if (error) {
    return <EmptyState title="Media unavailable" body={error} testId="profile-media-error" />;
  }
  if (posts.length === 0) {
    return (
      <EmptyState
        title="No media yet"
        body={`@${handle} hasn't posted photos or videos yet.`}
        testId="profile-media-empty"
      />
    );
  }

  return (
    <div>
      <div className="grid grid-cols-3 gap-1" data-testid="profile-media-grid">
        {posts.flatMap((post) =>
          post.media
            .filter((item) => item.status === "ready")
            .map((item) => {
              const thumb =
                item.kind === "video"
                  ? (item.thumbnailUrl ?? item.variants?.["poster"]?.url)
                  : (item.variants?.["thumb"]?.url ?? item.url);
              return (
                <Link
                  key={`${post.id}-${item.id}`}
                  href={`/post/${post.id}`}
                  aria-label={item.altText ?? `Media in post by @${handle}`}
                  className="relative block aspect-square overflow-hidden bg-surface-sunken"
                >
                  {thumb ? (
                    <img
                      src={thumb}
                      alt={item.altText ?? ""}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : null}
                  {item.kind === "video" ? (
                    <span className="absolute right-1.5 bottom-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white">
                      <Play size={14} aria-hidden="true" />
                    </span>
                  ) : null}
                  {post.type === "CAROUSEL" ? (
                    <span className="absolute top-1.5 right-1.5 rounded-full bg-black/60 px-1.5 py-0.5 text-[0.625rem] font-semibold text-white">
                      {post.media.length}
                    </span>
                  ) : null}
                </Link>
              );
            }),
        )}
      </div>
      {cursor ? (
        <div className="mt-4 text-center">
          <Button
            variant="ghost"
            disabled={loadingMore}
            onClick={() => {
              setLoadingMore(true);
              void load(cursor)
                .catch(() => undefined)
                .finally(() => setLoadingMore(false));
            }}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
