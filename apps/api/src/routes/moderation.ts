/**
 * Community moderation surfaces (Phase 5B; API_SPEC Moderation tag):
 * AutoMod rule CRUD, lockdown, mod actions + log, membership requests,
 * and mod mail. The mod queue itself (reports + held) lives in
 * routes/reports.ts.
 *
 * All routes are community-mod gated (owner/admin/moderator membership),
 * except mod-mail creation, which members may also open (to the mod team).
 */
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import {
  automodHolds,
  automodRules,
  communities,
  communityMembers,
  conversations,
  conversationParticipants,
  modActions,
  posts,
  users,
} from "../db/schema";
import { requireAuth } from "../lib/auth";
import {
  conflict,
  forbidden,
  notFound,
  unprocessable,
} from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { decodeCursor, encodeCursor } from "../lib/pagination";
import {
  communityWire,
  membershipWire,
  pageEnvelope,
  type CommunityRow,
} from "../lib/serializers";
import { parseBody } from "../lib/validate";
import { auditAgentAction } from "../services/agent-audit";
import {
  conversationWire,
  sendMessage,
} from "../services/conversations";
import {
  isCommunityMod,
  recordModAction,
  type AutomodRuleRow,
} from "../services/moderation";
import { notify } from "../services/notifications";
import { authorMap, getUserByHandle } from "../services/users";

const AUTOMOD_KINDS = [
  "keyword",
  "regex",
  "account_age",
  "karma_threshold",
  "link_domain",
  "trust_tier",
  "link_count",
] as const;

const ruleCreateSchema = z.object({
  kind: z.enum(AUTOMOD_KINDS),
  config: z.record(z.string(), z.unknown()).default({}),
  action: z.enum(["flag", "hold", "remove"]),
  is_enabled: z.boolean().optional(),
});

const rulePatchSchema = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  action: z.enum(["flag", "hold", "remove"]).optional(),
  is_enabled: z.boolean().optional(),
});

const lockdownSchema = z.object({
  enabled: z.boolean(),
  min_member_age_days: z.number().int().min(0).max(3650).optional(),
  min_trust_tier: z.enum(["T0", "T1", "T2", "T3"]).optional(),
});

const modActionSchema = z.object({
  action: z.enum([
    "remove_post",
    "approve_post",
    "ban",
    "mute",
    "lock_thread",
    "pin",
    "unpin",
    "warn",
    "note",
    "feature",
    "restore",
  ]),
  target_type: z.enum(["post", "user", "message", "argument"]),
  target_id: z.string().uuid(),
  target_handle: z.string().optional(),
  reason: z.string().max(500).optional(),
  duration_hours: z.number().int().min(1).max(8760).optional(),
  notify_user: z.boolean().default(true),
});

const decisionSchema = z.object({ decision: z.enum(["approve", "reject"]) });

const modMailSchema = z.object({
  handle: z.string().optional(),
  subject: z.string().max(200).optional(),
  body: z.string().min(1).max(10000),
});

const pageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

