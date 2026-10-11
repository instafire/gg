"use client";

import type { CursorPage, PostView } from "@gg/sdk";
import { Button } from "@gg/ui";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { PostCard } from "./PostCard";
import { ApiErrorState, EmptyState, FeedSkeleton } from "./States";

export interface FeedListHandle {
  /** Put a freshly created post at the top of the list. */
  prepend: (post: PostView) => void;
  reload: () => void;
}

interface FeedListProps {
  /** Fetch one page; pass the cursor for subsequent pages. */
  fetchPage: (cursor: string | undefined) => Promise<CursorPage<PostView>>;
  emptyTitle?: string;
  emptyBody?: string;
  /** Changing this value resets and refetches the list (e.g. a sort change). */
  resetKey?: string;
}

/**
 * Cursor-paginated post list with an explicit Load more button (paired with
 * the infinite-scroll pattern per DESIGN_SYSTEM §6.4) and honest loading /
 * empty / can't-reach-the-API states.
 */
export const FeedList = forwardRef<FeedListHandle, FeedListProps>(function FeedList(
  { fetchPage, emptyTitle = "Nothing here yet", emptyBody = "Be the first take.", resetKey },
  ref,
) {
  const [items, setItems] = useState<PostView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchRef.current(undefined);
      setItems(page.items);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(cause);
      setItems([]);
      setNextCursor(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst, resetKey]);

  useImperativeHandle(ref, () => ({
    prepend: (post) =>
      setItems((current) => [post, ...current.filter((item) => item.id !== post.id)]),
    reload: () => void loadFirst(),
  }));

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchRef.current(nextCursor);
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !seen.has(item.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoadingMore(false);
    }
  }

  if (loading) return <FeedSkeleton />;
  if (error && items.length === 0) {
    return <ApiErrorState error={error} onRetry={() => void loadFirst()} />;
  }
  if (items.length === 0) {
    return <EmptyState title={emptyTitle} body={emptyBody} testId="feed-empty-state" />;
  }

  return (
    <div className="flex flex-col gap-4">
      {items.map((post) => (
        <PostCard key={post.id} post={post} />
      ))}
      {error ? <ApiErrorState error={error} onRetry={() => void loadMore()} /> : null}
      {nextCursor ? (
        <div className="flex justify-center py-2">
          <Button
            variant="ghost"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            data-testid="feed-load-more"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
});
