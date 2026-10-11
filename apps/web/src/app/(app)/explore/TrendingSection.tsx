"use client";

import type { TrendingView } from "@gg/sdk";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PostCard } from "../../../components/PostCard";
import { api } from "../../../lib/api";

/**
 * Explore trending section (Phase 5A, D-052): the worker snapshot —
 * hashtags, trending posts, rising communities and debates, all from
 * velocity in the last 6h.
 */
export function TrendingSection() {
  const [trending, setTrending] = useState<TrendingView | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getTrending()
      .then((result) => {
        if (!cancelled) setTrending(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!trending) return null;
  const empty =
    trending.hashtags.length === 0 &&
    trending.posts.length === 0 &&
    trending.communities.length === 0 &&
    trending.debates.length === 0;
  if (empty) return null;

  return (
    <section
      className="flex flex-col gap-3"
      data-testid="explore-trending"
      aria-label="Trending"
    >
      <div>
        <h2 className="font-display text-xl font-bold">Trending</h2>
        <p className="text-sm text-text-muted">
          Velocity in the last 6h — what's gathering posts, votes and replies right now.
        </p>
      </div>
      {trending.hashtags.length > 0 ? (
        <ul className="flex flex-wrap gap-2" data-testid="explore-trending-tags">
          {trending.hashtags.map((tag) => (
            <li key={tag.tag}>
              <Link
                href={`/search?q=${encodeURIComponent(`#${tag.tag}`)}`}
                className="rounded-full bg-surface-sunken px-3 py-1.5 text-sm font-medium hover:underline"
              >
                #{tag.tag}{" "}
                <span className="text-text-muted">
                  · {tag.postCount} post{tag.postCount === 1 ? "" : "s"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {trending.posts.length > 0 ? (
        <ol className="flex flex-col gap-3" data-testid="explore-trending-posts">
          {trending.posts.slice(0, 5).map((post) => (
            <li key={post.id}>
              <PostCard post={post} />
            </li>
          ))}
        </ol>
      ) : null}
      {trending.communities.length > 0 ? (
        <p className="text-sm" data-testid="explore-trending-communities">
          <span className="font-semibold">Communities rising:</span>{" "}
          {trending.communities.map((community, index) => (
            <span key={community.id}>
              {index > 0 ? ", " : ""}
              <Link href={`/c/${community.slug}`} className="hover:underline">
                g/{community.slug}
              </Link>
            </span>
          ))}
        </p>
      ) : null}
      {trending.debates.length > 0 ? (
        <div data-testid="explore-trending-debates">
          <h3 className="text-sm font-semibold">Debates heating up</h3>
          <ul className="mt-1 flex flex-col gap-1">
            {trending.debates.slice(0, 3).map((debate) => (
              <li key={debate.id}>
                <Link href={`/debates/${debate.id}`} className="text-sm hover:underline">
                  {debate.proposition}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
