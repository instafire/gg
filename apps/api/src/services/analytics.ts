/**
 * Platform analytics aggregates (Phase 5B) — read-only SQL over the
 * events log + domain tables, for the platform-admin dashboard.
 *
 * Honesty notes:
 * - DAU series come from the `events` table, which only has rows since
 *   Phase 5B instrumentation landed; days before that report the users
 *   whose `last_seen_at` falls on them (only "today" can benefit — the
 *   column holds just the latest sighting). Empty days are real zeroes
 *   for the instrumented era and "no data" before it; the dashboard
 *   renders what it is given without backfilling fiction.
 * - Mind-change rate is the mean of debates.mind_change_rate over
 *   debates closed in the window that had an audience (rate is null
 *   when nobody voted stance pre/post).
 */
import { sql } from "drizzle-orm";
import type { Db } from "../db";

export interface DayCount {
  date: string;
  count: number;
}

export interface AnalyticsOverview {
  window_days: number;
  generated_at: string;
  dau: DayCount[];
  mau: number;
  dau_today: number;
  new_users: DayCount[];
  posts_per_day: DayCount[];
  totals: {
    users: number;
    posts: number;
    comments: number;
    debates: number;
    polls: number;
    reports: number;
    dms: number;
  };
  debates: {
    created: number;
    completed: number;
    completion_rate: number | null;
    mind_change_rate: number | null;
    mind_changed_count: number;
  };
  moderation: {
    reports: number;
    reports_per_100_posts: number | null;
    resolved: number;
    avg_time_to_moderation_seconds: number | null;
  };
  activity_split: {
    human_events: number;
    agent_events: number;
    human_posts: number;
    agent_posts: number;
  };
}

interface Row {
  [key: string]: unknown;
}

function dayCounts(rows: Row[], key: string): DayCount[] {
  return rows.map((r) => ({
    date: String(r.date),
    count: Number(r[key] ?? 0),
  }));
}

