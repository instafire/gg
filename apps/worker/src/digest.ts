/**
 * Email digests (Phase 5B) — queue `gg-notify`, jobs `digest.daily` /
 * `digest.weekly`. For each user whose digest_frequency matches and
 * whose email is verified: build a digest from (a) top posts in the
 * communities they belong to, (b) the latest Daily Pulse result,
 * (c) recently closed debates with mind-change data. A digest with no
 * content at all is not sent (logged with item_count 0 instead).
 * Sends go through the WorkerMailer adapter (LogMailer on staging) and
 * are recorded in digest_logs — one row per (user, frequency, period),
 * which also makes re-runs idempotent.
 */
import { and, desc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import type { WorkerDb } from "./db";
import {
  communitiesTable,
  communityMembersTable,
  debatesTable,
  digestLogsTable,
  pollOptionsTable,
  pollsTable,
  pollVotesTable,
  postsTable,
  userSettingsTable,
  usersContactTable,
  usersTable,
} from "./db";
import type { WorkerMailer } from "./mailer";

export const DIGEST_DAILY_JOB = "digest.daily";
export const DIGEST_WEEKLY_JOB = "digest.weekly";

export interface DigestPost {
  shortCode: string | null;
  title: string | null;
  excerpt: string;
  authorHandle: string;
  communitySlug: string | null;
  score: number;
}

export interface DigestPulse {
  question: string;
  pulseDate: string | null;
  leadingOption: string | null;
  totalVotes: number;
}

export interface DigestDebate {
  proposition: string;
  mindChangeRate: number | null;
  mindChangedCount: number;
}

export interface DigestContent {
  posts: DigestPost[];
  pulse: DigestPulse | null;
  debates: DigestDebate[];
}

export interface DigestUser {
  id: string;
  email: string;
  handle: string;
}

export interface DigestRepo {
  listDigestUsers(frequency: string): Promise<DigestUser[]>;
  topCommunityPosts(userId: string, since: Date, limit: number): Promise<DigestPost[]>;
  latestPulse(): Promise<DigestPulse | null>;
  recentDebates(since: Date, limit: number): Promise<DigestDebate[]>;
  hasDigestLog(userId: string, frequency: string, periodKey: string): Promise<boolean>;
  recordDigestLog(userId: string, frequency: string, periodKey: string, itemCount: number): Promise<void>;
}

function excerptOf(bodyMd: string | null, max = 140): string {
  const text = (bodyMd ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function drizzleDigestRepo(db: WorkerDb): DigestRepo {
  return {
    async listDigestUsers(frequency) {
      const rows = await db
        .select({
          id: usersContactTable.id,
          email: usersContactTable.email,
          handle: usersContactTable.handle,
        })
        .from(userSettingsTable)
        .innerJoin(usersContactTable, eq(usersContactTable.id, userSettingsTable.userId))
        .where(
          and(
            eq(userSettingsTable.digestFrequency, frequency),
            isNotNull(usersContactTable.email),
            isNotNull(usersContactTable.emailVerifiedAt),
          ),
        );
      return rows
        .filter((r): r is DigestUser => typeof r.email === "string" && r.email.length > 0)
        .map((r) => ({ id: r.id, email: r.email, handle: r.handle }));
    },
    async topCommunityPosts(userId, since, limit) {
      const rows = await db
        .select({
          shortCode: postsTable.shortCode,
          title: postsTable.title,
          bodyMd: postsTable.bodyMd,
          score: postsTable.score,
          authorHandle: usersTable.handle,
          communitySlug: communitiesTable.slug,
        })
        .from(postsTable)
        .innerJoin(
          communityMembersTable,
          and(
            eq(communityMembersTable.communityId, postsTable.communityId),
            eq(communityMembersTable.userId, userId),
            eq(communityMembersTable.status, "active"),
          ),
        )
        .innerJoin(usersTable, eq(usersTable.id, postsTable.authorId))
        .leftJoin(communitiesTable, eq(communitiesTable.id, postsTable.communityId))
        .where(
          and(
            isNull(postsTable.parentId),
            isNull(postsTable.deletedAt),
            isNull(postsTable.heldAt),
            gt(postsTable.createdAt, since),
          ),
        )
        .orderBy(desc(postsTable.score), desc(postsTable.createdAt))
        .limit(limit);
      return rows.map((r) => ({
        shortCode: r.shortCode,
        title: r.title,
        excerpt: excerptOf(r.bodyMd),
        authorHandle: r.authorHandle,
        communitySlug: r.communitySlug,
        score: Math.round(r.score ?? 0),
      }));
    },
    async latestPulse() {
      const [poll] = await db
        .select()
        .from(pollsTable)
        .where(eq(pollsTable.isDailyPulse, true))
        .orderBy(desc(pollsTable.pulseDate))
        .limit(1);
      if (!poll) return null;
      const [options, votes] = await Promise.all([
        db
          .select()
          .from(pollOptionsTable)
          .where(eq(pollOptionsTable.pollId, poll.id)),
        db
          .select({ optionId: pollVotesTable.optionId })
          .from(pollVotesTable)
          .where(and(eq(pollVotesTable.pollId, poll.id), isNull(pollVotesTable.voidedAt))),
      ]);
      const counts = new Map<string, number>();
      for (const vote of votes) {
        if (vote.optionId) counts.set(vote.optionId, (counts.get(vote.optionId) ?? 0) + 1);
      }
      let leading: string | null = null;
      let best = 0;
      for (const option of options) {
        const count = counts.get(option.id) ?? 0;
        if (count > best) {
          best = count;
          leading = option.text;
        }
      }
      return {
        question: poll.question,
        pulseDate: poll.pulseDate,
        leadingOption: leading,
        totalVotes: votes.length,
      };
    },
    async recentDebates(since, limit) {
      const rows = await db
        .select({
          proposition: debatesTable.proposition,
          mindChangeRate: debatesTable.mindChangeRate,
          mindChangedCount: debatesTable.mindChangedCount,
        })
        .from(debatesTable)
        .where(
          and(
            eq(debatesTable.status, "closed"),
            gt(debatesTable.closedAt, since),
          ),
        )
        .orderBy(desc(debatesTable.mindChangedCount), desc(debatesTable.closedAt))
        .limit(limit);
      return rows
        .filter((r) => typeof r.proposition === "string")
        .map((r) => ({
          proposition: r.proposition as string,
          mindChangeRate: r.mindChangeRate,
          mindChangedCount: r.mindChangedCount,
        }));
    },
    async hasDigestLog(userId, frequency, periodKey) {
      const [row] = await db
        .select({ id: digestLogsTable.id })
        .from(digestLogsTable)
        .where(
          and(
            eq(digestLogsTable.userId, userId),
            eq(digestLogsTable.frequency, frequency),
            eq(digestLogsTable.periodKey, periodKey),
          ),
        )
        .limit(1);
      return Boolean(row);
    },
    async recordDigestLog(userId, frequency, periodKey, itemCount) {
      await db
        .insert(digestLogsTable)
        .values({
          id: crypto.randomUUID(),
          userId,
          frequency,
          periodKey,
          itemCount,
          sentAt: new Date(),
        })
        .onConflictDoNothing();
    },
  };
}

export async function buildDigest(
  repo: DigestRepo,
  userId: string,
  frequency: "daily" | "weekly",
  now: Date,
): Promise<DigestContent> {
  const windowMs = (frequency === "daily" ? 24 : 7 * 24) * 3600_000;
  const since = new Date(now.getTime() - windowMs);
  const [posts, pulse, debates] = await Promise.all([
    repo.topCommunityPosts(userId, since, 5),
    repo.latestPulse(),
    repo.recentDebates(since, 3),
  ]);
  return { posts, pulse, debates };
}

export function digestItemCount(content: DigestContent): number {
  return (
    content.posts.length +
    (content.pulse ? 1 : 0) +
    content.debates.length
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render a digest to a self-contained email HTML document. */
export function renderDigestHtml(
  content: DigestContent,
  opts: { frequency: "daily" | "weekly"; appBaseUrl: string; handle: string },
): string {
  const base = opts.appBaseUrl.replace(/\/+$/, "");
  const postItems = content.posts
    .map((post) => {
      const href = post.shortCode ? `${base}/post/${post.shortCode}` : base;
      const where = post.communitySlug ? ` in g/${escapeHtml(post.communitySlug)}` : "";
      const heading = escapeHtml(post.title ?? post.excerpt.slice(0, 80));
      return `<li style="margin:0 0 14px"><a href="${href}" style="color:#111827;font-weight:600;text-decoration:none">${heading}</a><br><span style="color:#6b7280;font-size:13px">@${escapeHtml(post.authorHandle)}${where} · score ${post.score}</span><br><span style="color:#374151">${escapeHtml(post.excerpt)}</span></li>`;
    })
    .join("");
  const pulseBlock = content.pulse
    ? `<h2 style="font-size:16px;margin:24px 0 8px">Daily Pulse</h2><p style="margin:0;color:#374151">${escapeHtml(content.pulse.question)}${
        content.pulse.leadingOption
          ? `<br>Leading: <strong>${escapeHtml(content.pulse.leadingOption)}</strong> · ${content.pulse.totalVotes} votes`
          : `<br>${content.pulse.totalVotes} votes so far`
      }</p>`
    : "";
  const debateItems = content.debates
    .map(
      (debate) =>
        `<li style="margin:0 0 10px"><strong>${escapeHtml(debate.proposition)}</strong><br><span style="color:#6b7280;font-size:13px">${debate.mindChangedCount} minds changed${
          debate.mindChangeRate != null
            ? ` (${Math.round(debate.mindChangeRate * 100)}% of the audience)`
            : ""
        }</span></li>`,
    )
    .join("");
  return `<!doctype html><html><body style="font-family:Inter,system-ui,sans-serif;background:#ffffff;color:#111827;margin:0;padding:24px">
<div style="max-width:560px;margin:0 auto">
<h1 style="font-family:'Space Grotesk',Inter,sans-serif;font-size:22px;margin:0 0 4px">Your ${opts.frequency} GG digest</h1>
<p style="color:#6b7280;margin:0 0 16px">Hi @${escapeHtml(opts.handle)} — here's what moved on GG.</p>
<h2 style="font-size:16px;margin:16px 0 8px">Top posts from your communities</h2>
<ul style="list-style:none;padding:0;margin:0">${postItems || "<li>No posts yet in this window.</li>"}</ul>
${pulseBlock}
${debateItems ? `<h2 style="font-size:16px;margin:24px 0 8px">Debate highlights</h2><ul style="list-style:none;padding:0;margin:0">${debateItems}</ul>` : ""}
<p style="color:#9ca3af;font-size:12px;margin-top:32px">You receive this because your GG digest setting is "${opts.frequency}". Change it any time in Settings → Notifications.</p>
</div></body></html>`;
}

/** Toronto-local period key: daily `YYYY-MM-DD`, weekly `YYYY-Www` (ISO). */
export function digestPeriodKey(frequency: "daily" | "weekly", now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  if (frequency === "daily") {
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      (date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600_000) -
        ((firstThursday.getUTCDay() + 6) % 7) / 7,
    );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export interface DigestRunResult {
  users: number;
  sent: number;
  empty: number;
  alreadySent: number;
}

export async function runDigest(
  repo: DigestRepo,
  mailer: WorkerMailer,
  frequency: "daily" | "weekly",
  now: Date,
  appBaseUrl: string,
): Promise<DigestRunResult> {
  const users = await repo.listDigestUsers(frequency);
  const periodKey = digestPeriodKey(frequency, now);
  const result: DigestRunResult = { users: users.length, sent: 0, empty: 0, alreadySent: 0 };
  for (const user of users) {
    if (await repo.hasDigestLog(user.id, frequency, periodKey)) {
      result.alreadySent += 1;
      continue;
    }
    const content = await buildDigest(repo, user.id, frequency, now);
    const count = digestItemCount(content);
    if (count === 0) {
      await repo.recordDigestLog(user.id, frequency, periodKey, 0);
      result.empty += 1;
      continue;
    }
    const html = renderDigestHtml(content, { frequency, appBaseUrl, handle: user.handle });
    await mailer.sendDigestEmail(
      user.email,
      frequency === "daily" ? "Your daily GG digest" : "Your weekly GG digest",
      html,
    );
    await repo.recordDigestLog(user.id, frequency, periodKey, count);
    result.sent += 1;
  }
  return result;
}
