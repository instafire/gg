/**
 * Poll routes (API_SPEC: Polls tag, Phase 3) + admin vote-integrity
 * endpoints (D-030: /admin/* paths are a spec delta, recorded in
 * docs/API_SPEC.yaml).
 */
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { communities, dailyPulseQuestions, pollFlags, polls, posts, users } from "../db/schema";
import { optionalAuth, requireAuth, requireScope } from "../lib/auth";
import { forbidden, notFound, unprocessable } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { parseBody } from "../lib/validate";
import { auditAgentAction } from "../services/agent-audit";
import { logEvent } from "../services/events";
import { emitWebhookEvent } from "../services/webhooks";
import {
  castBallot,
  closePoll,
  createPollWithPost,
  ensureTodaysPulse,
  getPollById,
  pollResultsFor,
  pollWireFor,
  pulseCardSvg,
  resultsVisibleFor,
  voidBallots,
  voidWholePoll,
  type BallotInput,
} from "../services/polls";

const pollTypeSchema = z.enum(["single", "multiple", "ranked", "stance_slider", "image", "hot_take"]);

const createPollSchema = z.object({
  question: z.string().min(1).max(200),
  type: pollTypeSchema.optional(),
  options: z
    .array(
      z.object({
        text: z.string().max(80).optional(),
        media_id: z.string().uuid().optional(),
        mediaId: z.string().uuid().optional(),
      }),
    )
    .max(10)
    .optional(),
  result_mode: z.enum(["live", "after_vote", "after_close"]).optional(),
  resultMode: z.enum(["live", "after_vote", "after_close"]).optional(),
  is_anonymous: z.boolean().optional(),
  isAnonymous: z.boolean().optional(),
  closes_at: z.string().datetime().optional(),
  closesAt: z.string().datetime().optional(),
  min_trust_tier: z.enum(["T0", "T1", "T2", "T3"]).optional(),
  minTrustTier: z.enum(["T0", "T1", "T2", "T3"]).optional(),
  min_account_age_days: z.number().int().min(0).max(365).optional(),
  max_choices: z.number().int().min(1).max(10).optional(),
  maxChoices: z.number().int().min(1).max(10).optional(),
  community_slug: z.string().optional(),
  communitySlug: z.string().optional(),
  body_md: z.string().max(40_000).optional(),
  bodyMd: z.string().max(40_000).optional(),
});

const voteSchema = z.object({
  option_id: z.string().uuid().optional(),
  optionId: z.string().uuid().optional(),
  option_ids: z.array(z.string().uuid()).max(10).optional(),
  optionIds: z.array(z.string().uuid()).max(10).optional(),
  ranking: z.array(z.string().uuid()).max(10).optional(),
  slider_value: z.number().int().min(-2).max(2).optional(),
  sliderValue: z.number().int().min(-2).max(2).optional(),
});

/** Platform-role gate for /admin/* (D-030). Role is read fresh from the DB. */
export function requirePlatformRole(ctx: AppContext, roles: Array<"moderator" | "admin">) {
  return async (request: { authUser: { sub: string } | null }): Promise<void> => {
    if (!request.authUser) throw forbidden("Platform role required");
    const [user] = await ctx.db
      .select()
      .from(users)
      .where(eq(users.id, request.authUser.sub))
      .limit(1);
    if (!user || !roles.includes(user.platformRole as "moderator" | "admin")) {
      throw forbidden("This endpoint requires a platform moderator or admin role");
    }
  };
}

