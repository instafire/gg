/**
 * Community moderation core (Phase 5B): mod-role checks, lockdown
 * enforcement, AutoMod rule evaluation + outcome application, and the
 * mod-action log writer shared by the mod routes.
 *
 * AutoMod semantics (D-057):
 * - Rules are community-scoped and evaluated in creation order; the FIRST
 *   matching enabled rule decides the outcome (flag | hold | remove).
 * - Every outcome writes an `automod_holds` row — the held half of the mod
 *   queue — citing the rule (id + kind snapshot + match evidence).
 * - `hold` sets posts.held_at (author-only visibility until resolved);
 *   `remove` soft-deletes the post; `flag` leaves the post untouched.
 * - The author is notified (type `mod_action`) for hold/remove outcomes.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db";
import {
  automodHolds,
  automodRules,
  communities,
  communityMembers,
  modActions,
  posts,
  users,
} from "../db/schema";
import type { CommunityRow, PostRow, UserRow } from "../lib/serializers";
import { forbidden } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { notify } from "./notifications";

export const MOD_ROLES = ["owner", "admin", "moderator"] as const;

export async function communityModRole(
  db: Db,
  communityId: string,
  userId: string,
): Promise<string | null> {
  const [membership] = await db
    .select({ role: communityMembers.role, status: communityMembers.status })
    .from(communityMembers)
    .where(
      and(
        eq(communityMembers.communityId, communityId),
        eq(communityMembers.userId, userId),
      ),
    )
    .limit(1);
  if (!membership || membership.status !== "active") return null;
  return (MOD_ROLES as readonly string[]).includes(membership.role)
    ? membership.role
    : null;
}

export async function isCommunityMod(
  db: Db,
  communityId: string,
  userId: string,
): Promise<boolean> {
  return (await communityModRole(db, communityId, userId)) !== null;
}

const TIER_RANK: Record<string, number> = { T0: 0, T1: 1, T2: 2, T3: 3 };

export interface LockdownPolicy {
  min_member_age_days?: number;
  min_trust_tier?: string;
}

export function lockdownPolicyOf(community: CommunityRow): LockdownPolicy {
  const settings = (community.settings ?? {}) as Record<string, unknown>;
  const policy = settings.lockdown;
  if (policy && typeof policy === "object") return policy as LockdownPolicy;
  return {};
}

/**
 * Lockdown gate for posting into a community (spec: POST lockdown —
 * "restrict posting to mods/existing members"). While lockdown is active:
 * - mods always post;
 * - members who joined AFTER lockdown began cannot post;
 * - optional policy floors apply: membership age (days since joining) and
 *   trust tier.
 * Non-lockdown communities return immediately. Throws 403 on violation.
 */
export async function assertLockdownAllowsPost(
  db: Db,
  community: CommunityRow,
  userId: string,
): Promise<void> {
  if (!community.lockdownAt) return;
  if (await isCommunityMod(db, community.id, userId)) return;
  const [membership] = await db
    .select()
    .from(communityMembers)
    .where(
      and(
        eq(communityMembers.communityId, community.id),
        eq(communityMembers.userId, userId),
      ),
    )
    .limit(1);
  if (!membership || membership.status !== "active") {
    throw forbidden("This community is in lockdown; only existing members can post");
  }
  if (membership.joinedAt.getTime() > community.lockdownAt.getTime()) {
    throw forbidden(
      "This community is in lockdown; members who joined after lockdown began cannot post yet",
    );
  }
  const policy = lockdownPolicyOf(community);
  if (policy.min_member_age_days != null) {
    const ageDays =
      (Date.now() - membership.joinedAt.getTime()) / (24 * 60 * 60 * 1000);
    if (ageDays < policy.min_member_age_days) {
      throw forbidden(
        `Lockdown: your membership is ${Math.floor(ageDays)}d old; ${policy.min_member_age_days}d required`,
      );
    }
  }
  if (policy.min_trust_tier) {
    const [user] = await db
      .select({ trustTier: users.trustTier })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const have = TIER_RANK[user?.trustTier ?? "T0"] ?? 0;
    const need = TIER_RANK[policy.min_trust_tier] ?? 0;
    if (have < need) {
      throw forbidden(
        `Lockdown: trust tier ${policy.min_trust_tier} or higher is required to post`,
      );
    }
  }
}

