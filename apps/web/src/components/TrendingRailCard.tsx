"use client";

import type { TrendingView } from "@gg/sdk";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../lib/api";

/**
 * Trending rail card (Phase 5A, D-052): the worker's latest snapshot —
 * hashtag velocity over the trailing 6 hours, plus the fastest-rising
 * communities and debates. Labeled with the window so the number's
 * meaning is never ambiguous.
 */
export function TrendingRailCard() {
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

  const empty =
    !trending ||
    (trending.hashtags.length === 0 &&
      trending.communities.length === 0 &&
      trending.debates.length === 0);

  return (
    <section
      className="rounded-lg border border-border bg-surface p-4"
      data-testid="trending-rail"
      aria-label="Trending"
    >
      <h2 className="font-display text-base font-semibold">Trending</h2>
      <p className="mt-0.5 text-xs text-text-muted">
        Velocity in the last 6h — posts, votes and replies right now.
      </p>
      {empty ? (
        <p className="mt-2 text-sm text-text-muted">
          Nothing is moving fast yet. The next snapshot lands within 10 minutes.
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {trending.hashtags.length > 0 ? (
            <ul className="flex flex-col gap-1.5" data-testid="trending-hashtags">
              {trending.hashtags.slice(0, 5).map((tag) => (
                <li key={tag.tag}>
                  <Link
                    href={`/search?q=${encodeURIComponent(`#${tag.tag}`)}`}
                    className="font-medium hover:underline"
                  >
                    #{tag.tag}
                  </Link>{" "}
                  <span className="text-xs text-text-muted">
                    {tag.postCount} post{tag.postCount === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {trending.communities.length > 0 ? (
            <div>
              <h3 className="text-xs font-semibold tracking-wide text-text-muted uppercase">
                Communities rising
              </h3>
              <ul className="mt-1 flex flex-col gap-1">
                {trending.communities.slice(0, 3).map((community) => (
                  <li key={community.id}>
                    <Link href={`/c/${community.slug}`} className="text-sm hover:underline">
                      g/{community.slug}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {trending.debates.length > 0 ? (
            <div>
              <h3 className="text-xs font-semibold tracking-wide text-text-muted uppercase">
                Debates heating up
              </h3>
              <ul className="mt-1 flex flex-col gap-1">
                {trending.debates.slice(0, 3).map((debate) => (
                  <li key={debate.id}>
                    <Link
                      href={`/debates/${debate.id}`}
                      className="line-clamp-2 text-sm hover:underline"
                    >
                      {debate.proposition}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