export async function registerPollRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db } = ctx;

  app.post("/api/v1/polls", { preHandler: [requireAuth(ctx), requireScope("write:post")] }, async (request, reply) => {
    const body = parseBody(createPollSchema, request.body);
    const me = request.authUser!;
    const type = body.type ?? "single";
    const slug = body.communitySlug ?? body.community_slug;
    let communityId: string | null = null;
    if (slug) {
      const [community] = await db
        .select()
        .from(communities)
        .where(eq(communities.slug, slug.toLowerCase()))
        .limit(1);
      if (!community) throw notFound("Community not found");
      communityId = community.id;
    }
    const { poll } = await createPollWithPost(
      db,
      { id: me.sub, authorType: me.authorType },
      {
        question: body.question,
        type,
        options: (body.options ?? []).map((o) => ({
          text: o.text ?? null,
          mediaId: o.media_id ?? o.mediaId ?? null,
        })),
        resultMode: body.result_mode ?? body.resultMode,
        isAnonymous: body.is_anonymous ?? body.isAnonymous,
        closesAt: body.closes_at ?? body.closesAt ? new Date((body.closes_at ?? body.closesAt)!) : null,
        minTrustTier: body.min_trust_tier ?? body.minTrustTier,
        minAccountAgeDays: body.min_account_age_days,
        maxChoices: body.max_choices ?? body.maxChoices ?? null,
        communityId,
        bodyMd: body.body_md ?? body.bodyMd ?? null,
      },
    );
    await auditAgentAction(db, request, "poll.create", "poll", poll.id);
    return reply.status(201).send(await pollWireFor(db, poll, me.sub));
  });

  app.get(
    "/api/v1/polls/daily-pulse",
    { preHandler: optionalAuth(ctx) },
    async (request, reply) => {
      const poll = await ensureTodaysPulse(db, ctx.config);
      if (!poll) {
        throw notFound("No Daily Pulse has been published for today yet");
      }
      return reply.send(await pollWireFor(db, poll, request.authUser?.sub ?? null));
    },
  );

  app.get(
    "/api/v1/polls/daily-pulse/card.svg",
    { preHandler: optionalAuth(ctx) },
    async (request, reply) => {
      const poll = await ensureTodaysPulse(db, ctx.config);
      if (!poll) throw notFound("No Daily Pulse has been published for today yet");
      const results = await pollResultsFor(db, poll, request.authUser?.sub ?? null);
      return reply
        .type("image/svg+xml")
        .header("cache-control", "public, max-age=60")
        .send(pulseCardSvg(poll, results));
    },
  );

  app.get("/api/v1/polls/:pollId", { preHandler: optionalAuth(ctx) }, async (request, reply) => {
    const { pollId } = request.params as { pollId: string };
    const poll = await getPollById(db, pollId);
    if (!poll) throw notFound("Poll not found");
    return reply.send(await pollWireFor(db, poll, request.authUser?.sub ?? null));
  });

  app.post(
    "/api/v1/polls/:pollId/votes",
    { preHandler: [requireAuth(ctx), requireScope("write:vote")] },
    async (request, reply) => {
      const { pollId } = request.params as { pollId: string };
      const body = parseBody(voteSchema, request.body);
      const input: BallotInput = {
        optionId: body.option_id ?? body.optionId ?? null,
        optionIds: body.option_ids ?? body.optionIds,
        ranking: body.ranking,
        sliderValue: body.slider_value ?? body.sliderValue ?? null,
      };
      const results = await castBallot(ctx, request.authUser!.sub, pollId, input);
      await auditAgentAction(db, request, "poll.vote", "poll", pollId);
      await logEvent(db, {
        userId: request.authUser!.sub,
        type: "poll.vote",
        subjectType: "poll",
        subjectId: pollId,
      });
      return reply.send(results);
    },
  );

  app.delete(
    "/api/v1/polls/:pollId/votes",
    { preHandler: [requireAuth(ctx), requireScope("write:vote")] },
    async (request, reply) => {
      const { pollId } = request.params as { pollId: string };
      const results = await castBallot(ctx, request.authUser!.sub, pollId, null);
      await auditAgentAction(db, request, "poll.vote.retract", "poll", pollId);
      return reply.send(results);
    },
  );

  app.get(
    "/api/v1/polls/:pollId/results",
    { preHandler: optionalAuth(ctx) },
    async (request, reply) => {
      const { pollId } = request.params as { pollId: string };
      const poll = await getPollById(db, pollId);
      if (!poll) throw notFound("Poll not found");
      const viewerId = request.authUser?.sub ?? null;
      const [post] = await db.select().from(posts).where(eq(posts.id, poll.postId)).limit(1);
      const wire = await pollWireFor(db, poll, viewerId);
      const visible = resultsVisibleFor(poll, viewerId, post?.authorId ?? "", wire.viewer_ballot !== null);
      if (!visible) {
        throw forbidden(
          poll.resultMode === "after_close"
            ? "Results are hidden until this poll closes"
            : "Results are hidden until you vote",
        );
      }
      return reply.send(await pollResultsFor(db, poll, viewerId));
    },
  );

  app.post(
    "/api/v1/polls/:pollId/close",
    { preHandler: [requireAuth(ctx), requireScope("write:post")] },
    async (request, reply) => {
      const { pollId } = request.params as { pollId: string };
      const poll = await getPollById(db, pollId);
      if (!poll) throw notFound("Poll not found");
      const closed = await closePoll(db, poll, request.authUser!.sub);
      await auditAgentAction(db, request, "poll.close", "poll", poll.id);
      {
        const [hostPost] = await db.select().from(posts).where(eq(posts.id, poll.postId)).limit(1);
        if (hostPost) {
          await emitWebhookEvent(db, ctx.config, hostPost.authorId, "poll.closed", {
            poll_id: poll.id,
            post_id: poll.postId,
            question: poll.question,
          });
        }
      }
      return reply.send(await pollWireFor(db, closed, request.authUser!.sub));
    },
  );

  // ─── Admin: vote integrity (D-030) ──────────────────────────────────────

  app.get(
    "/api/v1/admin/poll-flags",
    { preHandler: [requireAuth(ctx), requirePlatformRole(ctx, ["moderator", "admin"])] },
    async (request, reply) => {
      const query = request.query as { status?: string };
      const rows = await db
        .select({
          flag: pollFlags,
          question: polls.question,
          poll_type: polls.type,
        })
        .from(pollFlags)
        .innerJoin(polls, eq(pollFlags.pollId, polls.id))
        .orderBy(desc(pollFlags.createdAt))
        .limit(100);
      const filtered = query.status ? rows.filter((r) => r.flag.status === query.status) : rows;
      return reply.send({
        data: filtered.map((r) => ({
          id: r.flag.id,
          poll_id: r.flag.pollId,
          poll_question: r.question,
          poll_type: r.poll_type,
          kind: r.flag.kind,
          details: r.flag.details,
          status: r.flag.status,
          created_at: r.flag.createdAt.toISOString(),
        })),
        page: { next_cursor: null },
      });
    },
  );

  app.post(
    "/api/v1/admin/polls/:pollId/void-ballots",
    { preHandler: [requireAuth(ctx), requirePlatformRole(ctx, ["admin"])] },
    async (request, reply) => {
      const { pollId } = request.params as { pollId: string };
      const body = parseBody(
        z.object({
          voter_ids: z.array(z.string().uuid()).min(1).max(500).optional(),
          voterIds: z.array(z.string().uuid()).min(1).max(500).optional(),
          flag_id: z.string().uuid().optional(),
          reason: z.string().min(1).max(500),
        }),
        request.body,
      );
      let voterIds = body.voter_ids ?? body.voterIds ?? [];
      if (body.flag_id) {
        const [flag] = await db
          .select()
          .from(pollFlags)
          .where(eq(pollFlags.id, body.flag_id))
          .limit(1);
        if (!flag || flag.pollId !== pollId) throw notFound("Flag not found for this poll");
        const details = flag.details as { voter_ids?: string[] };
        voterIds = details.voter_ids ?? [];
        if (voterIds.length === 0) {
          throw unprocessable("This flag does not carry a voter list to void");
        }
        await db
          .update(pollFlags)
          .set({ status: "actioned", reviewedBy: request.authUser!.sub })
          .where(eq(pollFlags.id, flag.id));
      }
      const result = await voidBallots(db, request.authUser!.sub, pollId, voterIds, body.reason);
      const poll = await getPollById(db, pollId);
      return reply.send({
        voided: result.voided,
        results: poll ? await pollResultsFor(db, poll, request.authUser!.sub) : null,
      });
    },
  );

  app.post(
    "/api/v1/admin/polls/:pollId/void",
    { preHandler: [requireAuth(ctx), requirePlatformRole(ctx, ["admin"])] },
    async (request, reply) => {
      const { pollId } = request.params as { pollId: string };
      const body = parseBody(z.object({ reason: z.string().min(1).max(500) }), request.body);
      const poll = await voidWholePoll(db, request.authUser!.sub, pollId, body.reason);
      return reply.send(await pollWireFor(db, poll, request.authUser!.sub));
    },
  );

  // ─── Admin: Daily Pulse question bank (D-031) ───────────────────────────

  app.get(
    "/api/v1/admin/pulse-questions",
    { preHandler: [requireAuth(ctx), requirePlatformRole(ctx, ["moderator", "admin"])] },
    async (_request, reply) => {
      const rows = await db
        .select()
        .from(dailyPulseQuestions)
        .orderBy(desc(dailyPulseQuestions.createdAt))
        .limit(200);
      return reply.send({
        data: rows.map((row) => ({
          id: row.id,
          question: row.question,
          type: row.type,
          options: row.options,
          scheduled_date: row.scheduledDate,
          used_date: row.usedDate,
          is_active: row.isActive,
          created_at: row.createdAt.toISOString(),
        })),
        page: { next_cursor: null },
      });
    },
  );

  app.post(
    "/api/v1/admin/pulse-questions",
    { preHandler: [requireAuth(ctx), requirePlatformRole(ctx, ["admin"])] },
    async (request, reply) => {
      const body = parseBody(
        z.object({
          question: z.string().min(1).max(200),
          type: pollTypeSchema.optional(),
          options: z.array(z.string().min(1).max(80)).min(2).max(10),
          scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        }),
        request.body,
      );
      const [row] = await db
        .insert(dailyPulseQuestions)
        .values({
          id: uuidv7(),
          question: body.question,
          type: body.type ?? "single",
          options: body.options,
          scheduledDate: body.scheduled_date ?? null,
          createdBy: request.authUser!.sub,
        })
        .returning();
      return reply.status(201).send({
        id: row!.id,
        question: row!.question,
        type: row!.type,
        options: row!.options,
        scheduled_date: row!.scheduledDate,
        used_date: row!.usedDate,
        is_active: row!.isActive,
        created_at: row!.createdAt.toISOString(),
      });
    },
  );
}
