/**
 * Reports + community moderation queue (API_SPEC: createReport, getReport,
 * getModQueue; resolution via PATCH /reports/{reportId} — added to the spec
 * in the Phase 1 exit round, D-023).
 *
 * Reports file against posts (replies included — they are posts), users and
 * communities. message/argument/debate targets are accepted by the spec
 * enum but those entities do not exist yet, so every such target fails the
 * existence check with 422 until their phases land.
 *
 * Moderation is community-scoped (there is no platform-staff role in
 * Phase 1): a community's moderators see and resolve reports about posts in
 * their community and about the community itself. Reports with no owning
 * community (personal posts, user targets) collect in the table for the
 * future platform queue; nobody can action them yet (D-023).
 */
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import {
  automodHolds,
  communities,
  communityMembers,
  conversationParticipants,
  messages,
  posts,
  reports,
  users,
} from "../db/schema";
import { requireAuth, requireScope } from "../lib/auth";
import { conflict, forbidden, notFound, unprocessable } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { decodeCursor, encodeCursor } from "../lib/pagination";
import {
  heldQueueItemWire,
  heldSeverity,
  modQueueItemWire,
  pageEnvelope,
  reportWire,
  type ModQueueItemWire,
  type ReportRow,
} from "../lib/serializers";
import { parseBody } from "../lib/validate";
import { hydratePosts } from "../services/posts";
import { auditAgentAction } from "../services/agent-audit";
import { logEvent } from "../services/events";

const REPORT_REASONS = [
  "spam",
  "harassment",
  "hate",
  "violence",
  "sexual",
  "self_harm",
  "misinformation",
  "copyright",
  "impersonation",
  "other",
] as const;

/** Static severity per reason (DATA_MODEL §10.3: 1–4, default 2). */
const SEVERITY_BY_REASON: Record<(typeof REPORT_REASONS)[number], number> = {
  spam: 1,
  harassment: 2,
  hate: 3,
  violence: 3,
  sexual: 3,
  self_harm: 4,
  misinformation: 2,
  copyright: 2,
  impersonation: 2,
  other: 2,
};

const createReportSchema = z.object({
  target_type: z.enum(["post", "user", "community", "message", "argument", "debate"]),
  target_id: z.string().uuid(),
  reason: z.enum(REPORT_REASONS),
  details: z.string().max(1000).optional(),
});

const resolveReportSchema = z.object({
  status: z.enum(["triaged", "actioned", "dismissed", "closed"]),
  resolution: z.string().max(1000).optional(),
});

const queueQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  kind: z.enum(["reports", "held", "all"]).default("all"),
});

const MOD_ROLES = ["owner", "admin", "moderator"] as const;

/** The community that owns a report's target, if any (posts → their community; a community → itself). */
async function owningCommunityId(
  ctx: AppContext,
  targetType: string,
  targetId: string,
): Promise<string | null> {
  const { db } = ctx;
  if (targetType === "community") return targetId;
  if (targetType === "post") {
    const [post] = await db
      .select({ communityId: posts.communityId })
      .from(posts)
      .where(eq(posts.id, targetId))
      .limit(1);
    return post?.communityId ?? null;
  }
  return null;
}

async function isCommunityMod(
  ctx: AppContext,
  communityId: string,
  userId: string,
): Promise<boolean> {
  const [membership] = await ctx.db
    .select({ role: communityMembers.role, status: communityMembers.status })
    .from(communityMembers)
    .where(
      and(
        eq(communityMembers.communityId, communityId),
        eq(communityMembers.userId, userId),
      ),
    )
    .limit(1);
  return (
    membership?.status === "active" &&
    (MOD_ROLES as readonly string[]).includes(membership.role)
  );
}

