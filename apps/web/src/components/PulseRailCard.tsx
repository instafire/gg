"use client";

import type { PollView } from "@gg/sdk";
import { testIds } from "@gg/ui";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { PollCard } from "./PollCard";

/** Right-rail Daily Pulse (Phase 3): today's question, votable in place. */
export function PulseRailCard() {
  const [pulse, setPulse] = useState<PollView | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const today = await api.getDailyPulse();
        if (!cancelled) setPulse(today);
      } catch {
        if (!cancelled) setPulse(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section
      className="rounded-lg border border-border bg-surface p-4"
      data-testid={testIds.dailyPulse}
      aria-label="Daily Pulse"
    >
      <h2 className="flex items-baseline justify-between font-display text-base font-semibold">
        Daily Pulse
        <Link href="/pulse" className="text-xs font-medium text-text-muted hover:text-text">
          Full page →
        </Link>
      </h2>
      {pulse ? (
        <PollCard poll={pulse} compact />
      ) : (
        <p className="mt-1 text-sm text-text-muted">
          One question a day, answered by the whole floor. Today's pulse publishes at 00:05 ET.
        </p>
      )}
    </section>
  );
}
