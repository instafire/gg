"use client";

import type { DebateView } from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import { Newspaper, Swords } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { DebateComposer } from "../../../components/DebateComposer";
import { EmptyState } from "../../../components/States";
import { api } from "../../../lib/api";
import { formatRelativeTime } from "../../../lib/format";
import { useSession } from "../../../lib/session";

type Filter = "all" | "open" | "live" | "mine";

function DebateRow({ debate }: { debate: DebateView }) {
  const winner = debate.sides.find((side) => side.key === debate.winnerSideKey);
  return (
    <Link
      href={`/debates/${debate.id}`}
      data-testid="debate-row"
      className="block rounded-lg border border-border bg-surface p-4 transition-colors hover:border-border-strong"
    >
      <p className="flex flex-wrap items-center gap-2 text-xs font-semibold tracking-wide text-text-muted uppercase">
        {debate.format.replaceAll("_", " ")} · {debate.status.replaceAll("_", " ")}
        {debate.sourceArticleUrl ? <span>· from article</span> : null}
        <span className="ml-auto font-normal normal-case">{formatRelativeTime(debate.createdAt)}</span>
      </p>
      <h2 className="mt-1 font-display text-lg leading-snug font-semibold">{debate.proposition}</h2>
      <p className="mt-1 text-sm text-text-muted">
        {debate.sides.map((side) => `${side.label} ${side.argumentCount}`).join(" · ")}
        {debate.mindChange.mindChangedCount > 0
          ? ` · ${debate.mindChange.mindChangedCount} minds changed`
          : ""}
        {debate.status === "closed" || debate.status === "archived"
          ? debate.isDraw
            ? " · draw"
            : winner
              ? ` · ${winner.label} won`
              : ""
          : ""}
      </p>
    </Link>
  );
}

/** Debates hub: the floor, live debates, yours — plus both creation flows. */
export default function DebatesPage() {
  const { status, user } = useSession();
  const [filter, setFilter] = useState<Filter>("all");
  const [debates, setDebates] = useState<DebateView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [articleUrl, setArticleUrl] = useState("");
  const [articleBusy, setArticleBusy] = useState(false);
  const [articleError, setArticleError] = useState<string | null>(null);
  const [showComposer, setShowComposer] = useState(false);

  const load = useCallback(async () => {
    try {
      const page = await api.listDebates({
        status:
          filter === "open"
            ? "open"
            : filter === "live"
              ? "live"
              : undefined,
        limit: 30,
      });
      setDebates(
        filter === "mine" && user
          ? page.items.filter(
              (debate) =>
                debate.host.id === user.id ||
                debate.participants.some((p) => p.user.id === user.id),
            )
          : page.items,
      );
    } catch {
      setDebates([]);
    } finally {
      setLoaded(true);
    }
  }, [filter, user]);

  useEffect(() => {
    void load();
  }, [load]);

  async function debateArticle() {
    if (!articleUrl.trim()) return;
    setArticleBusy(true);
    setArticleError(null);
    try {
      const debate = await api.createDebateFromArticle({ articleUrl: articleUrl.trim() });
      window.location.href = `/debates/${debate.id}`;
    } catch (cause) {
      setArticleError(
        cause instanceof GGApiError ? cause.detail : "Couldn't start a debate from that URL.",
      );
    } finally {
      setArticleBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex items-center gap-2 font-display text-2xl font-bold">
          <Swords size={22} aria-hidden="true" /> Debates
        </h1>
        {status === "authenticated" ? (
          <button
            type="button"
            onClick={() => setShowComposer((value) => !value)}
            data-testid="debates-new-button"
            className="ml-auto min-h-10 rounded-md bg-accent px-4 text-sm font-semibold text-black"
          >
            {showComposer ? "Close" : "Start a debate"}
          </button>
        ) : null}
      </div>

      {showComposer && status === "authenticated" ? (
        <div className="rounded-lg border border-border bg-surface p-4">
          <DebateComposer
            onCreated={(post) => {
              setShowComposer(false);
              if (post.debate) window.location.href = `/debates/${post.debate.id}`;
            }}
          />
        </div>
      ) : null}

      <section className="rounded-lg border border-border bg-surface p-4" aria-label="Debate this article">
        <h2 className="flex items-center gap-2 font-display text-base font-semibold">
          <Newspaper size={17} aria-hidden="true" /> Debate this article
        </h2>
        <p className="mt-1 text-sm text-text-muted">
          Paste any article URL — a genznewz.com story or anywhere else — and GG opens a debate floor
          on its central claim.
        </p>
        <div className="mt-2 flex gap-2">
          <label htmlFor="article-url" className="sr-only">
            Article URL
          </label>
          <input
            id="article-url"
            value={articleUrl}
            onChange={(event) => setArticleUrl(event.target.value)}
            placeholder="https://genznewz.com/…"
            data-testid="debate-article-url"
            className="min-h-11 min-w-0 flex-1 rounded-md border border-border bg-surface-sunken px-3 text-sm placeholder:text-text-muted"
          />
          <button
            type="button"
            disabled={articleBusy || status !== "authenticated"}
            onClick={() => void debateArticle()}
            data-testid="debate-article-submit"
            className="min-h-11 shrink-0 rounded-md bg-accent px-4 text-sm font-semibold text-black disabled:opacity-40"
          >
            {articleBusy ? "Opening…" : "Debate it"}
          </button>
        </div>
        {status !== "authenticated" ? (
          <p className="mt-1 text-xs text-text-muted">Log in to start an article debate.</p>
        ) : null}
        {articleError ? (
          <p role="alert" className="mt-1 text-sm text-danger">
            {articleError}
          </p>
        ) : null}
      </section>

      <div className="flex gap-1" role="tablist" aria-label="Debate filter">
        {(
          [
            { key: "all", label: "All" },
            { key: "open", label: "Open floor" },
            { key: "live", label: "Live" },
            { key: "mine", label: "Mine" },
          ] as const
        ).map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={filter === tab.key}
            onClick={() => setFilter(tab.key)}
            className={`min-h-10 rounded-full px-4 text-sm font-medium ${
              filter === tab.key
                ? "bg-accent-tint text-text"
                : "text-text-muted hover:bg-surface-sunken hover:text-text"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {!loaded ? (
        <p className="text-sm text-text-muted">Loading debates…</p>
      ) : debates.length === 0 ? (
        <EmptyState
          title="No debates here yet"
          body="Start the first one — a clear proposition, an honest opening argument."
          testId="debates-empty"
        />
      ) : (
        <div className="flex flex-col gap-3">
          {debates.map((debate) => (
            <DebateRow key={debate.id} debate={debate} />
          ))}
        </div>
      )}
    </div>
  );
}
