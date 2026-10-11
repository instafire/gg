"use client";

import type { PostView } from "@gg/sdk";
import { useCallback, useRef, useState } from "react";
import { FeedList, type FeedListHandle } from "../../../components/FeedList";
import { PostComposer } from "../../../components/PostComposer";
import { StoriesRail } from "../../../components/Stories";
import { api } from "../../../lib/api";
import { useLocale } from "../../../lib/i18n";
import { RequireAuth } from "../../../lib/session";

type HomeTab = "for_you" | "following";

export default function HomePage() {
  return (
    <RequireAuth>
      <HomeFeed />
    </RequireAuth>
  );
}

function HomeFeed() {
  const { t } = useLocale();
  const [tab, setTab] = useState<HomeTab>("for_you");
  const feedRef = useRef<FeedListHandle>(null);

  const fetchPage = useCallback(
    (cursor: string | undefined) => api.getFeed({ tab, cursor, limit: 20 }),
    [tab],
  );

  const onPosted = useCallback((post: PostView) => {
    feedRef.current?.prepend(post);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="sr-only">{t.home.title}</h1>
      <div role="tablist" aria-label={t.home.feedLabel} className="flex gap-2">
        {(
          [
            { value: "for_you", label: t.home.forYou },
            { value: "following", label: t.home.following },
          ] as const
        ).map((option) => (
          <button
            key={option.value}
            role="tab"
            aria-selected={tab === option.value}
            data-testid={`feed-tab-${option.value}`}
            onClick={() => setTab(option.value)}
            className={`min-h-11 rounded-full px-4 font-medium transition-colors ${
              tab === option.value
                ? "bg-accent text-accent-ink"
                : "bg-surface-sunken text-text-soft hover:text-text"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <PostComposer onPosted={onPosted} />
      <StoriesRail />
      <FeedList
        ref={feedRef}
        fetchPage={fetchPage}
        resetKey={tab}
        emptyTitle="Nothing here yet"
        emptyBody={
          tab === "following"
            ? "Posts from people you follow will show up here."
            : "Be the first take."
        }
      />
    </div>
  );
}
