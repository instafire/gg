"use client";

import type { CommunityView } from "@gg/sdk";
import { Button } from "@gg/ui";
import { useCallback, useEffect, useState } from "react";
import { CommunityCard } from "../../../components/CommunityCard";
import { ApiErrorState, EmptyState } from "../../../components/States";
import { api } from "../../../lib/api";

export default function CommunitiesPage() {
  const [items, setItems] = useState<CommunityView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.listCommunities({ limit: 20 });
      setItems(page.items);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.listCommunities({ cursor: nextCursor, limit: 20 });
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-bold">Communities</h1>
      {loading ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading communities">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 rounded-lg bg-[var(--skeleton)]" />
          ))}
        </div>
      ) : error && items.length === 0 ? (
        <ApiErrorState error={error} onRetry={() => void loadFirst()} />
      ) : items.length === 0 ? (
        <EmptyState title="No communities yet" body="The floor is empty. Start one soon." />
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {items.map((community) => (
              <li key={community.id}>
                <CommunityCard community={community} />
              </li>
            ))}
          </ul>
          {nextCursor ? (
            <div className="flex justify-center">
              <Button
                variant="ghost"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                data-testid="communities-load-more"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
