"use client";

import type { DebateFormat, PostView } from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import { Button, testIds } from "@gg/ui";
import { Lightbulb, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../lib/api";
import { civilityFlags, detectFallacies, steelmanTemplate } from "../lib/coach";
import { useSession } from "../lib/session";

/**
 * Debate creation (Phase 3): proposition + format; open debates take an
 * opening argument, 1v1 takes a challenged handle and starts as a draft
 * until they accept. The coach panel under the opening argument is a
 * lightweight local assist (keyword patterns — no AI, nothing leaves the
 * browser) and is labeled as such.
 */
export function DebateComposer({
  communitySlug,
  onCreated,
}: {
  communitySlug?: string;
  onCreated?: (post: PostView) => void;
}) {
  const { requireAuth } = useSession();
  const [proposition, setProposition] = useState("");
  const [format, setFormat] = useState<DebateFormat>("open");
  const [challengedHandle, setChallengedHandle] = useState("");
  const [sideKey, setSideKey] = useState<"for" | "against" | "nuanced">("for");
  const [opening, setOpening] = useState("");
  const [rounds, setRounds] = useState(3);
  const [charLimit, setCharLimit] = useState(2000);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fallacies = useMemo(() => detectFallacies(opening), [opening]);
  const civility = useMemo(() => civilityFlags(opening), [opening]);

  const valid =
    proposition.trim().length >= 10 &&
    (format !== "structured_1v1" || challengedHandle.trim().length >= 3) &&
    (format !== "open" || opening.trim().length >= 1) &&
    !submitting;

  async function submit() {
    if (!valid || !requireAuth()) return;
    setSubmitting(true);
    setError(null);
    try {
      const debate = await api.createDebate({
        proposition: proposition.trim(),
        format,
        communitySlug,
        challengedHandle:
          format === "structured_1v1" ? challengedHandle.trim().replace(/^@/, "") : undefined,
        challengerSideKey: format === "structured_1v1" ? "for" : undefined,
        rounds: format === "structured_1v1" ? rounds : undefined,
        perTurnCharLimit: format === "structured_1v1" ? charLimit : undefined,
        opening:
          format === "open"
            ? { sideKey, bodyMd: opening.trim() }
            : undefined,
      });
      const post = await api.getPost(debate.postId);
      onCreated?.(post);
    } catch (cause) {
      setError(cause instanceof GGApiError ? cause.detail : "Couldn't start the debate.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div data-testid="debate-composer" className="flex flex-col gap-3">
      <div>
        <label htmlFor="debate-proposition" className="text-sm font-medium">
          Proposition <span className="text-text-muted">(10–280 characters, one clear claim)</span>
        </label>
        <textarea
          id="debate-proposition"
          value={proposition}
          maxLength={280}
          rows={2}
          onChange={(event) => setProposition(event.target.value)}
          placeholder="e.g. Homework should be abolished in primary school"
          className="mt-1 w-full resize-y rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-[1rem] placeholder:text-text-muted"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="debate-format" className="text-sm font-medium">
            Format
          </label>
          <select
            id="debate-format"
            value={format}
            onChange={(event) => setFormat(event.target.value as DebateFormat)}
            className="mt-1 min-h-11 w-full rounded-md border border-border bg-surface-sunken px-3 text-sm"
          >
            <option value="open">Open floor — anyone argues any side</option>
            <option value="structured_1v1">Structured 1v1 — rounds vs one opponent</option>
            <option value="team">Team — two squads, open arguments</option>
          </select>
        </div>
        {format === "structured_1v1" ? (
          <div>
            <label htmlFor="debate-challenged" className="text-sm font-medium">
              Challenge (handle)
            </label>
            <input
              id="debate-challenged"
              value={challengedHandle}
              onChange={(event) => setChallengedHandle(event.target.value)}
              placeholder="@handle"
              className="mt-1 min-h-11 w-full rounded-md border border-border bg-surface-sunken px-3 text-sm placeholder:text-text-muted"
            />
          </div>
        ) : null}
      </div>

      {format === "structured_1v1" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="debate-rounds" className="text-sm font-medium">
              Rounds (each side argues once per round)
            </label>
            <input
              id="debate-rounds"
              type="number"
              min={1}
              max={10}
              value={rounds}
              onChange={(event) => setRounds(Number(event.target.value))}
              className="mt-1 min-h-11 w-full rounded-md border border-border bg-surface-sunken px-3 text-sm"
            />
          </div>
          <div>
            <label htmlFor="debate-char-limit" className="text-sm font-medium">
              Characters per turn (280–10,000)
            </label>
            <input
              id="debate-char-limit"
              type="number"
              min={280}
              max={10000}
              step={100}
              value={charLimit}
              onChange={(event) => setCharLimit(Number(event.target.value))}
              className="mt-1 min-h-11 w-full rounded-md border border-border bg-surface-sunken px-3 text-sm"
            />
          </div>
          <p className="text-sm text-text-muted sm:col-span-2">
            Your opponent gets 24 hours per turn. Miss the final turn and the debate is forfeited.
            The winner is scored on argument votes, minds changed, and evidence quality.
          </p>
        </div>
      ) : null}

      {format === "open" ? (
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium" id="opening-side-label">
              Your opening stance
            </span>
            <div role="radiogroup" aria-labelledby="opening-side-label" className="flex gap-1">
              {(
                [
                  { key: "for", label: "For", testId: testIds.debateSideFor },
                  { key: "against", label: "Against", testId: testIds.debateSideAgainst },
                  { key: "nuanced", label: "Nuanced", testId: testIds.debateSideNuanced },
                ] as const
              ).map((side) => (
                <button
                  key={side.key}
                  type="button"
                  role="radio"
                  aria-checked={sideKey === side.key}
                  data-testid={side.testId}
                  onClick={() => setSideKey(side.key)}
                  className={`min-h-10 rounded-md border px-3 text-sm font-medium transition-colors ${
                    sideKey === side.key
                      ? "border-accent bg-accent-tint"
                      : "border-border bg-surface-sunken text-text-muted hover:text-text"
                  }`}
                >
                  {side.label}
                </button>
              ))}
            </div>
          </div>
          <label htmlFor="debate-opening" className="mt-3 block text-sm font-medium">
            Opening argument
          </label>
          <textarea
            id="debate-opening"
            value={opening}
            rows={5}
            onChange={(event) => setOpening(event.target.value)}
            placeholder="Make your case. Evidence links can be added after posting."
            className="mt-1 w-full resize-y rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-[1rem] placeholder:text-text-muted"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                setOpening((current) =>
                  current.trim()
                    ? `${current.trim()}\n\n${steelmanTemplate("other side's")}`
                    : steelmanTemplate("other side's"),
                )
              }
              className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border px-3 text-xs font-medium hover:border-border-strong"
            >
              <ShieldCheck size={14} aria-hidden="true" /> Insert steelman scaffold
            </button>
            <span className="inline-flex items-center gap-1 text-xs text-text-muted">
              <Lightbulb size={13} aria-hidden="true" /> Coach: lightweight local assists (patterns,
              not AI)
            </span>
          </div>
          {fallacies.length > 0 || civility.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1 rounded-md bg-surface-sunken p-3 text-xs" role="status">
              {fallacies.map((hit) => (
                <li key={hit.fallacy}>
                  <strong>{hit.fallacy}:</strong> {hit.tip}
                </li>
              ))}
              {civility.map((flag) => (
                <li key={flag}>
                  <strong>Civility nudge:</strong> {flag} — the strongest arguments stay cool.
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="button" disabled={!valid} onClick={() => void submit()} data-testid="debate-submit">
          {submitting
            ? "Starting…"
            : format === "structured_1v1"
              ? "Send challenge"
              : "Start debate"}
        </Button>
      </div>
    </div>
  );
}