export async function registerReportRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db } = ctx;

  app.post(
    "/api/v1/reports",
    { preHandler: [requireAuth(ctx), requireScope("write:post")] },
    async (request, reply) => {
      const body = parseBody(createReportSchema, request.body);
      const me = request.authUser!;

      // Existence + self-report guards per target type.
      if (body.target_type === "post") {
        const [post] = await db
          .select({ authorId: posts.authorId })
          .from(posts)
          .where(eq(posts.id, body.target_id))
          .limit(1);
        if (!post) throw unprocessable("target_id: post does not exist");
        if (post.authorId === me.sub) {
          throw unprocessable("You cannot report your own post");
        }
      } else if (body.target_type === "user") {
        if (body.target_id === me.sub) {
          throw unprocessable("You cannot report yourself");
        }
        const [user] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, body.target_id))
          .limit(1);
        if (!user) throw unprocessable("target_id: user does not exist");
      } else if (body.target_type === "community") {
        const [community] = await db
          .select({ id: communities.id, deletedAt: communities.deletedAt })
          .from(communities)
          .where(eq(communities.id, body.target_id))
          .limit(1);
        if (!community || community.deletedAt) {
          throw unprocessable("target_id: community does not exist");
        }
      } else if (body.target_type === "message") {
        // Phase 5A: messages exist now — the reporter must be a
        // participant of the message's conversation and not its author.
        const [message] = await db
          .select({ senderId: messages.senderId, conversationId: messages.conversationId })
          .from(messages)
          .where(eq(messages.id, body.target_id))
          .limit(1);
        if (!message) throw unprocessable("target_id: message does not exist");
        if (message.senderId === me.sub) {
          throw unprocessable("You cannot report your own message");
        }
        const [membership] = await db
          .select({ userId: conversationParticipants.userId })
          .from(conversationParticipants)
          .where(
            and(
              eq(conversationParticipants.conversationId, message.conversationId),
              eq(conversationParticipants.userId, me.sub),
            ),
          )
          .limit(1);
        if (!membership) {
          throw unprocessable("You can only report messages in your conversations");
        }
      } else {
        // argument | debate — entities land in later phases.
        throw unprocessable(
          `target_type: ${body.target_type} targets cannot be reported yet`,
        );
      }

      // Duplicate: an open/triaged report by the same reporter on the same
      // target already covers this filing — return it with 200 (D-023).
      const [existing] = await db
        .select()
        .from(reports)
        .where(
          and(
            eq(reports.reporterId, me.sub),
            eq(reports.targetType, body.target_type),
            eq(reports.targetId, body.target_id),
            inArray(reports.status, ["open", "triaged"]),
          ),
        )
        .orderBy(desc(reports.createdAt))
        .limit(1);
      if (existing) return reply.status(200).send(reportWire(existing));

      const [row] = await db
        .insert(reports)
        .values({
          id: uuidv7(),
          reporterId: me.sub,
          targetType: body.target_type,
          targetId: body.target_id,
          reason: body.reason,
          details: body.details ?? null,
          severity: SEVERITY_BY_REASON[body.reason],
        })
        .returning();
      await auditAgentAction(db, request, "report.create", body.target_type, body.target_id, { report_id: row!.id });
      await logEvent(db, {
        userId: me.sub,
        type: "report",
        subjectType: body.target_type,
        subjectId: body.target_id,
        props: { report_id: row!.id, reason: body.reason },
      });
      return reply.status(201).send(reportWire(row!));
    },
  );

  app.get(
    "/api/v1/reports/:reportId",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const { reportId } = request.params as { reportId: string };
      const me = request.authUser!;
      const [row] = await db
        .select()
        .from(reports)
        .where(eq(reports.id, reportId))
        .limit(1);
      if (!row) throw notFound("Report not found");
      if (row.reporterId !== me.sub) {
        const communityId = await owningCommunityId(ctx, row.targetType, row.targetId);
        if (!communityId || !(await isCommunityMod(ctx, communityId, me.sub))) {
          // Don't leak existence to unrelated users.
          throw notFound("Report not found");
        }
      }
      return reportWire(row);
    },
  );

  app.patch(
    "/api/v1/reports/:reportId",
    { preHandler: [requireAuth(ctx), requireScope("moderate:community")] },
    async (request) => {
      const { reportId } = request.params as { reportId: string };
      const body = parseBody(resolveReportSchema, request.body);
      const me = request.authUser!;
      const [row] = await db
        .select()
        .from(reports)
        .where(eq(reports.id, reportId))
        .limit(1);
      if (!row) throw notFound("Report not found");
      const communityId = await owningCommunityId(ctx, row.targetType, row.targetId);
      if (!communityId) {
        throw forbidden(
          "This report has no owning community; platform review is not available yet",
        );
      }
      if (!(await isCommunityMod(ctx, communityId, me.sub))) {
        throw forbidden("Only moderators of the owning community can resolve reports");
      }
      if (row.status !== "open" && row.status !== "triaged") {
        throw conflict(`Report is already ${row.status}`);
      }
      const terminal = body.status !== "triaged";
      const [updated] = await db
        .update(reports)
        .set({
          status: body.status,
          resolution: body.resolution ?? row.resolution,
          resolvedBy: terminal ? me.sub : row.resolvedBy,
          resolvedAt: terminal ? new Date() : row.resolvedAt,
          updatedAt: new Date(),
        })
        .where(eq(reports.id, row.id))
        .returning();
      await auditAgentAction(db, request, "report.resolve", row.targetType, row.targetId, { report_id: row.id, status: body.status });
      return reportWire(updated!);
    },
  );

  // ── Community moderation queue (API_SPEC getModQueue) ───────────────────
  app.get(
    "/api/v1/communities/:slug/mod/queue",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const { slug } = request.params as { slug: string };
      const query = parseBody(queueQuerySchema, request.query);
      const me = request.authUser!;
      const [community] = await db
        .select()
        .from(communities)
        .where(eq(communities.slug, slug.toLowerCase()))
        .limit(1);
      if (!community || community.deletedAt) throw notFound("Community not found");
      if (!(await isCommunityMod(ctx, community.id, me.sub))) {
        throw forbidden("Moderators only");
      }

      // Phase 5B: the queue merges user reports with AutoMod holds. Both
      // streams share one sort — severity desc, created_at asc, id asc —
      // and one cursor over that tuple, so kind=all paginates cleanly.
      type QueueCursor = { severity: number; createdAt: string; id: string };
      const cursor = decodeCursor<QueueCursor>(query.cursor);
      const afterCursor = (
        severityExpr: ReturnType<typeof sql>,
        createdAtCol: AnyPgColumn,
        idCol: AnyPgColumn,
      ) =>
        cursor
          ? or(
              lt(severityExpr, cursor.severity),
              and(
                eq(severityExpr, cursor.severity),
                gt(createdAtCol, new Date(cursor.createdAt)),
              ),
              and(
                eq(severityExpr, cursor.severity),
                eq(createdAtCol, new Date(cursor.createdAt)),
                gt(idCol, cursor.id),
              ),
            )
          : undefined;

      const wantReports = query.kind === "reports" || query.kind === "all";
      const wantHeld = query.kind === "held" || query.kind === "all";

      const communityPostIds = db
        .select({ id: posts.id })
        .from(posts)
        .where(eq(posts.communityId, community.id));

      const reportRows: ReportRow[] = wantReports
        ? await db
            .select()
            .from(reports)
            .where(
              and(
                inArray(reports.status, ["open", "triaged"]),
                or(
                  and(
                    eq(reports.targetType, "post"),
                    inArray(reports.targetId, communityPostIds),
                  ),
                  and(
                    eq(reports.targetType, "community"),
                    eq(reports.targetId, community.id),
                  ),
                ),
                afterCursor(
                  sql`${reports.severity}`,
                  reports.createdAt,
                  reports.id,
                ),
              ),
            )
            .orderBy(desc(reports.severity), asc(reports.createdAt), asc(reports.id))
            .limit(query.limit + 1)
        : [];

      const heldSeverityExpr = sql<number>`case ${automodHolds.action} when 'remove' then 3 when 'hold' then 2 else 1 end`;
      const holdRows = wantHeld
        ? await db
            .select()
            .from(automodHolds)
            .where(
              and(
                eq(automodHolds.communityId, community.id),
                eq(automodHolds.status, "pending"),
                afterCursor(heldSeverityExpr, automodHolds.createdAt, automodHolds.id),
              ),
            )
            .orderBy(desc(heldSeverityExpr), asc(automodHolds.createdAt), asc(automodHolds.id))
            .limit(query.limit + 1)
        : [];

      // Hydrate every referenced post once (report targets + held posts).
      const postIdSet = new Set<string>([
        ...reportRows.filter((r) => r.targetType === "post").map((r) => r.targetId),
        ...holdRows.map((h) => h.postId),
      ]);
      const postRows =
        postIdSet.size > 0
          ? await db.select().from(posts).where(inArray(posts.id, [...postIdSet]))
          : [];
      const wires = await hydratePosts(db, postRows, me.sub);
      const postById = new Map(wires.map((w) => [w.id, w]));

      const merged: { item: ModQueueItemWire; severity: number; createdAt: Date; id: string }[] = [
        ...reportRows.map((row) => ({
          item: modQueueItemWire(row, postById.get(row.targetId) ?? null),
          severity: row.severity,
          createdAt: row.createdAt,
          id: row.id,
        })),
        ...holdRows.map((row) => ({
          item: heldQueueItemWire(row, postById.get(row.postId) ?? null),
          severity: heldSeverity(row.action),
          createdAt: row.createdAt,
          id: row.id,
        })),
      ].sort(
        (a, b) =>
          b.severity - a.severity ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          (a.id < b.id ? -1 : 1),
      );
      const pageRows = merged.slice(0, query.limit);
      const last = pageRows[pageRows.length - 1];
      const hasMore =
        reportRows.length > query.limit ||
        holdRows.length > query.limit ||
        merged.length > query.limit;
      return pageEnvelope(
        pageRows.map((entry) => entry.item),
        hasMore && last
          ? encodeCursor({
              severity: last.severity,
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            })
          : null,
      );
    },
  );
}
