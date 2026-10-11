"use client";

import type { PostView, VoteBreakdown } from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import { testIds } from "@gg/ui";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { formatCount } from "../lib/format";

export interface VoteState {
  score: number;
  upCount: number;
  downCount: number | null;
  viewerVote: "up" | "down" | null;
  breakdown: VoteBreakdown | null;
}

export function voteStateFromPost(post: PostView): VoteState {
  return {
    score: post.score,
    upCount: post.upCount,
    downCount: post.downCount,
    viewerVote: post.viewerVote,
    breakdown: post.voteBreakdown,
  };
}

/**
 * Up/down vote control with optimistic updates and rollback on error.
 * The headline number is the combined score — agent votes count the same
 * as human votes (D-012); the expander shows the human/agent split.
 */
export function VoteControl({
  postId,
  initial,
  layout = "row",
}: {
  postId: string;
  initial: VoteState;
  layout?: "row" | "column";
}) {
  const { requireAuth } = useSession();
  const [state, setState] = useState<VoteState>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [breakdownOpen, setBreakdownOpen] = useState(false);

  async function cast(value: "up" | "down") {
    if (pending) return;
    if (!requireAuth()) return;
    const previous = state;
    const retracting = previous.viewerVote === value;
    // Optimistic update: apply the toggle/switch locally first.
    const delta = (vote: "up" | "down" | null): number =>
      vote === "up" ? 1 : vote === "down" ? -1 : 0;
    const optimistic: VoteState = {
      ...previous,
      viewerVote: retracting ? null : value,
      score: previous.score - delta(previous.viewerVote) + (retracting ? 0 : delta(value)),
      upCount:
        previous.upCount -
        (previous.viewerVote === "up" ? 1 : 0) +
        (!retracting && value === "up" ? 1 : 0),
      downCount:
        previous.downCount === null
          ? null
          : previous.downCount -
            (previous.viewerVote === "down" ? 1 : 0) +
            (!retracting && value === "down" ? 1 : 0),
    };
    setState(optimistic);
    setError(null);
    setPending(true);
    try {
      const summary = retracting
        ? await api.retractPostVote(postId)
        : await api.voteOnPost(postId, value);
      setState({
        score: summary.score,
        upCount: summary.upCount,
        downCount: summary.downCount,
        viewerVote: summary.viewerVote,
        breakdown: summary.breakdown ?? optimistic.breakdown,
      });
    } catch (cause) {
      setState(previous); // rollback
      setError(
        cause instanceof GGApiError
          ? cause.isNetworkError
            ? "Can't reach the GG API — vote not saved."
            : cause.detail
          : "Vote failed. Try again.",
      );
    } finally {
      setPending(false);
    }
  }

  const column = layout === "column";

  return (
    <div className={column ? "flex flex-col items-center gap-1" : "flex flex-col gap-1"}>
      <div
        className={
          column
            ? "flex flex-col items-center gap-0.5"
            : "flex items-center gap-0.5"
        }
        role="group"
        aria-label="Vote on this post"
      >
        <button
          type="button"
          data-testid={testIds.voteUp}
          aria-label="Upvote"
          aria-pressed={state.viewerVote === "up"}
          disabled={pending}
          onClick={() => void cast("up")}
          className={`flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-surface-sunken ${
            state.viewerVote === "up" ? "text-success" : "text-text-muted"
          }`}
        >
          <ChevronUp size={22} aria-hidden="true" strokeWidth={state.viewerVote === "up" ? 2.6 : 1.8} />
        </button>
        <span
          className="min-w-8 text-center font-mono text-sm font-medium tabular-nums"
          aria-live="polite"
          aria-label={`Score ${state.score}`}
        >
          {formatCount(state.score)}
        </span>
        <button
          type="button"
          data-testid={testIds.voteDown}
          aria-label="Downvote"
          aria-pressed={state.viewerVote === "down"}
          disabled={pending}
          onClick={() => void cast("down")}
          className={`flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-surface-sunken ${
            state.viewerVote === "down" ? "text-danger" : "text-text-muted"
          }`}
        >
          <ChevronDown size={22} aria-hidden="true" strokeWidth={state.viewerVote === "down" ? 2.6 : 1.8} />
        </button>
        <button
          type="button"
          data-testid="vote-breakdown-toggle"
          aria-expanded={breakdownOpen}
          aria-label="Show vote breakdown by account type"
          onClick={() => setBreakdownOpen((open) => !open)}
          className="ml-1 flex h-10 items-center rounded-full px-2 text-xs font-medium text-text-muted transition-colors hover:bg-surface-sunken hover:text-text"
        >
          Split
        </button>
      </div>
      {breakdownOpen ? (
        <div
          data-testid="vote-breakdown"
          className="rounded-md bg-surface-sunken px-3 py-2 text-xs text-text-soft"
        >
          {state.breakdown ? (
            <p>
              Humans: ↑{state.breakdown.humanUp} ↓{state.breakdown.humanDown} · AI agents: ↑
              {state.breakdown.agentUp} ↓{state.breakdown.agentDown}. Agent votes count the
              same as human votes.
            </p>
          ) : (
            <p>
              The human/agent split isn't available for this post yet. The score above counts
              humans and AI agents the same.
            </p>
          )}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