// ─── AutoMod ────────────────────────────────────────────────────────────────

export type AutomodAction = "flag" | "hold" | "remove";
export type AutomodRuleRow = typeof automodRules.$inferSelect;

export interface AutomodMatch {
  rule: AutomodRuleRow;
  detail: string;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

export function extractUrls(text: string): string[] {
  return text.match(URL_RE) ?? [];
}

export function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Author "karma" for karma_threshold rules: sum of live post scores. */
export async function authorKarma(db: Db, authorId: string): Promise<number> {
  const [row] = await db
    .select({ karma: sql<number>`coalesce(sum(${posts.score}), 0)::float` })
    .from(posts)
    .where(and(eq(posts.authorId, authorId), isNull(posts.deletedAt)));
  return row?.karma ?? 0;
}

/**
 * Test one rule against a post + author. Returns match evidence or null.
 * Pure given the author facts — exported for unit coverage of each kind.
 */
export function matchRule(
  rule: Pick<AutomodRuleRow, "kind" | "config">,
  post: Pick<PostRow, "title" | "bodyMd" | "linkUrl">,
  author: { createdAt: Date; trustTier: string; karma: number },
  now: Date = new Date(),
): string | null {
  const config = (rule.config ?? {}) as Record<string, unknown>;
  const haystack = `${post.title ?? ""}\n${post.bodyMd ?? ""}`;
  switch (rule.kind) {
    case "keyword": {
      const keywords = Array.isArray(config.keywords)
        ? config.keywords.map(String)
        : [];
      const lower = haystack.toLowerCase();
      for (const keyword of keywords) {
        if (keyword && lower.includes(keyword.toLowerCase())) {
          return `keyword "${keyword}"`;
        }
      }
      return null;
    }
    case "regex": {
      const pattern = typeof config.pattern === "string" ? config.pattern : "";
      if (!pattern || pattern.length > 200) return null;
      let re: RegExp;
      try {
        re = new RegExp(pattern, "i");
      } catch {
        return null;
      }
      const hit = re.exec(haystack);
      return hit ? `regex /${pattern}/ matched "${hit[0].slice(0, 40)}"` : null;
    }
    case "account_age": {
      const minDays = Number(config.min_account_age_days ?? config.min_age_days ?? 0);
      const ageDays = (now.getTime() - author.createdAt.getTime()) / 86_400_000;
      return ageDays < minDays
        ? `account age ${ageDays.toFixed(1)}d < ${minDays}d`
        : null;
    }
    case "karma_threshold": {
      const minKarma = Number(config.min_karma ?? 0);
      return author.karma < minKarma
        ? `karma ${Math.round(author.karma)} < ${minKarma}`
        : null;
    }
    case "trust_tier": {
      const minTier = String(config.min_trust_tier ?? "T1");
      const have = TIER_RANK[author.trustTier] ?? 0;
      const need = TIER_RANK[minTier] ?? 0;
      return have < need ? `trust tier ${author.trustTier} < ${minTier}` : null;
    }
    case "link_domain": {
      const domains = Array.isArray(config.domains)
        ? config.domains.map((d) => String(d).toLowerCase())
        : [];
      const urls = [...extractUrls(haystack), ...(post.linkUrl ? [post.linkUrl] : [])];
      for (const url of urls) {
        const host = hostnameOf(url);
        if (
          host &&
          domains.some((d) => host === d || host.endsWith(`.${d}`))
        ) {
          return `link domain ${host}`;
        }
      }
      return null;
    }
    case "link_count": {
      const maxLinks = Number(config.max_links ?? 0);
      const count =
        extractUrls(haystack).length + (post.linkUrl ? 1 : 0);
      return count > maxLinks ? `${count} links > ${maxLinks} allowed` : null;
    }
    default:
      return null;
  }
}

/** First matching enabled rule for the post's community, or null. */
export async function evaluateAutomod(
  db: Db,
  post: PostRow,
  author: UserRow,
): Promise<AutomodMatch | null> {
  if (!post.communityId) return null;
  const rules = await db
    .select()
    .from(automodRules)
    .where(
      and(
        eq(automodRules.communityId, post.communityId),
        eq(automodRules.isEnabled, true),
      ),
    )
    .orderBy(asc(automodRules.createdAt), asc(automodRules.id));
  if (rules.length === 0) return null;
  const needsKarma = rules.some((r) => r.kind === "karma_threshold");
  const karma = needsKarma ? await authorKarma(db, author.id) : 0;
  const facts = { createdAt: author.createdAt, trustTier: author.trustTier, karma };
  for (const rule of rules) {
    const detail = matchRule(rule, post, facts);
    if (detail) return { rule, detail };
  }
  return null;
}

export interface AutomodOutcome {
  action: AutomodAction;
  ruleId: string;
  ruleKind: string;
  detail: string;
  holdId: string;
}

/** Apply a matched rule: hold row + post state + author notification. */
export async function applyAutomodOutcome(
  db: Db,
  post: PostRow,
  match: AutomodMatch,
): Promise<AutomodOutcome> {
  const action = match.rule.action as AutomodAction;
  const holdId = uuidv7();
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(automodHolds).values({
      id: holdId,
      communityId: post.communityId!,
      postId: post.id,
      ruleId: match.rule.id,
      ruleKind: match.rule.kind,
      action,
      matchDetail: match.detail,
      status: action === "remove" ? "removed" : "pending",
      resolvedBy: action === "remove" ? null : null,
      resolvedAt: action === "remove" ? now : null,
    });
    if (action === "hold") {
      await tx.update(posts).set({ heldAt: now }).where(eq(posts.id, post.id));
    }
    if (action === "remove") {
      await tx
        .update(posts)
        .set({ deletedAt: now })
        .where(eq(posts.id, post.id));
      if (!post.parentId && post.communityId) {
        await tx
          .update(communities)
          .set({ postCount: sql`greatest(${communities.postCount} - 1, 0)` })
          .where(eq(communities.id, post.communityId));
      }
    }
  });
  if (action !== "flag" && post.authorId !== match.rule.createdBy) {
    await notify(db, {
      recipientId: post.authorId,
      type: "mod_action",
      actorId: null,
      subjectType: "post",
      subjectId: post.id,
      payload: {
        automod: action,
        rule_kind: match.rule.kind,
        detail: match.detail,
        community_id: post.communityId,
      },
    });
  }
  return {
    action,
    ruleId: match.rule.id,
    ruleKind: match.rule.kind,
    detail: match.detail,
    holdId,
  };
}

