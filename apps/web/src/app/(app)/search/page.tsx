"use client";

import type {
  CommunityView,
  PostView,
  ProfileView,
  SearchResultsView,
  SearchType,
} from "@gg/sdk";
import { Button } from "@gg/ui";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { CommunityCard } from "../../../components/CommunityCard";
import { PostCard } from "../../../components/PostCard";
import { ApiErrorState, EmptyState, FeedSkeleton } from "../../../components/States";
import { UserRow } from "../../../components/UserRow";
import { api } from "../../../lib/api";

type TabId = "all" | "posts" | "people" | "communities";

const TABS: { id: TabId; label: string }[] = [
  { id: "all", label: "Top" },
  { id: "posts", label: "Posts" },
  { id: "people", label: "People" },
  { id: "communities", label: "Communities" },
];

export default function SearchPage() {
  return (
    <Suspense fallback={<FeedSkeleton count={3} />}>
      <SearchInner />
    </Suspense>
  );
}

function SearchInner() {
  const searchParams = useSearchParams();
  const q = (searchParams.get("q") ?? "").trim();
  const [tab, setTab] = useState<TabId>("all");
  const [results, setResults] = useState<SearchResultsView | null>(null);
  const [posts, setPosts] = useState<PostView[]>([]);
  const [people, setPeople] = useState<ProfileView[]>([]);
  const [communities, setCommunities] = useState<CommunityView[]>([]);
  const [postsCursor, setPostsCursor] = useState<string | null>(null);
  const [peopleCursor, setPeopleCursor] = useState<string | null>(null);
  const [communitiesCursor, setCommunitiesCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /** Phase 5B: semantic (vector) blending — off = keyword only. */
  const [semantic, setSemantic] = useState(false);

  const runSearch = useCallback(
    async (type: SearchType) => {
      if (!q) return;
      setLoading(true);
      setError(null);
      try {
        const page = await api.search({ q, type, limit: 20, semantic });
        setResults(page);
        setPosts(page.posts.items);
        setPostsCursor(page.posts.nextCursor);
        setPeople(page.people.items);
        setPeopleCursor(page.people.nextCursor);
        setCommunities(page.communities.items);
        setCommunitiesCursor(page.communities.nextCursor);
      } catch (cause) {
        setError(cause);
        setResults(null);
      } finally {
        setLoading(false);
      }
    },
    [q, semantic],
  );

  useEffect(() => {
    setTab("all");
    void runSearch("all");
  }, [runSearch]);

  async function switchTab(next: TabId) {
    setTab(next);
    if (next !== "all") await runSearch(next);
    else await runSearch("all");
  }

  async function loadMorePosts() {
    if (!postsCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.search({ q, type: "posts", cursor: postsCursor, limit: 20 });
      setPosts((current) => [...current, ...page.posts.items]);
      setPostsCursor(page.posts.nextCursor);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoadingMore(false);
    }
  }

  async function loadMorePeople() {
    if (!peopleCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.search({ q, type: "people", cursor: peopleCursor, limit: 20 });
      setPeople((current) => [...current, ...page.people.items]);
      setPeopleCursor(page.people.nextCursor);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoadingMore(false);
    }
  }

  async function loadMoreCommunities() {
    if (!communitiesCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.search({
        q,
        type: "communities",
        cursor: communitiesCursor,
        limit: 20,
      });
      setCommunities((current) => [...current, ...page.communities.items]);
      setCommunitiesCursor(page.communities.nextCursor);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoadingMore(false);
    }
  }

  if (!q) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-display text-2xl font-bold">Search</h1>
        <EmptyState
          title="Search GG"
          body="Use the search box up top to find posts, people and communities."
          testId="search-empty-query"
        />
      </div>
    );
  }

  const nothingFound =
    results !== null &&
    posts.length === 0 &&
    people.length === 0 &&
    communities.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-bold">
        Results for <span className="text-accent">“{q}”</span>
      </h1>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-h-11 cursor-pointer items-center gap-2 font-medium">
          <input
            type="checkbox"
            checked={semantic}
            onChange={(event) => setSemantic(event.target.checked)}
            data-testid="search-semantic-toggle"
            className="h-5 w-5 accent-[#ffbf47]"
          />
          Semantic search
        </label>
        <span className="text-sm text-text-muted">
          {results?.semanticApplied
            ? "Results blended with meaning-based matches."
            : semantic
              ? "Semantic matches will blend in when available."
              : "Keyword matches only."}
        </span>
      </div>

      <div role="tablist" aria-label="Search result types" className="flex gap-1 border-b border-border">
        {TABS.map((option) => (
          <button
            key={option.id}
            role="tab"
            aria-selected={tab === option.id}
            data-testid={`search-tab-${option.id}`}
            onClick={() => void switchTab(option.id)}
            className={`min-h-12 border-b-2 px-4 font-medium transition-colors ${
              tab === option.id
                ? "border-accent text-text"
                : "border-transparent text-text-muted hover:text-text"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {loading ? (
        <FeedSkeleton count={3} />
      ) : error && !results ? (
        <ApiErrorState error={error} onRetry={() => void runSearch(tab)} />
      ) : nothingFound ? (
        <EmptyState
          title="No matches"
          body={`Nothing on GG matches “${q}” yet. Try different words.`}
          testId="search-no-results"
        />
      ) : (
        <div role="tabpanel" className="flex flex-col gap-6">
          {(tab === "all" || tab === "people") && people.length > 0 ? (
            <section aria-label="People" className="flex flex-col gap-3">
              {tab === "all" ? (
                <h2 className="font-display text-lg font-semibold">People</h2>
              ) : null}
              <ul className="flex flex-col gap-3">
                {(tab === "all" ? people.slice(0, 5) : people).map((profile) => (
                  <li key={profile.userId}>
                    <UserRow profile={profile} />
                  </li>
                ))}
              </ul>
              {tab === "people" && peopleCursor ? (
                <LoadMoreButton
                  onClick={() => void loadMorePeople()}
                  loading={loadingMore}
                  testId="search-people-load-more"
                />
              ) : null}
            </section>
          ) : null}

          {(tab === "all" || tab === "communities") && communities.length > 0 ? (
            <section aria-label="Communities" className="flex flex-col gap-3">
              {tab === "all" ? (
                <h2 className="font-display text-lg font-semibold">Communities</h2>
              ) : null}
              <ul className="flex flex-col gap-3">
                {(tab === "all" ? communities.slice(0, 5) : communities).map((community) => (
                  <li key={community.id}>
                    <CommunityCard community={community} />
                  </li>
                ))}
              </ul>
              {tab === "communities" && communitiesCursor ? (
                <LoadMoreButton
                  onClick={() => void loadMoreCommunities()}
                  loading={loadingMore}
                  testId="search-communities-load-more"
                />
              ) : null}
            </section>
          ) : null}

          {(tab === "all" || tab === "posts") && posts.length > 0 ? (
            <section aria-label="Posts" className="flex flex-col gap-3">
              {tab === "all" ? (
                <h2 className="font-display text-lg font-semibold">Posts</h2>
              ) : null}
              {posts.map((post) => (
                <PostCard key={post.id} post={post} />
              ))}
              {postsCursor ? (
                <LoadMoreButton
                  onClick={() => void loadMorePosts()}
                  loading={loadingMore}
                  testId="search-posts-load-more"
                />
              ) : null}
            </section>
          ) : null}

          {(tab === "posts" && posts.length === 0) ||
          (tab === "people" && people.length === 0) ||
          (tab === "communities" && communities.length === 0) ? (
            <EmptyState
              title="No matches in this tab"
              body={`No ${tab} match “${q}” yet.`}
              testId="search-tab-empty"
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function LoadMoreButton({
  onClick,
  loading,
  testId,
}: {
  onClick: () => void;
  loading: boolean;
  testId: string;
}) {
  return (
    <div className="flex justify-center">
      <Button variant="ghost" onClick={onClick} disabled={loading} data-testid={testId}>
        {loading ? "Loading…" : "Load more"}
      </Button>
    </div>
  );
}
