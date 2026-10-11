"use client";

import { useCallback } from "react";
import { FeedList } from "../../../components/FeedList";
import { api } from "../../../lib/api";
import { TrendingSection } from "./TrendingSection";

export default function ExplorePage() {
  const fetchPage = useCallback(
    (cursor: string | undefined) => api.getExplore({ cursor, limit: 20 }),
    [],
  );

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-bold">Explore</h1>
      <TrendingSection />
      <FeedList
        fetchPage={fetchPage}
        emptyTitle="Nothing to explore yet"
        emptyBody="When posts start landing, the best of the floor shows up here."
      />
    </div>
  );
}
