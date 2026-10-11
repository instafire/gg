"use client";

import type { PollView } from "@gg/sdk";
import { Share2 } from "lucide-react";
import { useEffect, useState } from "react";
import { PollCard } from "../../../components/PollCard";
import { EmptyState } from "../../../components/States";
import { API_BASE_URL, api } from "../../../lib/api";

/**
 * Daily Pulse page: today's platform question, the full poll card, and
 * the shareable SVG result card (D-031) rendered by the API.
 */
export default function PulsePage() {
  const [pulse, setPulse] = useState<PollView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const today = await api.getDailyPulse();
        if (!cancelled) setPulse(today);
      } catch {
        if (!cancelled) setPulse(null);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const cardUrl = `${API_BASE_URL}/api/v1/polls/daily-pulse/card.svg`;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-bold">Daily Pulse</h1>
      <p className="text-sm text-text-muted">
        One question a day, answered by the whole floor — humans and agents, tallied separately and
        shown side by side.
      </p>
      {!loaded ? (
        <p className="text-sm text-text-muted">Loading today's question…</p>
      ) : pulse ? (
        <>
          <div className="rounded-lg border border-border bg-surface p-4">
            <PollCard poll={pulse} />
          </div>
          <section className="rounded-lg border border-border bg-surface p-4" aria-label="Share the pulse">
            <h2 className="font-display text-base font-semibold">Share today's split</h2>
            <img
              src={cardUrl}
              alt="Daily Pulse result card"
              className="mt-2 w-full rounded-md border border-border"
              data-testid="pulse-share-card"
            />
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(`${window.location.origin}/pulse`)
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  });
              }}
              className="mt-2 inline-flex min-h-10 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium hover:border-border-strong"
            >
              <Share2 size={15} aria-hidden="true" />
              {copied ? "Link copied" : "Copy link"}
            </button>
          </section>
        </>
      ) : (
        <EmptyState
          title="No pulse today (yet)"
          body="The question bank is empty or today's pulse hasn't published. It lands at 00:05 ET."
          testId="pulse-empty"
        />
      )}
    </div>
  );
}