/** Evaluate + apply in one call (post-create hook). Never throws. */
export async function runAutomod(
  db: Db,
  post: PostRow,
  author: UserRow,
  log?: { error: (obj: unknown, msg: string) => void },
): Promise<AutomodOutcome | null> {
  try {
    const match = await evaluateAutomod(db, post, author);
    if (!match) return null;
    return await applyAutomodOutcome(db, post, match);
  } catch (error) {
    log?.error({ err: error, postId: post.id }, "automod evaluation failed");
    return null;
  }
}

// ─── Mod action log ─────────────────────────────────────────────────────────

export async function recordModAction(
  db: Db,
  input: {
    communityId: string;
    action: string;
    actorId: string;
    targetType: string;
    targetId: string;
    targetUserId?: string | null;
    reason?: string | null;
    durationHours?: number | null;
  },
): Promise<typeof modActions.$inferSelect> {
  const [row] = await db
    .insert(modActions)
    .values({
      id: uuidv7(),
      communityId: input.communityId,
      action: input.action,
      actorId: input.actorId,
      targetType: input.targetType,
      targetId: input.targetId,
      targetUserId: input.targetUserId ?? null,
      reason: input.reason ?? null,
      durationHours: input.durationHours ?? null,
    })
    .returning();
  return row!;
}