function automodRuleWire(row: AutomodRuleRow) {
  return {
    id: row.id,
    community_id: row.communityId,
    kind: row.kind,
    config: (row.config ?? {}) as Record<string, unknown>,
    action: row.action,
    is_enabled: row.isEnabled,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** Validate kind-specific config at write time (fail fast, not at match). */
function validateRuleConfig(kind: string, config: Record<string, unknown>): void {
  switch (kind) {
    case "keyword": {
      const keywords = config.keywords;
      if (
        !Array.isArray(keywords) ||
        keywords.length === 0 ||
        keywords.some((k) => typeof k !== "string" || k.length === 0 || k.length > 100)
      ) {
        throw unprocessable("keyword rules require config.keywords: a non-empty string array");
      }
      break;
    }
    case "regex": {
      const pattern = config.pattern;
      if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 200) {
        throw unprocessable("regex rules require config.pattern (1–200 chars)");
      }
      try {
        new RegExp(pattern);
      } catch {
        throw unprocessable("config.pattern is not a valid regular expression");
      }
      break;
    }
    case "account_age": {
      const days = Number(config.min_account_age_days ?? config.min_age_days);
      if (!Number.isFinite(days) || days < 0) {
        throw unprocessable("account_age rules require config.min_account_age_days ≥ 0");
      }
      break;
    }
    case "karma_threshold": {
      if (!Number.isFinite(Number(config.min_karma))) {
        throw unprocessable("karma_threshold rules require config.min_karma");
      }
      break;
    }
    case "trust_tier": {
      if (!["T0", "T1", "T2", "T3"].includes(String(config.min_trust_tier))) {
        throw unprocessable("trust_tier rules require config.min_trust_tier (T0–T3)");
      }
      break;
    }
    case "link_domain": {
      const domains = config.domains;
      if (
        !Array.isArray(domains) ||
        domains.length === 0 ||
        domains.some((d) => typeof d !== "string" || d.length === 0)
      ) {
        throw unprocessable("link_domain rules require config.domains: a non-empty string array");
      }
      break;
    }
    case "link_count": {
      if (!Number.isFinite(Number(config.max_links)) || Number(config.max_links) < 0) {
        throw unprocessable("link_count rules require config.max_links ≥ 0");
      }
      break;
    }
  }
}

export async function registerModerationRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db } = ctx;

  async function loadCommunity(slug: string): Promise<CommunityRow> {
    const [community] = await db
      .select()
      .from(communities)
      .where(eq(communities.slug, slug.toLowerCase()))
      .limit(1);
    if (!community || community.deletedAt) throw notFound("Community not found");
    return community;
  }

  async function requireMod(slug: string, userId: string): Promise<CommunityRow> {
    const community = await loadCommunity(slug);
    if (!(await isCommunityMod(db, community.id, userId))) {
      throw forbidden("Moderators only");
    }
    return community;
  }

  // ── AutoMod rules ────────────────────────────────────────────────────────
  app.get(
    "/api/v1/communities/:slug/mod/automod-rules",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const { slug } = request.params as { slug: string };
      const community = await requireMod(slug, request.authUser!.sub);
      const rows = await db
        .select()
        .from(automodRules)
        .where(eq(automodRules.communityId, community.id))
        .orderBy(asc(automodRules.createdAt), asc(automodRules.id));
      return { data: rows.map(automodRuleWire) };
    },
  );

  app.post(
    "/api/v1/communities/:slug/mod/automod-rules",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const body = parseBody(ruleCreateSchema, request.body);
      const me = request.authUser!;
      const community = await requireMod(slug, me.sub);
      validateRuleConfig(body.kind, body.config);
      const [row] = await db
        .insert(automodRules)
        .values({
          id: uuidv7(),
          communityId: community.id,
          kind: body.kind,
          config: body.config,
          action: body.action,
          isEnabled: body.is_enabled ?? true,
          createdBy: me.sub,
        })
        .returning();
      await auditAgentAction(db, request, "automod.rule.create", "community", community.id, {
        rule_id: row!.id,
        kind: body.kind,
      });
      return reply.status(201).send(automodRuleWire(row!));
    },
  );

  app.patch(
    "/api/v1/communities/:slug/mod/automod-rules/:ruleId",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const { slug, ruleId } = request.params as { slug: string; ruleId: string };
      const body = parseBody(rulePatchSchema, request.body);
      const community = await requireMod(slug, request.authUser!.sub);
      const [rule] = await db
        .select()
        .from(automodRules)
        .where(
          and(eq(automodRules.id, ruleId), eq(automodRules.communityId, community.id)),
        )
        .limit(1);
      if (!rule) throw notFound("AutoMod rule not found");
      if (body.config !== undefined) validateRuleConfig(rule.kind, body.config);
      const [updated] = await db
        .update(automodRules)
        .set({
          config: body.config ?? rule.config,
          action: body.action ?? rule.action,
          isEnabled: body.is_enabled ?? rule.isEnabled,
          updatedAt: new Date(),
        })
        .where(eq(automodRules.id, rule.id))
        .returning();
      return automodRuleWire(updated!);
    },
  );

  app.delete(
    "/api/v1/communities/:slug/mod/automod-rules/:ruleId",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      const { slug, ruleId } = request.params as { slug: string; ruleId: string };
      const community = await requireMod(slug, request.authUser!.sub);
      const deleted = await db
        .delete(automodRules)
        .where(
          and(eq(automodRules.id, ruleId), eq(automodRules.communityId, community.id)),
        )
        .returning({ id: automodRules.id });
      if (deleted.length === 0) throw notFound("AutoMod rule not found");
      return reply.status(204).send();
    },
  );

  // ── Lockdown ─────────────────────────────────────────────────────────────
  app.post(
    "/api/v1/communities/:slug/lockdown",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const { slug } = request.params as { slug: string };
      const body = parseBody(lockdownSchema, request.body);
      const me = request.authUser!;
      const community = await requireMod(slug, me.sub);
      const settings = {
        ...((community.settings ?? {}) as Record<string, unknown>),
      };
      if (body.enabled) {
        settings.lockdown = {
          ...(body.min_member_age_days != null
            ? { min_member_age_days: body.min_member_age_days }
            : {}),
          ...(body.min_trust_tier ? { min_trust_tier: body.min_trust_tier } : {}),
        };
      } else {
        delete settings.lockdown;
      }
      const [updated] = await db
        .update(communities)
        .set({
          lockdownAt: body.enabled ? new Date() : null,
          lockdownBy: body.enabled ? me.sub : null,
          settings,
          updatedAt: new Date(),
        })
        .where(eq(communities.id, community.id))
        .returning();
      await auditAgentAction(db, request, body.enabled ? "community.lockdown.on" : "community.lockdown.off", "community", community.id);
      return communityWire(updated!);
    },
  );

  // ── Mod actions ──────────────────────────────────────────────────────────
  app.post(
    "/api/v1/communities/:slug/mod/actions",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const body = parseBody(modActionSchema, request.body);
      const me = request.authUser!;
      const community = await requireMod(slug, me.sub);

      let targetUserId: string | null = null;
      let post: typeof posts.$inferSelect | null = null;

      if (body.target_type === "post") {
        const [row] = await db
          .select()
          .from(posts)
          .where(eq(posts.id, body.target_id))
          .limit(1);
        if (!row) throw notFound("Target post not found");
        if (row.communityId !== community.id) {
          throw unprocessable("Target post does not belong to this community");
        }
        post = row;
        targetUserId = row.authorId;
      } else if (body.target_type === "user") {
        const target = body.target_handle
          ? await getUserByHandle(db, body.target_handle.replace(/^@/, "").toLowerCase())
          : null;
        const [row] = target
          ? [{ id: target.id }]
          : await db
              .select({ id: users.id })
              .from(users)
              .where(eq(users.id, body.target_id))
              .limit(1);
        if (!row) throw notFound("Target user not found");
        targetUserId = row.id;
      }

      const now = new Date();
      switch (body.action) {
        case "pin": {
          if (!post) throw unprocessable("pin requires a post target");
          if (post.deletedAt) throw conflict("Cannot pin a removed post");
          if (!post.isPinned) {
            const pinned = await db
              .select({ id: posts.id })
              .from(posts)
              .where(
                and(
                  eq(posts.communityId, community.id),
                  eq(posts.isPinned, true),
                  isNull(posts.deletedAt),
                ),
              );
            if (pinned.length >= 2) {
              throw conflict("A community can pin at most 2 posts");
            }
            await db
              .update(posts)
              .set({ isPinned: true, pinnedBy: me.sub })
              .where(eq(posts.id, post.id));
          }
          break;
        }
        case "unpin": {
          if (!post) throw unprocessable("unpin requires a post target");
          await db
            .update(posts)
            .set({ isPinned: false, pinnedBy: null })
            .where(eq(posts.id, post.id));
          break;
        }
        case "feature": {
          if (!post) throw unprocessable("feature requires a post target");
          await db
            .update(posts)
            .set({ isFeatured: true })
            .where(eq(posts.id, post.id));
          break;
        }
        case "lock_thread": {
          if (!post) throw unprocessable("lock_thread requires a post target");
          await db
            .update(posts)
            .set({ isLocked: true })
            .where(eq(posts.id, post.id));
          break;
        }
        case "remove_post": {
          if (!post) throw unprocessable("remove_post requires a post target");
          if (!post.deletedAt) {
            await db
              .update(posts)
              .set({ deletedAt: now, removedBy: me.sub, heldAt: null })
              .where(eq(posts.id, post.id));
            if (!post.parentId) {
              await db
                .update(communities)
                .set({ postCount: sql`greatest(${communities.postCount} - 1, 0)` })
                .where(eq(communities.id, community.id));
            }
          }
          await db
            .update(automodHolds)
            .set({ status: "removed", resolvedBy: me.sub, resolvedAt: now })
            .where(
              and(eq(automodHolds.postId, post.id), eq(automodHolds.status, "pending")),
            );
          break;
        }
        case "approve_post": {
          if (!post) throw unprocessable("approve_post requires a post target");
          await db
            .update(posts)
            .set({ heldAt: null })
            .where(eq(posts.id, post.id));
          await db
            .update(automodHolds)
            .set({ status: "approved", resolvedBy: me.sub, resolvedAt: now })
            .where(
              and(eq(automodHolds.postId, post.id), eq(automodHolds.status, "pending")),
            );
          break;
        }
        case "restore": {
          if (!post) throw unprocessable("restore requires a post target");
          if (post.deletedAt) {
            await db
              .update(posts)
              .set({ deletedAt: null, removedBy: null, heldAt: null })
              .where(eq(posts.id, post.id));
            if (!post.parentId) {
              await db
                .update(communities)
                .set({ postCount: sql`${communities.postCount} + 1` })
                .where(eq(communities.id, community.id));
            }
          } else if (post.heldAt) {
            await db
              .update(posts)
              .set({ heldAt: null })
              .where(eq(posts.id, post.id));
          }
          await db
            .update(automodHolds)
            .set({ status: "approved", resolvedBy: me.sub, resolvedAt: now })
            .where(
              and(
                eq(automodHolds.postId, post.id),
                inArray(automodHolds.status, ["pending", "removed"]),
              ),
            );
          break;
        }
        case "ban": {
          if (!targetUserId) throw unprocessable("ban requires a user target");
          await db
            .update(communityMembers)
            .set({ status: "banned", bannedReason: body.reason ?? null })
            .where(
              and(
                eq(communityMembers.communityId, community.id),
                eq(communityMembers.userId, targetUserId),
              ),
            );
          break;
        }
        case "mute": {
          if (!targetUserId) throw unprocessable("mute requires a user target");
          const hours = body.duration_hours ?? 24;
          await db
            .update(communityMembers)
            .set({ mutedUntil: new Date(now.getTime() + hours * 3600_000) })
            .where(
              and(
                eq(communityMembers.communityId, community.id),
                eq(communityMembers.userId, targetUserId),
              ),
            );
          break;
        }
        case "warn":
        case "note":
          break; // Log + (for warn) notification below.
      }

      const actionRow = await recordModAction(db, {
        communityId: community.id,
        action: body.action,
        actorId: me.sub,
        targetType: body.target_type,
        targetId: body.target_id,
        targetUserId,
        reason: body.reason ?? null,
        durationHours: body.duration_hours ?? null,
      });

      if (
        body.notify_user &&
        targetUserId &&
        targetUserId !== me.sub &&
        ["remove_post", "approve_post", "warn", "ban", "mute", "restore"].includes(body.action)
      ) {
        await notify(db, {
          recipientId: targetUserId,
          type: "mod_action",
          actorId: me.sub,
          subjectType: body.target_type,
          subjectId: body.target_id,
          payload: {
            action: body.action,
            community_id: community.id,
            community_slug: community.slug,
            reason: body.reason ?? null,
          },
        });
      }
      await auditAgentAction(db, request, `mod.${body.action}`, body.target_type, body.target_id, {
        community_id: community.id,
      });

      const authors = await authorMap(db, [me.sub, targetUserId ?? ""]);
      return reply.status(201).send({
        id: actionRow.id,
        community_id: community.id,
        action: actionRow.action,
        actor: authors.get(me.sub)!,
        target_type: actionRow.targetType,
        target_id: actionRow.targetId,
        target_user: targetUserId ? (authors.get(targetUserId) ?? null) : null,
        reason: actionRow.reason,
        duration_hours: actionRow.durationHours,
        created_at: actionRow.createdAt.toISOString(),
      });
    },
  );

  // ── Mod log ──────────────────────────────────────────────────────────────
  app.get(
    "/api/v1/communities/:slug/mod/log",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const { slug } = request.params as { slug: string };
      const query = parseBody(pageQuerySchema, request.query);
      const community = await requireMod(slug, request.authUser!.sub);
      const cursor = decodeCursor<{ createdAt: string; id: string }>(query.cursor);
      const rows = await db
        .select()
        .from(modActions)
        .where(
          and(
            eq(modActions.communityId, community.id),
            cursor
              ? sql`(${modActions.createdAt}, ${modActions.id}) < (${new Date(cursor.createdAt)}, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(modActions.createdAt), desc(modActions.id))
        .limit(query.limit + 1);
      const pageRows = rows.slice(0, query.limit);
      const authors = await authorMap(db, [
        ...pageRows.map((r) => r.actorId),
        ...pageRows.map((r) => r.targetUserId ?? ""),
      ]);
      const items = pageRows.map((row) => ({
        id: row.id,
        community_id: community.id,
        action: row.action,
        actor: authors.get(row.actorId)!,
        target_type: row.targetType,
        target_id: row.targetId,
        target_user: row.targetUserId ? (authors.get(row.targetUserId) ?? null) : null,
        reason: row.reason,
        duration_hours: row.durationHours,
        created_at: row.createdAt.toISOString(),
      }));
      const last = pageRows[pageRows.length - 1];
      return pageEnvelope(
        items,
        rows.length > query.limit && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
      );
    },
  );

  // ── Membership requests ──────────────────────────────────────────────────
  app.get(
    "/api/v1/communities/:slug/mod/membership-requests",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const { slug } = request.params as { slug: string };
      const query = parseBody(pageQuerySchema, request.query);
      const community = await requireMod(slug, request.authUser!.sub);
      const cursor = decodeCursor<{ joinedAt: string; userId: string }>(query.cursor);
      const rows = await db
        .select()
        .from(communityMembers)
        .where(
          and(
            eq(communityMembers.communityId, community.id),
            eq(communityMembers.status, "pending"),
            cursor
              ? sql`(${communityMembers.joinedAt}, ${communityMembers.userId}) > (${new Date(cursor.joinedAt)}, ${cursor.userId}::uuid)`
              : undefined,
          ),
        )
        .orderBy(asc(communityMembers.joinedAt), asc(communityMembers.userId))
        .limit(query.limit + 1);
      const pageRows = rows.slice(0, query.limit);
      const authors = await authorMap(db, pageRows.map((r) => r.userId));
      const items = pageRows.map((row) =>
        membershipWire(row, authors.get(row.userId)!),
      );
      const last = pageRows[pageRows.length - 1];
      return pageEnvelope(
        items,
        rows.length > query.limit && last
          ? encodeCursor({
              joinedAt: last.joinedAt.toISOString(),
              userId: last.userId,
            })
          : null,
      );
    },
  );

  app.post(
    "/api/v1/communities/:slug/mod/membership-requests/:handle",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const { slug, handle } = request.params as { slug: string; handle: string };
      const body = parseBody(decisionSchema, request.body);
      const community = await requireMod(slug, request.authUser!.sub);
      const target = await getUserByHandle(db, handle.replace(/^@/, "").toLowerCase());
      if (!target) throw notFound("User not found");
      const [membership] = await db
        .select()
        .from(communityMembers)
        .where(
          and(
            eq(communityMembers.communityId, community.id),
            eq(communityMembers.userId, target.id),
            eq(communityMembers.status, "pending"),
          ),
        )
        .limit(1);
      if (!membership) throw notFound("No pending membership request for this user");
      if (body.decision === "approve") {
        const [updated] = await db
          .update(communityMembers)
          .set({ status: "active" })
          .where(
            and(
              eq(communityMembers.communityId, community.id),
              eq(communityMembers.userId, target.id),
            ),
          )
          .returning();
        await db
          .update(communities)
          .set({ memberCount: sql`${communities.memberCount} + 1` })
          .where(eq(communities.id, community.id));
        const authors = await authorMap(db, [target.id]);
        return membershipWire(updated!, authors.get(target.id)!);
      }
      await db
        .delete(communityMembers)
        .where(
          and(
            eq(communityMembers.communityId, community.id),
            eq(communityMembers.userId, target.id),
          ),
        );
      const authors = await authorMap(db, [target.id]);
      // The request row is gone; the wire echoes the decision (the
      // Membership status enum gains "rejected" for this response, D-059).
      return {
        id: target.id,
        community_id: community.id,
        user: authors.get(target.id)!,
        role: membership.role,
        status: "rejected",
        muted_until: null,
        joined_at: membership.joinedAt.toISOString(),
      };
    },
  );

  // ── Mod mail ─────────────────────────────────────────────────────────────
  app.post(
    "/api/v1/communities/:slug/mod/mail",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const body = parseBody(modMailSchema, request.body);
      const me = request.authUser!;
      const community = await loadCommunity(slug);
      const meRow = (await db
        .select()
        .from(users)
        .where(eq(users.id, me.sub))
        .limit(1))[0];
      if (!meRow) throw notFound("Account not found");
      const iAmMod = await isCommunityMod(db, community.id, me.sub);

      // The member side of the thread: the named handle for mods; the
      // caller themselves for members writing to the mod team.
      let member = meRow;
      if (iAmMod && body.handle) {
        const target = await getUserByHandle(
          db,
          body.handle.replace(/^@/, "").toLowerCase(),
        );
        if (!target || target.deletedAt) throw notFound("User not found");
        member = target;
      } else if (!iAmMod) {
        const [membership] = await db
          .select({ status: communityMembers.status })
          .from(communityMembers)
          .where(
            and(
              eq(communityMembers.communityId, community.id),
              eq(communityMembers.userId, me.sub),
            ),
          )
          .limit(1);
        if (!membership) {
          throw forbidden("Only community members can open mod mail");
        }
      }

      // One open thread per (community, member): reuse an existing one.
      const existingRows = await db
        .select({ id: conversations.id })
        .from(conversations)
        .innerJoin(
          conversationParticipants,
          eq(conversationParticipants.conversationId, conversations.id),
        )
        .where(
          and(
            eq(conversations.kind, "modmail"),
            eq(conversations.communityId, community.id),
            eq(conversationParticipants.userId, member.id),
          ),
        )
        .limit(1);
      let conversationId = existingRows[0]?.id;

      if (!conversationId) {
        const modMembers = await db
          .select({ userId: communityMembers.userId, role: communityMembers.role })
          .from(communityMembers)
          .where(
            and(
              eq(communityMembers.communityId, community.id),
              eq(communityMembers.status, "active"),
              inArray(communityMembers.role, ["owner", "admin", "moderator"]),
            ),
          );
        const id = uuidv7();
        conversationId = id;
        await db.transaction(async (tx) => {
          await tx.insert(conversations).values({
            id,
            kind: "modmail",
            communityId: community.id,
            title: body.subject ?? `Mod mail — g/${community.slug}`,
            createdBy: me.sub,
            dmPairKey: null,
          });
          const participantIds = new Set<string>([
            member.id,
            ...modMembers.map((m) => m.userId),
          ]);
          await tx.insert(conversationParticipants).values(
            [...participantIds].map((userId) => ({
              conversationId: id,
              userId,
              role: userId === member.id ? ("member" as const) : ("admin" as const),
              status: "active" as const,
            })),
          );
        });
      }

      const [conversation] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      const message = await sendMessage(db, conversation!, meRow, {
        body: body.body,
      });
      const wire = await conversationWire(db, conversation!, me.sub);
      return reply.status(201).send({ conversation: wire, message });
    },
  );

  // Mod-mail thread list for the community (mods+). Members read their
  // own thread in /messages; this is the mod team's inbox view.
  app.get(
    "/api/v1/communities/:slug/mod/mail",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const { slug } = request.params as { slug: string };
      const query = parseBody(pageQuerySchema, request.query);
      const me = request.authUser!;
      const community = await requireMod(slug, me.sub);
      const cursor = decodeCursor<{ updatedAt: string; id: string }>(query.cursor);
      const rows = await db
        .select({ conversation: conversations })
        .from(conversations)
        .innerJoin(
          conversationParticipants,
          eq(conversationParticipants.conversationId, conversations.id),
        )
        .where(
          and(
            eq(conversations.kind, "modmail"),
            eq(conversations.communityId, community.id),
            eq(conversationParticipants.userId, me.sub),
            cursor
              ? sql`(${conversations.updatedAt}, ${conversations.id}) < (${new Date(cursor.updatedAt)}, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(conversations.updatedAt), desc(conversations.id))
        .limit(query.limit + 1);
      const pageRows = rows.slice(0, query.limit);
      const items = await Promise.all(
        pageRows.map((row) => conversationWire(db, row.conversation, me.sub)),
      );
      const last = pageRows[pageRows.length - 1];
      return pageEnvelope(
        items,
        rows.length > query.limit && last
          ? encodeCursor({
              updatedAt: last.conversation.updatedAt.toISOString(),
              id: last.conversation.id,
            })
          : null,
      );
    },
  );
}
