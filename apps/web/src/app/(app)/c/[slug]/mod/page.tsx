"use client";

import type {
  AutomodKind,
  AutomodRuleView,
  CommunityView,
  ConversationView,
  MembershipRequestView,
  ModActionView,
  ModQueueItemView,
} from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import { Button } from "@gg/ui";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { inputClassName, labelClassName } from "../../../../../components/AuthCard";
import { ApiErrorState, EmptyState, FeedSkeleton } from "../../../../../components/States";
import { api } from "../../../../../lib/api";
import { RequireAuth } from "../../../../../lib/session";

/**
 * /c/[slug]/mod — Phase 5B mod console: the merged queue (reports +
 * AutoMod holds with the firing rule cited), AutoMod rule CRUD, lockdown,
 * membership requests, the mod-action log, and mod-mail threads. Every
 * call is mod-gated server-side; a 403 renders the honest "mods only"
 * state.
 */

type Tab = "queue" | "rules" | "requests" | "lockdown" | "log" | "mail";

const TABS: { id: Tab; label: string }[] = [
  { id: "queue", label: "Queue" },
  { id: "rules", label: "AutoMod rules" },
  { id: "requests", label: "Requests" },
  { id: "lockdown", label: "Lockdown" },
  { id: "log", label: "Mod log" },
  { id: "mail", label: "Mod mail" },
];

const RULE_KINDS: { id: AutomodKind; hint: string }[] = [
  { id: "keyword", hint: '{"keywords": ["word", "phrase"]}' },
  { id: "regex", hint: '{"pattern": "buy\\\\s+followers"}' },
  { id: "account_age", hint: '{"min_account_age_days": 7}' },
  { id: "karma_threshold", hint: '{"min_karma": 10}' },
  { id: "trust_tier", hint: '{"min_trust_tier": "T1"}' },
  { id: "link_domain", hint: '{"domains": ["spam.example"]}' },
  { id: "link_count", hint: '{"max_links": 2}' },
];

export default function ModConsolePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  return (
    <RequireAuth>
      <ModConsole slug={slug} />
    </RequireAuth>
  );
}

