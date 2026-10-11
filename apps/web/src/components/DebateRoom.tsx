"use client";

import type { ArgumentView, DebateStateView, DebateView, EvidenceInput } from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import { testIds } from "@gg/ui";
import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  Eye,
  Lightbulb,
  Link2,
  ShieldCheck,
  Swords,
  Timer,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { civilityFlags, detectFallacies, steelmanTemplate } from "../lib/coach";
import { formatRelativeTime } from "../lib/format";
import { useSession } from "../lib/session";
import { AgentBadge } from "./PostCard";
import { StanceBar, StanceSlider } from "./StanceSlider";
import { Avatar } from "./Avatar";

const LIVE_STATUSES = new Set(["open", "live", "awaiting_turn"]);

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function countdown(deadline: string, now: number): string {
  const ms = new Date(deadline).getTime() - now;
  if (ms <= 0) return "time expired — the turn will be marked missed";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours >= 1) return `${hours}h ${minutes}m left`;
  if (minutes >= 1) return `${minutes}m ${seconds}s left`;
  return `${seconds}s left`;
}

function ArgumentCard({
  argument,
  debate,
  onChanged,
  highlighted,
}: {
  argument: ArgumentView;
  debate: DebateView;
  onChanged: () => void;
  highlighted: boolean;
}) {
  const { user, requireAuth } = useSession();
  const [vote, setVote] = useState(argument.viewerVote);
  const [score, setScore] = useState(argument.score);
  const [error, setError] = useState<string | null>(null);
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [evidenceKind, setEvidenceKind] = useState<EvidenceInput["kind"]>("news");
  const isOwn = user?.id === argument.author.id;
  const canConfirmSteelman =
    !isOwn &&
    argument.isSteelman &&
    !argument.steelmanConfirmed &&
    (debate.participants.some((p) => p.user.id === user?.id) || debate.judge?.id === user?.id);

  async function castVote(value: "up" | "down") {
    if (!requireAuth()) return;
    try {
      if (vote === value) {
        const summary = await api.retractArgumentVote(argument.id);
        setVote(null);
        setScore(summary.score);
      } else {
        const summary = await api.voteArgument(argument.id, value);
        setVote(value);
        setScore(summary.score);
      }
    } catch (cause) {
      setError(cause instanceof GGApiError ? cause.detail : "Couldn't save that vote.");
    }
  }

  async function addEvidence() {
    if (!evidenceUrl.trim()) return;
    try {
      await api.addEvidence(argument.id, [{ url: evidenceUrl.trim(), kind: evidenceKind }]);
      setEvidenceUrl("");
      onChanged();
    } catch (cause) {
      setError(cause instanceof GGApiError ? cause.detail : "Couldn't add that evidence.");
    }
  }

  return (
    <article
      id={`argument-${argument.id}`}
      data-testid="argument-card"
      className={`rounded-md border p-3 ${highlighted ? "border-accent bg-accent-tint" : "border-border bg-surface"}`}
    >
      <div className="flex items-center gap-2">
        <Avatar name={argument.author.displayName} avatarUrl={argument.author.avatarUrl} size={28} />
        <span className="truncate text-sm font-medium">{argument.author.displayName}</span>
        {argument.authorType === "agent" ? <AgentBadge /> : null}
        <span className="text-xs text-text-muted">@{argument.author.handle}</span>
        <span className="ml-auto shrink-0 text-xs text-text-muted">
          {formatRelativeTime(argument.createdAt)}
        </span>
      </div>
      {argument.isSteelman ? (
        <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-[0.6875rem] font-semibold tracking-wide uppercase">
          <ShieldCheck size={12} aria-hidden="true" />
          Steelman{argument.steelmanConfirmed ? " · confirmed by the other side" : " · awaiting confirmation"}
        </p>
      ) : null}
      <p className="mt-2 text-[0.9375rem] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
        {argument.bodyMd}
      </p>
      {argument.evidence.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1">
          {argument.evidence.map((item) => (
            <li key={item.id} className="truncate text-xs">
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex max-w-full items-center gap-1 text-link underline underline-offset-2"
              >
                <ExternalLink size={11} aria-hidden="true" className="shrink-0" />
                <span className="truncate">
                  [{item.kind}] {item.domain ?? item.url}
                </span>
              </a>
              {item.quote ? <span className="block pl-4 text-text-muted">“{item.quote}”</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {argument.fallacyFlags.length > 0 ? (
        <p className="mt-2 text-xs text-text-muted">
          Flagged: {argument.fallacyFlags.map((flag) => flag.fallacy).join(", ")}
          {argument.fallacyFlags.some((flag) => flag.confirmedByMod) ? " (moderator-confirmed)" : ""}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <button
          type="button"
          aria-label="Upvote argument"
          aria-pressed={vote === "up"}
          onClick={() => void castVote("up")}
          className={`flex h-9 items-center gap-1 rounded-full px-2 text-sm ${vote === "up" ? "text-accent" : "text-text-muted hover:bg-surface-sunken hover:text-text"}`}
        >
          <ArrowUp size={16} aria-hidden="true" />
        </button>
        <span className="min-w-6 text-center text-sm font-medium tabular-nums" aria-label="Argument score">
          {score}
        </span>
        <button
          type="button"
          aria-label="Downvote argument"
          aria-pressed={vote === "down"}
          onClick={() => void castVote("down")}
          className={`flex h-9 items-center gap-1 rounded-full px-2 text-sm ${vote === "down" ? "text-danger" : "text-text-muted hover:bg-surface-sunken hover:text-text"}`}
        >
          <ArrowDown size={16} aria-hidden="true" />
        </button>
        {argument.evidenceQuality > 0 ? (
          <span className="ml-1 text-xs text-text-muted">
            Evidence quality {argument.evidenceQuality.toFixed(2)}
          </span>
        ) : null}
        {canConfirmSteelman ? (
          <button
            type="button"
            onClick={() => {
              void api.confirmSteelman(argument.id).then(onChanged).catch(() => setError("Couldn't confirm."));
            }}
            className="ml-auto min-h-9 rounded-full border border-border px-3 text-xs font-medium hover:border-border-strong"
          >
            Confirm steelman
          </button>
        ) : null}
      </div>
      {isOwn && debate.status !== "closed" && debate.status !== "archived" ? (
        <div className="mt-2 flex gap-2">
          <input
            value={evidenceUrl}
            onChange={(event) => setEvidenceUrl(event.target.value)}
            placeholder="Add an evidence URL"
            aria-label="Evidence URL"
            className="min-h-9 min-w-0 flex-1 rounded-md border border-border bg-surface-sunken px-2 text-sm placeholder:text-text-muted"
          />
          <select
            value={evidenceKind}
            onChange={(event) => setEvidenceKind(event.target.value as EvidenceInput["kind"])}
            aria-label="Evidence kind"
            className="min-h-9 rounded-md border border-border bg-surface-sunken px-2 text-sm"
          >
            <option value="study">Study</option>
            <option value="data">Data</option>
            <option value="news">News</option>
            <option value="personal_experience">Experience</option>
            <option value="other">Other</option>
          </select>
          <button
            type="button"
            onClick={() => void addEvidence()}
            className="min-h-9 shrink-0 rounded-md bg-accent px-3 text-sm font-semibold text-black"
          >
            Add
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </article>
  );
}

/**
 * The debate room: open floors render side columns; structured 1v1 renders
 * the round timeline. Live statuses poll every 10s (D-032 note: realtime
 * websockets are Phase 5; this view is polling-based by design).
 */
export function DebateRoom({ debateId }: { debateId: string }) {
  const { user, requireAuth } = useSession();
  const [debate, setDebate] = useState<DebateView | null>(null);
  const [args, setArgs] = useState<ArgumentView[]>([]);
  const [state, setState] = useState<DebateStateView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const now = useNow(1000);
  const aliveRef = useRef(true);

  // Argument composer state (open/team).
  const [sideKey, setSideKey] = useState<string>("for");
  const [body, setBody] = useState("");
  const [isSteelman, setIsSteelman] = useState(false);
  const [evidenceRows, setEvidenceRows] = useState<Array<{ url: string; kind: EvidenceInput["kind"] }>>([]);
  // Round submission state (structured).
  const [turnBody, setTurnBody] = useState("");
  // Stance state.
  const [preStance, setPreStance] = useState<number | null>(null);
  const [postStance, setPostStance] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [embedCopied, setEmbedCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const [freshDebate, freshState] = await Promise.all([
        api.getDebate(debateId),
        api.getDebateState(debateId),
      ]);
      if (!aliveRef.current) return;
      setDebate(freshDebate);
      setState(freshState);
      const pages: ArgumentView[] = [];
      for (const side of freshDebate.sides) {
        const page = await api.listArguments(debateId, { sideKey: side.key });
        pages.push(...page.items);
      }
      if (!aliveRef.current) return;
      setArgs(pages);
    } catch (cause) {
      if (aliveRef.current) {
        setError(cause instanceof GGApiError ? cause.detail : "Couldn't load this debate.");
      }
    }
  }, [debateId]);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => {
      aliveRef.current = false;
    };
  }, [load]);

  // Polling refresh while the debate is live (Phase 3 live view).
  const isLive = debate ? LIVE_STATUSES.has(debate.status) : false;
  useEffect(() => {
    if (!isLive) return;
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [isLive, load]);

  const fallacies = useMemo(() => detectFallacies(body || turnBody), [body, turnBody]);
  const civility = useMemo(() => civilityFlags(body || turnBody), [body, turnBody]);

  if (error && !debate) {
    return (
      <p role="alert" className="rounded-lg border border-border bg-surface p-4 text-sm text-danger">
        {error}
      </p>
    );
  }
  if (!debate || !state) {
    return <p className="p-4 text-sm text-text-muted">Loading debate…</p>;
  }

  const isParticipant = debate.participants.some((p) => p.user.id === user?.id);
  const isHost = debate.host.id === user?.id;
  const isJudge = debate.judge?.id === user?.id;
  const activeRound = debate.rounds.find((round) => round.status === "active") ?? null;
  const myTurn =
    activeRound !== null &&
    debate.participants.some(
      (p) => p.user.id === user?.id && p.sideKey === activeRound.sideKey,
    );
  const allRoundsDone = debate.rounds.every((round) =>
    ["submitted", "missed", "skipped"].includes(round.status),
  );
  const canPostStance =
    state.viewerStance?.pre !== null &&
    state.viewerStance?.post === null &&
    (debate.status === "closed" || debate.status === "archived" || (debate.format !== "open" && allRoundsDone));
  const winnerSide = debate.sides.find((side) => side.key === debate.winnerSideKey) ?? null;
  const topArgument = [...args].sort((a, b) => b.score - a.score)[0] ?? null;

  async function runAction(action: () => Promise<unknown>) {
    setActionError(null);
    try {
      await action();
      await load();
    } catch (cause) {
      setActionError(cause instanceof GGApiError ? cause.detail : "That didn't work. Try again.");
    }
  }

  async function submitArgument() {
    if (!requireAuth()) return;
    await runAction(async () => {
      if (!isParticipant) await api.joinDebate(debate!.id, sideKey);
      await api.createArgument(debate!.id, {
        sideKey,
        bodyMd: body.trim(),
        isSteelman,
        evidence: evidenceRows.filter((row) => row.url.trim()).map((row) => ({ url: row.url.trim(), kind: row.kind })),
      });
      setBody("");
      setEvidenceRows([]);
      setIsSteelman(false);
    });
  }

  async function submitTurn() {
    if (!activeRound || !requireAuth()) return;
    await runAction(async () => {
      await api.submitRound(debate!.id, activeRound.roundNo, { bodyMd: turnBody.trim() });
      setTurnBody("");
    });
  }

  async function readOtherSide() {
    if (!requireAuth()) return;
    try {
      const argument = await api.getDebatePerspective(debate!.id);
      setHighlightId(argument.id);
      document.getElementById(`argument-${argument.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (cause) {
      setActionError(cause instanceof GGApiError ? cause.detail : "No opposing argument yet.");
    }
  }

  const embedSnippet = `<iframe src="${typeof window !== "undefined" ? window.location.origin : ""}/embed/debate/${debate.id}" width="100%" height="420" style="border:0;border-radius:12px" title="GG debate: ${debate.proposition.replaceAll('"', "")}"></iframe>`;

  return (
    <div className="flex flex-col gap-4" data-testid="debate-room">
      {/* Header */}
      <header className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <p className="flex flex-wrap items-center gap-2 text-xs font-semibold tracking-wide text-text-muted uppercase">
          <Swords size={14} aria-hidden="true" />
          {debate.format.replaceAll("_", " ")} debate · {debate.status.replaceAll("_", " ")}
          {debate.sourceArticleUrl ? (
            <a href={debate.sourceArticleUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 normal-case text-link underline underline-offset-2">
              <Link2 size={12} aria-hidden="true" /> source article
            </a>
          ) : null}
        </p>
        <h1 className="mt-2 font-display text-2xl leading-tight font-bold">{debate.proposition}</h1>
        <p className="mt-1 text-sm text-text-muted">
          Hosted by @{debate.host.handle}
          {debate.judge ? ` · judged by @${debate.judge.handle}` : ""}
          {" · "}share: /d/{debate.shortCode}
        </p>
        {debate.status === "closed" || debate.status === "archived" ? (
          <div className="mt-3 rounded-md bg-accent-tint p-3" role="status">
            <p className="font-display text-lg font-semibold">
              {debate.pendingJudge
                ? "Both debaters missed turns — the judge will decide this one."
                : debate.isDraw
                  ? "It's a draw."
                  : winnerSide
                    ? `${winnerSide.label} wins.`
                    : "Debate closed."}
            </p>
            {debate.winnerFormula ? (
              <p className="mt-0.5 text-xs text-text-muted">
                Scored on argument votes ({Math.round(debate.winnerFormula.argumentVotes * 100)}%),
                minds changed ({Math.round(debate.winnerFormula.mindChange * 100)}%), evidence
                quality ({Math.round(debate.winnerFormula.evidenceQuality * 100)}%).
              </p>
            ) : null}
            {debate.pendingJudge && (isJudge || isHost) ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {debate.sides.map((side) => (
                  <button
                    key={side.key}
                    type="button"
                    onClick={() => void runAction(() => api.judgeDecision(debate.id, { winnerSideKey: side.key }))}
                    className="min-h-10 rounded-md bg-accent px-3 text-sm font-semibold text-black"
                  >
                    Judge for {side.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => void runAction(() => api.judgeDecision(debate.id, { isDraw: true }))}
                  className="min-h-10 rounded-md border border-border px-3 text-sm font-medium"
                >
                  Call it a draw
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {debate.viewerChallenge ? (
          <div className="mt-3 rounded-md border border-accent bg-accent-tint p-3" role="status">
            <p className="text-sm font-medium">You've been challenged to this debate.</p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() =>
                  void runAction(() => api.respondToChallenge(debate.id, debate.viewerChallenge!.id, "accept"))
                }
                className="min-h-10 rounded-md bg-accent px-4 text-sm font-semibold text-black"
              >
                Accept &amp; start
              </button>
              <button
                type="button"
                onClick={() =>
                  void runAction(() => api.respondToChallenge(debate.id, debate.viewerChallenge!.id, "decline"))
                }
                className="min-h-10 rounded-md border border-border bg-surface px-4 text-sm font-medium"
              >
                Decline
              </button>
            </div>
          </div>
        ) : null}
        {(isHost || isJudge) && LIVE_STATUSES.has(debate.status) ? (
          <button
            type="button"
            onClick={() => void runAction(() => api.closeDebate(debate.id))}
            className="mt-3 min-h-10 rounded-md border border-border px-4 text-sm font-medium hover:border-border-strong"
          >
            Close debate &amp; score it
          </button>
        ) : null}
        {actionError ? (
          <p role="alert" className="mt-2 text-sm text-danger">
            {actionError}
          </p>
        ) : null}
      </header>

      {/* Stance: before vs after */}
      <section className="rounded-lg border border-border bg-surface p-4 sm:p-5" aria-label="Audience stance">
        <h2 className="font-display text-base font-semibold">Where the audience stands</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <StanceBar distribution={state.stanceDistribution.pre} label="Before reading" />
          <StanceBar distribution={state.stanceDistribution.post} label="After reading" />
        </div>
        <p className="mt-2 text-sm text-text-muted">
          {state.mindChangedCount} mind{state.mindChangedCount === 1 ? "" : "s"} changed
          {state.stanceDistribution.post && Object.keys(state.stanceDistribution.post).length > 0
            ? ` (${Math.round(state.mindChangeRate * 100)}% of paired stances)`
            : ""}
          .
        </p>
        {user ? (
          <div className="mt-3 grid gap-4 border-t border-border pt-3 sm:grid-cols-2">
            <div>
              <p className="text-sm font-medium">Your stance before reading</p>
              {state.viewerStance?.pre !== null && state.viewerStance !== null ? (
                <p className="mt-1 text-sm text-text-muted">Recorded: {state.viewerStance.pre}</p>
              ) : (
                <>
                  <div className="mt-2">
                    <StanceSlider value={preStance} onChange={setPreStance} />
                  </div>
                  <button
                    type="button"
                    disabled={preStance === null}
                    onClick={() =>
                      preStance !== null &&
                      void runAction(() => api.castStanceVote(debate.id, { phase: "pre", stanceValue: preStance }))
                    }
                    className="mt-2 min-h-10 rounded-md bg-accent px-4 text-sm font-semibold text-black disabled:opacity-40"
                  >
                    Record stance
                  </button>
                </>
              )}
            </div>
            <div>
              <p className="text-sm font-medium">Your stance after reading</p>
              {canPostStance ? (
                <>
                  <div className="mt-2">
                    <StanceSlider value={postStance} onChange={setPostStance} />
                  </div>
                  <button
                    type="button"
                    disabled={postStance === null}
                    onClick={() =>
                      postStance !== null &&
                      void runAction(() => api.castStanceVote(debate.id, { phase: "post", stanceValue: postStance }))
                    }
                    className="mt-2 min-h-10 rounded-md bg-accent px-4 text-sm font-semibold text-black disabled:opacity-40"
                  >
                    Record new stance
                  </button>
                </>
              ) : (
                <p className="mt-1 text-sm text-text-muted">
                  {state.viewerStance?.post !== null && state.viewerStance !== null
                    ? `Recorded: ${state.viewerStance.post}`
                    : "Unlocks when the debate closes (or all rounds are in)."}
                </p>
              )}
            </div>
          </div>
        ) : (
          <p className="mt-2 text-sm text-text-muted">Log in to record your stance.</p>
        )}
        <button
          type="button"
          onClick={() => void readOtherSide()}
          className="mt-3 inline-flex min-h-10 items-center gap-1.5 rounded-full border border-border px-3 text-sm font-medium hover:border-border-strong"
        >
          <Eye size={15} aria-hidden="true" /> Read the other side (perspective tool)
        </button>
      </section>

      {/* Structured rounds */}
      {debate.format === "structured_1v1" ? (
        <section className="rounded-lg border border-border bg-surface p-4 sm:p-5" aria-label="Rounds">
          <h2 className="flex items-center gap-2 font-display text-base font-semibold">
            <Timer size={16} aria-hidden="true" /> Rounds
            {isLive ? <span className="text-xs font-normal text-text-muted">· live — refreshes automatically</span> : null}
          </h2>
          <ol className="mt-3 flex flex-col gap-3">
            {debate.rounds.map((round) => {
              const argument = args.find((item) => item.id === round.argumentId) ?? null;
              const side = debate.sides.find((item) => item.key === round.sideKey);
              return (
                <li key={round.roundNo} className="rounded-md border border-border p-3">
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-semibold">
                      Round {round.roundNo} · {round.kind}
                    </span>
                    <span className="text-text-muted">{side?.label ?? round.sideKey}</span>
                    <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs">{round.status}</span>
                    {round.status === "active" && round.deadlineAt ? (
                      <span className="text-xs font-medium text-text-muted tabular-nums">
                        {countdown(round.deadlineAt, now)}
                      </span>
                    ) : null}
                  </p>
                  {argument ? (
                    <div className="mt-2">
                      <ArgumentCard argument={argument} debate={debate} onChanged={() => void load()} highlighted={highlightId === argument.id} />
                    </div>
                  ) : round.status === "active" ? (
                    myTurn ? (
                      <div className="mt-2">
                        <label htmlFor="turn-body" className="text-sm font-medium">
                          Your turn — {debate.perTurnCharLimit} characters max
                        </label>
                        <textarea
                          id="turn-body"
                          value={turnBody}
                          rows={5}
                          maxLength={debate.perTurnCharLimit}
                          onChange={(event) => setTurnBody(event.target.value)}
                          className="mt-1 w-full resize-y rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-[1rem]"
                        />
                        <p className="mt-1 text-xs text-text-muted tabular-nums">
                          {turnBody.length} / {debate.perTurnCharLimit}
                        </p>
                        <CoachHints fallacies={fallacies} civility={civility} />
                        <button
                          type="button"
                          disabled={turnBody.trim().length === 0}
                          onClick={() => void submitTurn()}
                          className="mt-2 min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-black disabled:opacity-40"
                        >
                          Submit turn
                        </button>
                      </div>
                    ) : (
                      <p className="mt-2 text-sm text-text-muted">Waiting for {side?.label ?? "the debater"}…</p>
                    )
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      ) : (
        <>
          {/* Open/team argument columns */}
          <section aria-label="Arguments" className="grid gap-4 md:grid-cols-2">
            {debate.sides.map((side) => {
              const sideArgs = args
                .filter((argument) => argument.sideKey === side.key)
                .sort((a, b) => b.score - a.score);
              return (
                <div key={side.key} className="rounded-lg border border-border bg-surface p-4">
                  <h2 className="font-display text-base font-semibold" data-testid={`debate-column-${side.key}`}>
                    {side.label}
                    <span className="ml-2 text-xs font-normal text-text-muted">
                      {side.argumentCount} arguments · net {side.humanArgumentVotes} human / {side.agentArgumentVotes} agent
                    </span>
                  </h2>
                  <div className="mt-3 flex flex-col gap-3">
                    {sideArgs.length === 0 ? (
                      <p className="text-sm text-text-muted">No arguments yet — make the case.</p>
                    ) : (
                      sideArgs.map((argument) => (
                        <ArgumentCard
                          key={argument.id}
                          argument={argument}
                          debate={debate}
                          onChanged={() => void load()}
                          highlighted={highlightId === argument.id}
                        />
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </section>

          {/* Argument composer */}
          {LIVE_STATUSES.has(debate.status) && user ? (
            <section className="rounded-lg border border-border bg-surface p-4 sm:p-5" aria-label="Add an argument">
              <h2 className="font-display text-base font-semibold">Add your argument</h2>
              <div className="mt-2 flex flex-wrap gap-1" role="radiogroup" aria-label="Side">
                {debate.sides.map((side) => (
                  <button
                    key={side.key}
                    type="button"
                    role="radio"
                    aria-checked={sideKey === side.key}
                    data-testid={side.key === "for" ? testIds.debateSideFor : side.key === "against" ? testIds.debateSideAgainst : side.key === "nuanced" ? testIds.debateSideNuanced : undefined}
                    onClick={() => setSideKey(side.key)}
                    className={`min-h-10 rounded-md border px-3 text-sm font-medium ${sideKey === side.key ? "border-accent bg-accent-tint" : "border-border bg-surface-sunken text-text-muted hover:text-text"}`}
                  >
                    {side.label}
                  </button>
                ))}
              </div>
              <label htmlFor="argument-body" className="sr-only">
                Argument
              </label>
              <textarea
                id="argument-body"
                value={body}
                rows={4}
                onChange={(event) => setBody(event.target.value)}
                placeholder="Make the strongest honest case you can…"
                className="mt-2 w-full resize-y rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-[1rem] placeholder:text-text-muted"
              />
              <CoachHints fallacies={fallacies} civility={civility} />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={isSteelman}
                    onChange={(event) => setIsSteelman(event.target.checked)}
                    className="h-4 w-4 accent-[#ffbf47]"
                  />
                  This is a steelman (their case, at its strongest)
                </label>
                <button
                  type="button"
                  onClick={() => setBody((current) => (current.trim() ? `${current.trim()}\n\n${steelmanTemplate("other side's")}` : steelmanTemplate("other side's")))}
                  className="inline-flex min-h-9 items-center gap-1 rounded-full border border-border px-3 text-xs font-medium hover:border-border-strong"
                >
                  <ShieldCheck size={13} aria-hidden="true" /> Steelman scaffold
                </button>
                <button
                  type="button"
                  onClick={() => setEvidenceRows((current) => [...current, { url: "", kind: "news" }])}
                  className="min-h-9 rounded-full border border-border px-3 text-xs font-medium hover:border-border-strong"
                >
                  + Evidence link
                </button>
              </div>
              {evidenceRows.map((row, index) => (
                <div key={index} className="mt-2 flex gap-2">
                  <input
                    value={row.url}
                    onChange={(event) =>
                      setEvidenceRows((current) => current.map((item, i) => (i === index ? { ...item, url: event.target.value } : item)))
                    }
                    placeholder="https://evidence.example/study"
                    aria-label={`Evidence URL ${index + 1}`}
                    className="min-h-10 min-w-0 flex-1 rounded-md border border-border bg-surface-sunken px-2 text-sm placeholder:text-text-muted"
                  />
                  <select
                    value={row.kind}
                    onChange={(event) =>
                      setEvidenceRows((current) => current.map((item, i) => (i === index ? { ...item, kind: event.target.value as EvidenceInput["kind"] } : item)))
                    }
                    aria-label={`Evidence kind ${index + 1}`}
                    className="min-h-10 rounded-md border border-border bg-surface-sunken px-2 text-sm"
                  >
                    <option value="study">Study</option>
                    <option value="data">Data</option>
                    <option value="news">News</option>
                    <option value="personal_experience">Experience</option>
                    <option value="other">Other</option>
                  </select>
                </div>
              ))}
              <button
                type="button"
                disabled={body.trim().length === 0}
                onClick={() => void submitArgument()}
                className="mt-3 min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-black disabled:opacity-40"
              >
                Post argument
              </button>
            </section>
          ) : null}
        </>
      )}

      {/* Embed */}
      <section className="rounded-lg border border-border bg-surface p-4" aria-label="Embed this debate">
        <h2 className="font-display text-base font-semibold">Embed this debate</h2>
        <p className="mt-1 text-sm text-text-muted">
          Top argument right now: {topArgument ? `“${topArgument.bodyMd.slice(0, 90)}…”` : "none yet"}. Paste
          this snippet on any site (it powers the genznewz.com debate widgets):
        </p>
        <div className="mt-2 flex gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md bg-surface-sunken px-3 py-2 text-xs">{embedSnippet}</code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(embedSnippet).then(() => {
                setEmbedCopied(true);
                setTimeout(() => setEmbedCopied(false), 2000);
              });
            }}
            className="min-h-10 shrink-0 rounded-md border border-border px-3 text-sm font-medium hover:border-border-strong"
          >
            {embedCopied ? "Copied" : "Copy embed"}
          </button>
        </div>
      </section>
    </div>
  );
}

function CoachHints({
  fallacies,
  civility,
}: {
  fallacies: ReturnType<typeof detectFallacies>;
  civility: string[];
}) {
  if (fallacies.length === 0 && civility.length === 0) return null;
  return (
    <div className="mt-2 rounded-md bg-surface-sunken p-3 text-xs" role="status">
      <p className="flex items-center gap-1 font-semibold">
        <Lightbulb size={13} aria-hidden="true" /> Coach — lightweight local assists (patterns, not AI)
      </p>
      <ul className="mt-1 flex flex-col gap-1">
        {fallacies.map((hit) => (
          <li key={hit.fallacy}>
            <strong>{hit.fallacy}:</strong> {hit.tip}
          </li>
        ))}
        {civility.map((flag) => (
          <li key={flag}>
            <strong>Civility nudge:</strong> {flag}.
          </li>
        ))}
      </ul>
    </div>
  );
}
