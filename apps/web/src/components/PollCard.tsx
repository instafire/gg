"use client";

import type { PollResultsView, PollView } from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import { pollOptionTestId } from "@gg/ui";
import { BarChart3, Check, ChevronDown, Lock, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { StanceBar, StanceSlider } from "./StanceSlider";

/**
 * Poll card (Phase 3): one component for every poll type — single,
 * multiple, ranked (click-to-rank IRV), stance slider, image, hot take —
 * with the D-012 human/agent split always one toggle away and the
 * demographic breakdowns behind a drawer (age cells are opt-in-only and
 * suppressed under 5 on the server).
 */
export function PollCard({
  poll: initialPoll,
  isAuthor = false,
  compact = false,
}: {
  poll: PollView;
  isAuthor?: boolean;
  compact?: boolean;
}) {
  const { requireAuth } = useSession();
  const [poll, setPoll] = useState(initialPoll);
  const [results, setResults] = useState<PollResultsView | null>(null);
  const [showSplit, setShowSplit] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Local ballot editors.
  const [picked, setPicked] = useState<string[]>(initialPoll.viewerBallot?.optionIds ?? []);
  const [ranking, setRanking] = useState<string[]>(initialPoll.viewerBallot?.ranking ?? []);
  const [stance, setStance] = useState<number | null>(initialPoll.viewerBallot?.sliderValue ?? null);

  const refresh = useCallback(async () => {
    try {
      const fresh = await api.getPoll(initialPoll.id);
      setPoll(fresh);
      if (fresh.resultsVisible) {
        setResults(await api.getPollResults(initialPoll.id));
      }
    } catch {
      // Keep the last good state; the next interaction retries.
    }
  }, [initialPoll.id]);

  useEffect(() => {
    if (initialPoll.resultsVisible || initialPoll.isClosed) {
      void refresh();
    }
  }, [initialPoll.id, initialPoll.resultsVisible, initialPoll.isClosed, refresh]);

  async function cast(ballot: Parameters<typeof api.votePoll>[1]) {
    if (!requireAuth()) return;
    setBusy(true);
    setError(null);
    try {
      await api.votePoll(poll.id, ballot);
      await refresh();
    } catch (cause) {
      setError(cause instanceof GGApiError ? cause.detail : "Couldn't record that vote.");
    } finally {
      setBusy(false);
    }
  }

  async function retract() {
    if (!requireAuth()) return;
    setBusy(true);
    setError(null);
    try {
      await api.retractPollVote(poll.id);
      setPicked([]);
      setRanking([]);
      setStance(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof GGApiError ? cause.detail : "Couldn't withdraw that vote.");
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    setBusy(true);
    setError(null);
    try {
      setPoll(await api.closePoll(poll.id));
      await refresh();
    } catch (cause) {
      setError(cause instanceof GGApiError ? cause.detail : "Couldn't close the poll.");
    } finally {
      setBusy(false);
    }
  }

  const ballot = poll.viewerBallot;
  const hasBallot = ballot !== null;
  const displayOptions = results?.options ?? poll.options;
  const winnerId = results?.winnerOptionId ?? null;

  function optionBar(optionId: string, humanVotes: number, agentVotes: number, share: number) {
    const isWinner = winnerId === optionId && poll.isClosed;
    return (
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          {/* The label wraps instead of truncating: in the narrow rail the
              old single-line layout cut options mid-word ("Only practice,
              no g…") because the counts suffix crowded the same row. The
              human/agent counts move to the card footer in compact mode. */}
          <span className={`min-w-0 text-sm ${isWinner ? "font-semibold" : ""}`}>
            {displayOptions.find((o) => o.id === optionId)?.text ?? "Option"}
            {isWinner ? " · winner" : ""}
          </span>
          <span className="shrink-0 text-xs text-text-muted tabular-nums">
            {Math.round(share * 100)}%
            {compact
              ? ""
              : ` · ${humanVotes} human${showSplit ? ` · ${agentVotes} agent` : ""}`}
          </span>
        </div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
          <div
            className={`h-full ${isWinner ? "bg-accent" : "bg-border-strong"}`}
            style={{ width: `${share > 0 ? Math.max(2, share * 100) : 0}%` }}
          />
        </div>
      </div>
    );
  }

  function renderResults() {
    if (poll.type === "stance_slider" && results?.stanceDistribution) {
      return <StanceBar distribution={results.stanceDistribution} label="Pulse of the floor" />;
    }
    return (
      <ul className="flex flex-col gap-2.5">
        {displayOptions.map((option) => (
          <li key={option.id} className="flex items-center gap-2">
            {ballot?.optionId === option.id || ballot?.optionIds.includes(option.id) ? (
              <Check size={15} aria-label="Your vote" className="shrink-0 text-accent" />
            ) : (
              <span className="w-[15px] shrink-0" aria-hidden="true" />
            )}
            {optionBar(option.id, option.humanVotes, option.agentVotes, option.share)}
          </li>
        ))}
      </ul>
    );
  }

  function renderVoter() {
    if (poll.type === "stance_slider") {
      return (
        <div className="flex flex-col gap-2">
          <StanceSlider value={stance} onChange={setStance} disabled={busy} />
          <button
            type="button"
            disabled={busy || stance === null}
            onClick={() => stance !== null && void cast({ sliderValue: stance })}
            className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-black transition-opacity disabled:opacity-40"
          >
            {hasBallot ? "Update stance" : "Record stance"}
          </button>
        </div>
      );
    }
    if (poll.type === "multiple") {
      const max = 10;
      return (
        <div className="flex flex-col gap-2">
          <ul className="flex flex-col gap-1.5" role="group" aria-label="Choose options">
            {poll.options.map((option, index) => {
              const selected = picked.includes(option.id);
              return (
                <li key={option.id}>
                  <button
                    type="button"
                    data-testid={pollOptionTestId(index + 1)}
                    aria-pressed={selected}
                    disabled={busy}
                    onClick={() =>
                      setPicked((current) =>
                        selected
                          ? current.filter((id) => id !== option.id)
                          : current.length < max
                            ? [...current, option.id]
                            : current,
                      )
                    }
                    className={`flex min-h-11 w-full items-center gap-2 rounded-md border px-3 text-left text-sm transition-colors ${
                      selected
                        ? "border-accent bg-accent-tint"
                        : "border-border bg-surface-sunken hover:border-border-strong"
                    }`}
                  >
                    <span
                      className={`flex h-4 w-4 items-center justify-center rounded-sm border ${selected ? "border-accent bg-accent text-black" : "border-border-strong"}`}
                      aria-hidden="true"
                    >
                      {selected ? <Check size={12} /> : null}
                    </span>
                    {option.text}
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            disabled={busy || picked.length === 0}
            onClick={() => void cast({ optionIds: picked })}
            className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-black transition-opacity disabled:opacity-40"
          >
            {hasBallot ? "Update vote" : "Vote"}
          </button>
        </div>
      );
    }
    if (poll.type === "ranked") {
      return (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-text-muted">Tap options in your order of preference.</p>
          <ul className="flex flex-col gap-1.5">
            {poll.options.map((option, index) => {
              const rank = ranking.indexOf(option.id);
              return (
                <li key={option.id}>
                  <button
                    type="button"
                    data-testid={pollOptionTestId(index + 1)}
                    disabled={busy}
                    aria-pressed={rank >= 0}
                    onClick={() =>
                      setRanking((current) =>
                        rank >= 0
                          ? current.filter((id) => id !== option.id)
                          : [...current, option.id],
                      )
                    }
                    className={`flex min-h-11 w-full items-center gap-2 rounded-md border px-3 text-left text-sm transition-colors ${
                      rank >= 0
                        ? "border-accent bg-accent-tint"
                        : "border-border bg-surface-sunken hover:border-border-strong"
                    }`}
                  >
                    <span
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface text-xs font-semibold tabular-nums"
                      aria-hidden="true"
                    >
                      {rank >= 0 ? rank + 1 : "·"}
                    </span>
                    {option.text}
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            disabled={busy || ranking.length === 0}
            onClick={() => void cast({ ranking })}
            className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-black transition-opacity disabled:opacity-40"
          >
            {hasBallot ? "Update ranking" : "Submit ranking"}
          </button>
        </div>
      );
    }
    if (poll.type === "image") {
      return (
        <ul className="grid grid-cols-2 gap-2">
          {poll.options.map((option, index) => (
            <li key={option.id}>
              <button
                type="button"
                data-testid={pollOptionTestId(index + 1)}
                disabled={busy}
                onClick={() => void cast({ optionId: option.id })}
                className={`block w-full overflow-hidden rounded-md border text-left transition-colors ${
                  ballot?.optionId === option.id
                    ? "border-accent"
                    : "border-border hover:border-border-strong"
                }`}
              >
                {option.media?.url ? (
                  <img src={option.media.url} alt={option.text ?? "Poll option"} className="aspect-square w-full object-cover" />
                ) : (
                  <span className="flex aspect-square items-center justify-center bg-surface-sunken text-text-muted">No image</span>
                )}
                <span className="block truncate px-2 py-1.5 text-xs">{option.text}</span>
              </button>
            </li>
          ))}
        </ul>
      );
    }
    // single + hot_take: one tap casts.
    return (
      <ul className="flex flex-col gap-1.5">
        {poll.options.map((option, index) => (
          <li key={option.id}>
            <button
              type="button"
              data-testid={pollOptionTestId(index + 1)}
              disabled={busy}
              aria-pressed={ballot?.optionId === option.id}
              onClick={() => void cast({ optionId: option.id })}
              className={`flex min-h-11 w-full items-center rounded-md border px-3 text-left text-sm transition-colors ${
                ballot?.optionId === option.id
                  ? "border-accent bg-accent-tint font-medium"
                  : "border-border bg-surface-sunken hover:border-border-strong"
              }`}
            >
              {option.text}
            </button>
          </li>
        ))}
      </ul>
    );
  }

  if (poll.voided) {
    return (
      <div className="mt-3 rounded-md border border-border bg-surface-sunken p-3" data-testid="poll-card">
        <p className="text-sm font-medium">This poll was voided by moderators.</p>
        <p className="text-xs text-text-muted">Ballots were excluded after an integrity review.</p>
      </div>
    );
  }

  return (
    <section
      data-testid="poll-card"
      aria-label={`Poll: ${poll.question}`}
      className="mt-3 rounded-md border border-border bg-surface-sunken p-3 sm:p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="font-display text-base font-semibold">{poll.question}</h4>
        {poll.isDailyPulse ? (
          <span className="shrink-0 rounded-full bg-accent-tint px-2 py-0.5 text-[0.6875rem] font-semibold tracking-wide uppercase">
            Daily Pulse
          </span>
        ) : null}
      </div>

      <div className="mt-3">
        {poll.isClosed ? (
          renderResults()
        ) : poll.resultsVisible ? (
          <>
            {renderVoter()}
            <div className="mt-3 border-t border-border pt-3">{renderResults()}</div>
          </>
        ) : (
          <>
            {renderVoter()}
            <p className="mt-2 flex items-center gap-1.5 text-xs text-text-muted">
              <Lock size={13} aria-hidden="true" />
              {poll.resultMode === "after_vote"
                ? hasBallot
                  ? "Results unlock as votes come in — refresh to see the latest."
                  : "Results are hidden until you vote."
                : "Results are hidden until this poll closes."}
            </p>
          </>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
        <span className="tabular-nums">
          {poll.totalVotes} human · {poll.agentTotalVotes} agent votes
        </span>
        {poll.isClosed ? (
          <span>Poll closed</span>
        ) : poll.closesAt ? (
          <span>Closes {new Date(poll.closesAt).toLocaleString()}</span>
        ) : null}
        {poll.isAnonymous ? <span>Anonymous ballot</span> : null}
        <span className="flex-1" />
        <button
          type="button"
          aria-pressed={showSplit}
          onClick={() => setShowSplit((value) => !value)}
          className="inline-flex min-h-8 items-center gap-1 rounded-full px-2 font-medium hover:bg-surface hover:text-text"
        >
          <BarChart3 size={13} aria-hidden="true" />
          {showSplit ? "Hide split" : "Human / agent split"}
        </button>
        {hasBallot && !poll.isClosed ? (
          <button
            type="button"
            onClick={() => void retract()}
            disabled={busy}
            className="inline-flex min-h-8 items-center gap-1 rounded-full px-2 font-medium hover:bg-surface hover:text-text"
          >
            <X size={13} aria-hidden="true" /> Withdraw vote
          </button>
        ) : null}
        {isAuthor && !poll.isClosed ? (
          <button
            type="button"
            onClick={() => void close()}
            disabled={busy}
            className="inline-flex min-h-8 items-center rounded-full px-2 font-medium hover:bg-surface hover:text-text"
          >
            Close poll
          </button>
        ) : null}
      </div>

      {!compact && (poll.resultsVisible || poll.isClosed) ? (
        <div className="mt-1">
          <button
            type="button"
            aria-expanded={drawerOpen}
            onClick={() => {
              setDrawerOpen((value) => !value);
              if (!results) void refresh();
            }}
            className="inline-flex min-h-8 items-center gap-1 text-xs font-medium text-text-muted hover:text-text"
          >
            <ChevronDown
              size={14}
              aria-hidden="true"
              className={drawerOpen ? "rotate-180 transition-transform" : "transition-transform"}
            />
            Breakdowns
          </button>
          {drawerOpen && results ? (
            <div className="mt-2 grid gap-3 text-xs sm:grid-cols-2" data-testid="poll-breakdowns">
              <div>
                <h5 className="font-semibold">By trust tier</h5>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {Object.entries(results.breakdowns.byTrustTier).map(([tier, count]) => (
                    <li key={tier} className="flex justify-between tabular-nums">
                      <span>{tier}</span>
                      <span>{count}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h5 className="font-semibold">By age bracket (opted-in only)</h5>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {Object.entries(results.breakdowns.byAgeBracket).length === 0 ? (
                    <li className="text-text-muted">No opted-in breakdowns yet.</li>
                  ) : (
                    Object.entries(results.breakdowns.byAgeBracket).map(([bracket, count]) => (
                      <li key={bracket} className="flex justify-between tabular-nums">
                        <span>{bracket}</span>
                        <span>{count}</span>
                      </li>
                    ))
                  )}
                </ul>
                <p className="mt-1 text-text-muted">Groups under 5 voters are hidden.</p>
              </div>
              {results.irvRounds.length > 0 ? (
                <div className="sm:col-span-2">
                  <h5 className="font-semibold">Ranked tabulation (IRV)</h5>
                  <ol className="mt-1 flex flex-col gap-0.5">
                    {results.irvRounds.map((round) => (
                      <li key={round.round} className="tabular-nums">
                        Round {round.round}:{" "}
                        {Object.entries(round.tallies)
                          .map(([id, n]) => `${displayOptions.find((o) => o.id === id)?.text ?? "option"} ${n}`)
                          .join(" · ")}
                        {round.eliminatedOptionId
                          ? ` — eliminated: ${displayOptions.find((o) => o.id === round.eliminatedOptionId)?.text ?? "option"}`
                          : ""}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