export async function computeAnalytics(
  db: Db,
  windowDays: number,
): Promise<AnalyticsOverview> {
  const days = Math.min(Math.max(Math.trunc(windowDays) || 30, 1), 90);
  const since = sql`now() - (${days} || ' days')::interval`;
  /** Day-series start: exactly `days` calendar buckets ending today. */
  const seriesStart = sql`date_trunc('day', now()) - ((${days} - 1) || ' days')::interval`;

  const [dauRows, mauRows, newUserRows, postRows, totalsRows, debateRows, modRows, splitRows] =
    await Promise.all([
      db.execute(sql`
        select to_char(d.day, 'YYYY-MM-DD') as date,
               coalesce(e.users, 0)::int as count
        from generate_series(${seriesStart}, date_trunc('day', now()), interval '1 day') as d(day)
        left join (
          select date_trunc('day', created_at) as day, count(distinct user_id) as users
          from events where created_at >= ${seriesStart} and user_id is not null
          group by 1
        ) e on e.day = d.day
        order by d.day`),
      db.execute(sql`
        select (
          select count(distinct user_id) from events
            where created_at >= now() - interval '30 days' and user_id is not null
        ) + (
          select count(*) from users u
            where u.last_seen_at >= now() - interval '30 days'
              and not exists (
                select 1 from events e
                where e.user_id = u.id and e.created_at >= now() - interval '30 days'
              )
        ) as mau`),
      db.execute(sql`
        select to_char(d.day, 'YYYY-MM-DD') as date,
               coalesce(n.users, 0)::int as count
        from generate_series(${seriesStart}, date_trunc('day', now()), interval '1 day') as d(day)
        left join (
          select date_trunc('day', created_at) as day, count(*) as users
          from users where created_at >= ${seriesStart} and deleted_at is null
          group by 1
        ) n on n.day = d.day
        order by d.day`),
      db.execute(sql`
        select to_char(d.day, 'YYYY-MM-DD') as date,
               coalesce(p.posts, 0)::int as count
        from generate_series(${seriesStart}, date_trunc('day', now()), interval '1 day') as d(day)
        left join (
          select date_trunc('day', created_at) as day, count(*) as posts
          from posts where created_at >= ${seriesStart} and parent_id is null and deleted_at is null
          group by 1
        ) p on p.day = d.day
        order by d.day`),
      db.execute(sql`
        select
          (select count(*) from users where deleted_at is null) as users,
          (select count(*) from posts where parent_id is null and deleted_at is null and created_at >= ${since}) as posts,
          (select count(*) from posts where parent_id is not null and deleted_at is null and created_at >= ${since}) as comments,
          (select count(*) from debates where created_at >= ${since}) as debates,
          (select count(*) from polls where created_at >= ${since}) as polls,
          (select count(*) from reports where created_at >= ${since}) as reports,
          (select count(*) from events where type = 'dm.sent' and created_at >= ${since}) as dms`),
      db.execute(sql`
        select
          count(*)::int as created,
          count(*) filter (where status in ('closed', 'archived'))::int as completed,
          coalesce(avg(mind_change_rate) filter (where status in ('closed', 'archived') and mind_change_rate is not null), null) as mind_change_rate,
          coalesce(sum(mind_changed_count) filter (where status in ('closed', 'archived')), 0)::int as mind_changed
        from debates where created_at >= ${since}`),
      db.execute(sql`
        select
          count(*)::int as reports,
          count(*) filter (where resolved_at is not null)::int as resolved,
          avg(extract(epoch from (resolved_at - created_at))) filter (where resolved_at is not null) as avg_seconds
        from reports where created_at >= ${since}`),
      db.execute(sql`
        select
          count(*) filter (where u.author_type = 'human')::int as human_events,
          count(*) filter (where u.author_type = 'agent')::int as agent_events,
          (select count(*) from posts p join users pu on pu.id = p.author_id
             where pu.author_type = 'human' and p.created_at >= ${since} and p.deleted_at is null)::int as human_posts,
          (select count(*) from posts p join users pu on pu.id = p.author_id
             where pu.author_type = 'agent' and p.created_at >= ${since} and p.deleted_at is null)::int as agent_posts
        from events e left join users u on u.id = e.user_id
        where e.created_at >= ${since}`),
    ]);

  const totals = (totalsRows as unknown as Row[])[0] ?? {};
  const debatesRow = (debateRows as unknown as Row[])[0] ?? {};
  const modRow = (modRows as unknown as Row[])[0] ?? {};
  const splitRow = (splitRows as unknown as Row[])[0] ?? {};
  const mau = Number((mauRows as unknown as Row[])[0]?.mau ?? 0);
  const dau = dayCounts(dauRows as unknown as Row[], "count");
  const postsTotal = Number(totals.posts ?? 0);
  const reportsTotal = Number(modRow.reports ?? 0);
  const debatesCreated = Number(debatesRow.created ?? 0);
  const debatesCompleted = Number(debatesRow.completed ?? 0);

  return {
    window_days: days,
    generated_at: new Date().toISOString(),
    dau,
    mau,
    dau_today: dau.length > 0 ? dau[dau.length - 1]!.count : 0,
    new_users: dayCounts(newUserRows as unknown as Row[], "count"),
    posts_per_day: dayCounts(postRows as unknown as Row[], "count"),
    totals: {
      users: Number(totals.users ?? 0),
      posts: postsTotal,
      comments: Number(totals.comments ?? 0),
      debates: Number(totals.debates ?? 0),
      polls: Number(totals.polls ?? 0),
      reports: Number(totals.reports ?? 0),
      dms: Number(totals.dms ?? 0),
    },
    debates: {
      created: debatesCreated,
      completed: debatesCompleted,
      completion_rate:
        debatesCreated > 0 ? debatesCompleted / debatesCreated : null,
      mind_change_rate:
        debatesRow.mind_change_rate == null
          ? null
          : Number(debatesRow.mind_change_rate),
      mind_changed_count: Number(debatesRow.mind_changed ?? 0),
    },
    moderation: {
      reports: reportsTotal,
      reports_per_100_posts:
        postsTotal > 0 ? (reportsTotal / postsTotal) * 100 : null,
      resolved: Number(modRow.resolved ?? 0),
      avg_time_to_moderation_seconds:
        modRow.avg_seconds == null ? null : Number(modRow.avg_seconds),
    },
    activity_split: {
      human_events: Number(splitRow.human_events ?? 0),
      agent_events: Number(splitRow.agent_events ?? 0),
      human_posts: Number(splitRow.human_posts ?? 0),
      agent_posts: Number(splitRow.agent_posts ?? 0),
    },
  };
}