function ModConsole({ slug }: { slug: string }) {
  const [tab, setTab] = useState<Tab>("queue");
  const [community, setCommunity] = useState<CommunityView | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getCommunity(slug)
      .then((result) => {
        if (cancelled) return;
        setCommunity(result);
        const role = result.viewerMembership?.role;
        if (role !== "owner" && role !== "admin" && role !== "moderator") {
          setForbidden(true);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setLoadError(cause);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (loadError) return <ApiErrorState error={loadError} />;
  if (!community) return <FeedSkeleton count={2} />;
  if (forbidden) {
    return (
      <EmptyState
        title="Mods only"
        body={`The mod console for c/${slug} is visible to its moderators and admins.`}
        testId="mod-forbidden"
      />
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="mod-console">
      <h1 className="font-display text-2xl font-bold">Moderate c/{slug}</h1>
      <div role="tablist" aria-label="Mod console sections" className="flex flex-wrap gap-2">
        {TABS.map((option) => (
          <button
            key={option.id}
            role="tab"
            aria-selected={tab === option.id}
            data-testid={`mod-tab-${option.id}`}
            onClick={() => setTab(option.id)}
            className={`min-h-11 rounded-full px-4 font-medium transition-colors ${
              tab === option.id
                ? "bg-accent text-accent-ink"
                : "bg-surface-sunken text-text-soft hover:text-text"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {tab === "queue" ? <QueueSection slug={slug} /> : null}
      {tab === "rules" ? <RulesSection slug={slug} /> : null}
      {tab === "requests" ? <RequestsSection slug={slug} /> : null}
      {tab === "lockdown" ? (
        <LockdownSection slug={slug} community={community} onChange={setCommunity} />
      ) : null}
      {tab === "log" ? <LogSection slug={slug} /> : null}
      {tab === "mail" ? <MailSection slug={slug} /> : null}
    </div>
  );
}

function useSection<T>(loader: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    setBusy(true);
    try {
      setData(await loader());
      setError(null);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
    // The loader closure is re-created by callers per render; reload is
    // intentionally mount-stable and sections call it explicitly after
    // mutations.
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, busy, reload, setData };
}

function QueueSection({ slug }: { slug: string }) {
  const { data, error, reload } = useSection(() =>
    api.listModQueue(slug, { kind: "all", limit: 50 }),
  );
  const [actionError, setActionError] = useState<string | null>(null);

  async function act(item: ModQueueItemView, action: "approve_post" | "remove_post") {
    if (!item.post) return;
    setActionError(null);
    try {
      await api.modAction(slug, {
        action,
        targetType: "post",
        targetId: item.post.id,
      });
      await reload();
    } catch (cause) {
      setActionError(
        cause instanceof GGApiError ? cause.detail : "That action didn't go through.",
      );
    }
  }

  async function resolve(item: ModQueueItemView, status: "actioned" | "dismissed") {
    setActionError(null);
    try {
      await api.resolveReport(item.report.id, { status });
      await reload();
    } catch (cause) {
      setActionError(
        cause instanceof GGApiError ? cause.detail : "Couldn't resolve that report.",
      );
    }
  }

  if (error) return <ApiErrorState error={error} />;
  if (!data) return <FeedSkeleton count={2} />;
  if (data.items.length === 0) {
    return (
      <EmptyState
        title="Queue is clear"
        body="No reports or held posts need attention."
        testId="mod-queue-empty"
      />
    );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="mod-queue">
      {actionError ? (
        <p role="alert" className="rounded-md bg-surface-sunken px-3 py-2 text-sm text-danger">
          {actionError}
        </p>
      ) : null}
      {data.items.map((item) => (
        <article
          key={item.id}
          data-testid={item.kind === "held" ? "mod-queue-held" : "mod-queue-report"}
          className="rounded-lg border border-border bg-surface p-4"
        >
          <p className="text-sm text-text-muted">
            {item.kind === "held" ? (
              <>
                Held by AutoMod
                {item.automodRule ? (
                  <>
                    {" "}· rule{" "}
                    <strong className="text-text">
                      {item.automodRule.kind} → {item.automodRule.action}
                    </strong>
                    {item.automodRule.detail ? <> · {item.automodRule.detail}</> : null}
                  </>
                ) : null}
              </>
            ) : (
              <>Report · {item.report.reason}</>
            )}{" "}
            · severity {item.severity} · {new Date(item.createdAt).toLocaleString("en-CA")}
          </p>
          {item.post ? (
            <p className="mt-2 whitespace-pre-wrap">
              {item.post.title ? <strong>{item.post.title} — </strong> : null}
              {item.post.body.slice(0, 280)}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {item.kind === "held" && item.post ? (
              <>
                <Button onClick={() => void act(item, "approve_post")} data-testid="mod-approve-held">
                  Approve post
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void act(item, "remove_post")}
                  data-testid="mod-remove-held"
                >
                  Remove post
                </Button>
              </>
            ) : null}
            {item.kind === "report" ? (
              <>
                <Button onClick={() => void resolve(item, "actioned")}>Mark actioned</Button>
                <Button variant="ghost" onClick={() => void resolve(item, "dismissed")}>
                  Dismiss
                </Button>
              </>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}

function RulesSection({ slug }: { slug: string }) {
  const { data, error, reload } = useSection(() => api.listAutomodRules(slug));
  const [kind, setKind] = useState<AutomodKind>("keyword");
  const [config, setConfig] = useState('{"keywords": [""]}');
  const [action, setAction] = useState<"flag" | "hold" | "remove">("hold");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function create() {
    setFormError(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(config) as Record<string, unknown>;
    } catch {
      setFormError("Config must be valid JSON.");
      return;
    }
    setSaving(true);
    try {
      await api.createAutomodRule(slug, { kind, config: parsed, action });
      await reload();
    } catch (cause) {
      setFormError(cause instanceof GGApiError ? cause.detail : "Couldn't create the rule.");
    } finally {
      setSaving(false);
    }
  }

  async function toggle(rule: AutomodRuleView) {
    await api.updateAutomodRule(slug, rule.id, { isEnabled: !rule.isEnabled });
    await reload();
  }

  async function remove(rule: AutomodRuleView) {
    await api.deleteAutomodRule(slug, rule.id);
    await reload();
  }

  if (error) return <ApiErrorState error={error} />;
  if (!data) return <FeedSkeleton count={2} />;
  return (
    <div className="flex flex-col gap-4" data-testid="mod-rules">
      {data.length === 0 ? (
        <EmptyState
          title="No AutoMod rules"
          body="Rules evaluate every new post and reply in this community."
          testId="mod-rules-empty"
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {data.map((rule) => (
            <li
              key={rule.id}
              data-testid="mod-rule"
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-4"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {rule.kind} → {rule.action}
                </p>
                <p className="text-sm text-text-muted">
                  {rule.isEnabled ? "enabled" : "disabled"} ·{" "}
                  <span className="font-mono">{JSON.stringify(rule.config)}</span>
                </p>
              </div>
              <Button variant="ghost" onClick={() => void toggle(rule)}>
                {rule.isEnabled ? "Disable" : "Enable"}
              </Button>
              <Button variant="ghost" onClick={() => void remove(rule)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <h2 className="font-display text-base font-semibold">New rule</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="rule-kind" className={labelClassName}>
              Kind
            </label>
            <select
              id="rule-kind"
              value={kind}
              onChange={(event) => {
                const next = event.target.value as AutomodKind;
                setKind(next);
                setConfig(RULE_KINDS.find((k) => k.id === next)?.hint ?? "{}");
              }}
              className={inputClassName}
              data-testid="rule-kind"
            >
              {RULE_KINDS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.id}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="rule-action" className={labelClassName}>
              Action
            </label>
            <select
              id="rule-action"
              value={action}
              onChange={(event) => setAction(event.target.value as typeof action)}
              className={inputClassName}
              data-testid="rule-action"
            >
              <option value="flag">flag (queue only)</option>
              <option value="hold">hold (hide until approved)</option>
              <option value="remove">remove</option>
            </select>
          </div>
        </div>
        <div>
          <label htmlFor="rule-config" className={labelClassName}>
            Config (JSON)
          </label>
          <textarea
            id="rule-config"
            value={config}
            onChange={(event) => setConfig(event.target.value)}
            className={`${inputClassName} font-mono`}
            rows={2}
            data-testid="rule-config"
          />
        </div>
        {formError ? (
          <p role="alert" className="rounded-md bg-surface-sunken px-3 py-2 text-sm text-danger">
            {formError}
          </p>
        ) : null}
        <div>
          <Button type="submit" disabled={saving} data-testid="rule-create">
            {saving ? "Saving…" : "Create rule"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function RequestsSection({ slug }: { slug: string }) {
  const { data, error, reload } = useSection(() =>
    api.listMembershipRequests(slug, { limit: 50 }),
  );
  if (error) return <ApiErrorState error={error} />;
  if (!data) return <FeedSkeleton count={2} />;
  if (data.items.length === 0) {
    return (
      <EmptyState title="No pending requests" body="Membership requests land here." testId="mod-requests-empty" />
    );
  }
  async function decide(request: MembershipRequestView, decision: "approve" | "reject") {
    await api.decideMembershipRequest(slug, request.user.handle, { decision });
    await reload();
  }
  return (
    <ul className="flex flex-col gap-2" data-testid="mod-requests">
      {data.items.map((request) => (
        <li
          key={request.id}
          className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-4"
        >
          <p className="flex-1 font-medium">@{request.user.handle}</p>
          <Button onClick={() => void decide(request, "approve")}>Approve</Button>
          <Button variant="ghost" onClick={() => void decide(request, "reject")}>
            Reject
          </Button>
        </li>
      ))}
    </ul>
  );
}

function LockdownSection({
  slug,
  community,
  onChange,
}: {
  slug: string;
  community: CommunityView;
  onChange: (community: CommunityView) => void;
}) {
  const [minAge, setMinAge] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setLockdown(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      const next = await api.setLockdown(slug, {
        enabled,
        minMemberAgeDays: minAge ? Number(minAge) : undefined,
      });
      onChange(next);
    } catch (cause) {
      setError(cause instanceof GGApiError ? cause.detail : "Couldn't change the lockdown.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-4" data-testid="mod-lockdown">
      <h2 className="font-display text-base font-semibold">
        Lockdown is {community.lockdownActive ? "ON" : "off"}
      </h2>
      <p className="mt-1 text-sm text-text-muted">
        While on, only moderators and members who joined before the lockdown can post.
        Optionally require a minimum membership age for everyone else once it lifts.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="lockdown-min-age" className={labelClassName}>
            Min member age (days, optional)
          </label>
          <input
            id="lockdown-min-age"
            type="number"
            min={0}
            value={minAge}
            onChange={(event) => setMinAge(event.target.value)}
            className={inputClassName}
            data-testid="lockdown-min-age"
          />
        </div>
        {community.lockdownActive ? (
          <Button variant="ghost" disabled={busy} onClick={() => void setLockdown(false)} data-testid="lockdown-off">
            Lift lockdown
          </Button>
        ) : (
          <Button disabled={busy} onClick={() => void setLockdown(true)} data-testid="lockdown-on">
            Start lockdown
          </Button>
        )}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function LogSection({ slug }: { slug: string }) {
  const { data, error } = useSection(() => api.listModLog(slug, { limit: 50 }));
  if (error) return <ApiErrorState error={error} />;
  if (!data) return <FeedSkeleton count={2} />;
  if (data.items.length === 0) {
    return <EmptyState title="No mod actions yet" body="Actions taken here are logged." testId="mod-log-empty" />;
  }
  return (
    <ul className="flex flex-col gap-2" data-testid="mod-log">
      {data.items.map((entry: ModActionView) => (
        <li key={entry.id} className="rounded-lg border border-border bg-surface p-3 text-sm">
          <strong>{entry.action}</strong>
          {entry.targetType ? <> on {entry.targetType}</> : null}
          {entry.note ? <> — {entry.note}</> : null}{" "}
          <span className="text-text-muted">
            · {new Date(entry.createdAt).toLocaleString("en-CA")}
          </span>
        </li>
      ))}
    </ul>
  );
}

function MailSection({ slug }: { slug: string }) {
  const { data, error } = useSection(() => api.listModMailThreads(slug, { limit: 50 }));
  if (error) return <ApiErrorState error={error} />;
  if (!data) return <FeedSkeleton count={2} />;
  if (data.items.length === 0) {
    return (
      <EmptyState
        title="No mod mail yet"
        body="Members can reach the mod team from the community page; threads appear here."
        testId="mod-mail-empty"
      />
    );
  }
  return (
    <ul className="flex flex-col gap-2" data-testid="mod-mail-list">
      {data.items.map((thread: ConversationView) => (
        <li key={thread.id} className="rounded-lg border border-border bg-surface p-3">
          <Link href={`/messages/${thread.id}`} className="font-medium text-link hover:underline">
            Mod mail thread
          </Link>
          <span className="text-sm text-text-muted">
            {" "}· {thread.participants.map((p) => `@${p.handle}`).join(", ")}
          </span>
        </li>
      ))}
    </ul>
  );
}
