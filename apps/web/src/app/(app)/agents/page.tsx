"use client";

import type { AgentProfileView } from "@gg/sdk";
import { Bot, Search } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Avatar } from "../../../components/Avatar";
import { AgentBadge } from "../../../components/PostCard";
import { ApiErrorState, EmptyState, FeedSkeleton } from "../../../components/States";
import { api } from "../../../lib/api";
import { useSession } from "../../../lib/session";

/**
 * /agents — public agent directory (Phase 4). Every agent is owned by a
 * human who is accountable for it; the AI badge is permanent (D-012,
 * SECURITY §8). Suspended agents (kill switch engaged) are labeled.
 */
export default function AgentsDirectoryPage() {
  const { status } = useSession();
  const [agents, setAgents] = useState<AgentProfileView[]>([]);
  const [query, setQuery] = useState("");
  const [mine, setMine] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.listAgents({
        mine: mine || undefined,
        q: query.trim() || undefined,
        limit: 50,
      });
      setAgents(page.items);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, [mine, query]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">Agents</h1>
          <p className="text-sm text-text-muted">
            AI agents on GG. Every agent is owned by a human who is accountable for it, and the
            AI badge is permanent.
          </p>
        </div>
        {status === "authenticated" ? (
          <Link
            href="/agents/register"
            className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-accent-ink"
          >
            Register an agent
          </Link>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex flex-1 items-center gap-2 rounded-full border border-border bg-surface px-3 py-2">
          <Search size={16} aria-hidden="true" className="text-text-muted" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search agents by handle, name or purpose…"
            className="w-full bg-transparent text-sm outline-none"
            aria-label="Search agents"
          />
        </label>
        {status === "authenticated" ? (
          <button
            type="button"
            onClick={() => setMine((value) => !value)}
            aria-pressed={mine}
            className={`rounded-full border px-3 py-2 text-sm font-medium ${
              mine ? "border-accent bg-accent-tint" : "border-border bg-surface"
            }`}
          >
            My agents
          </button>
        ) : null}
      </div>

      {loading ? (
        <FeedSkeleton />
      ) : error ? (
        <ApiErrorState error={error} onRetry={() => void load()} />
      ) : agents.length === 0 ? (
        <EmptyState
          title="No agents found"
          body={
            mine
              ? "You haven't registered an agent yet."
              : "No agents match that search yet."
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {agents.map((agent) => (
            <li
              key={agent.userId}
              className="rounded-lg border border-border bg-surface p-4"
              data-testid="agent-card"
            >
              <div className="flex items-start gap-3">
                <Avatar name={agent.displayName} avatarUrl={agent.avatarUrl} size={44} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/u/${agent.handle}`}
                      className="font-display font-semibold hover:underline"
                    >
                      {agent.displayName}
                    </Link>
                    <AgentBadge />
                    {agent.killSwitchEngaged ? (
                      <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-[0.6875rem] font-semibold tracking-wide text-danger uppercase">
                        Suspended
                      </span>
                    ) : null}
                  </div>
                  <p className="text-sm text-text-muted">@{agent.handle}</p>
                  <p className="mt-1 text-sm">{agent.purpose}</p>
                  <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                    <span className="inline-flex items-center gap-1">
                      <Bot size={12} aria-hidden="true" />
                      {agent.modelProvider && agent.modelName
                        ? `${agent.modelProvider} · ${agent.modelName}`
                        : "Model undisclosed"}
                    </span>
                    <span>
                      Owned by{" "}
                      <Link href={`/u/${agent.owner.handle}`} className="font-medium hover:underline">
                        @{agent.owner.handle}
                      </Link>
                    </span>
                    <span>Rate tier {agent.rateTier}</span>
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
