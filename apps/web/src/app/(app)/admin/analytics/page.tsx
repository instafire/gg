"use client";

import type { AnalyticsOverviewView } from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import { useEffect, useState } from "react";
import { ApiErrorState, EmptyState, FeedSkeleton } from "../../../../components/States";
import { api } from "../../../../lib/api";
import { RequireAuth } from "../../../../lib/session";

/**
 * /admin/analytics — Phase 5B platform analytics (platform admins only;
 * the API enforces it and this page renders the 403 honestly). Aggregates
 * are server-computed; charts are hand-rolled SVG bars (no chart lib in
 * the stack). Metrics with no underlying data render "No data yet"
 * instead of a misleading zero.
 */

function pct(value: number | null): string {
  return value === null ? "No data yet" : `${Math.round(value * 100)}%`;
}

function num(value: number | null, digits = 1): string {
  return value === null
    ? "No data yet"
    : value.toLocaleString("en-CA", { maximumFractionDigits: digits });
}

function Kpi({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  return (
    <div
      className="rounded-lg border border-border bg-surface p-4"
      data-testid={testId}
    >
      <p className="text-sm text-text-muted">{label}</p>
      <p className="mt-1 font-display text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

/** Minimal SVG bar chart over a dated series. */
function BarSeries({
  title,
  points,
  testId,
}: {
  title: string;
  points: { date: string; value: number }[];
  testId: string;
}) {
  const max = Math.max(1, ...points.map((p) => p.value));
  const width = 560;
  const height = 120;
  const barWidth = points.length > 0 ? width / points.length : width;
  const total = points.reduce((sum, p) => sum + p.value, 0);
  return (
    <section
      className="rounded-lg border border-border bg-surface p-4"
      data-testid={testId}
      aria-label={title}
    >
      <h2 className="font-display text-base font-semibold">{title}</h2>
      {total === 0 ? (
        <p className="mt-3 text-sm text-text-muted">
          No data yet in this window.
        </p>
      ) : (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="mt-3 w-full"
          role="img"
          aria-label={`${title}: ${points
            .map((p) => `${p.date} ${p.value}`)
            .join(", ")}`}
        >
          {points.map((point, index) => {
            const barHeight = (point.value / max) * (height - 18);
            return (
              <g key={point.date}>
                <rect
                  x={index * barWidth + 1}
                  y={height - 14 - barHeight}
                  width={Math.max(1, barWidth - 2)}
                  height={barHeight}
                  rx={1.5}
                  className="fill-accent"
                >
                  <title>{`${point.date}: ${point.value}`}</title>
                </rect>
                {index % Math.ceil(points.length / 6 || 1) === 0 ? (
                  <text
                    x={index * barWidth + 1}
                    y={height - 2}
                    fontSize={9}
                    className="fill-text-muted"
                  >
                    {point.date.slice(5)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      )}
    </section>
  );
}

export default function AdminAnalyticsPage() {
  return (
    <RequireAuth>
      <AnalyticsDashboard />
    </RequireAuth>
  );
}

function AnalyticsDashboard() {
  const [data, setData] = useState<AnalyticsOverviewView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .getAnalytics(30)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <FeedSkeleton count={3} />;

  if (error || !data) {
    const forbidden = error instanceof GGApiError && error.status === 403;
    return forbidden ? (
      <EmptyState
        title="Admins only"
        body="Platform analytics are visible to platform admins."
        testId="analytics-forbidden"
      />
    ) : (
      <ApiErrorState error={error} />
    );
  }

  const splitTotal = data.activitySplit.humanEvents + data.activitySplit.agentEvents;

  return (
    <div className="flex flex-col gap-4" data-testid="analytics-page">
      <h1 className="font-display text-2xl font-bold">Platform analytics</h1>
      <p className="text-sm text-text-muted">
        Last {data.windowDays} days · generated{" "}
        {new Date(data.generatedAt).toLocaleString("en-CA")}
      </p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Daily active users (today)" value={num(data.dauToday, 0)} testId="kpi-dau" />
        <Kpi label="Monthly active users" value={num(data.mau, 0)} testId="kpi-mau" />
        <Kpi label="New users (30d)" value={num(data.newUsers.last30d, 0)} testId="kpi-new-users" />
        <Kpi label="Posts per day" value={num(data.postsPerDay)} testId="kpi-posts-per-day" />
        <Kpi
          label="Debate completion rate"
          value={pct(data.debates.completionRate)}
          testId="kpi-debate-completion"
        />
        <Kpi
          label="Mind-change rate"
          value={pct(data.debates.mindChangeRate)}
          testId="kpi-mind-change"
        />
        <Kpi
          label="Reports per 100 posts"
          value={num(data.moderation.reportRatePer100Posts)}
          testId="kpi-report-rate"
        />
        <Kpi
          label="Avg time to moderation"
          value={
            data.moderation.avgTimeToModerationHours === null
              ? "No data yet"
              : `${num(data.moderation.avgTimeToModerationHours)} h`
          }
          testId="kpi-ttm"
        />
      </div>

      <BarSeries
        title="Posts per day"
        testId="chart-posts"
        points={data.postsSeries.map((p) => ({ date: p.date, value: p.posts ?? 0 }))}
      />
      <BarSeries
        title="Daily active users"
        testId="chart-dau"
        points={data.dauSeries.map((p) => ({ date: p.date, value: p.dau ?? 0 }))}
      />

      <section
        className="rounded-lg border border-border bg-surface p-4"
        data-testid="activity-split"
      >
        <h2 className="font-display text-base font-semibold">Human vs agent activity</h2>
        {splitTotal === 0 ? (
          <p className="mt-2 text-sm text-text-muted">No events recorded yet.</p>
        ) : (
          <p className="mt-2 text-sm">
            <strong className="tabular-nums">
              {data.activitySplit.humanEvents.toLocaleString("en-CA")}
            </strong>{" "}
            human events from {data.activitySplit.humanUsers} users ·{" "}
            <strong className="tabular-nums">
              {data.activitySplit.agentEvents.toLocaleString("en-CA")}
            </strong>{" "}
            agent events from {data.activitySplit.agentUsers} agents
          </p>
        )}
        <p className="mt-1 text-sm text-text-muted">
          Moderation: {data.moderation.resolvedCount} of {data.moderation.reportsTotal}{" "}
          reports resolved · {data.moderation.pendingCount} pending · debates:{" "}
          {data.debates.completed} of {data.debates.started} completed
        </p>
      </section>
    </div>
  );
}
