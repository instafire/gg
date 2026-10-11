/**
 * Debate routes (API_SPEC: Debates tag, Phase 3) + argument votes/evidence
 * + stance votes + state/perspective + genznewz "Debate this article".
 * One delta endpoint: POST /debates/{id}/judge-decision (D-032).
 */
import { and, desc, eq, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { communities, debateParticipants, debates, stanceVotes, users } from "../db/schema";
import { optionalAuth, requireAuth, requireScope } from "../lib/auth";
import { forbidden, notFound, unprocessable } from "../lib/errors";
import { decodeCursor, encodeCursor } from "../lib/pagination";
import { publishToUsers } from "../lib/realtime";
import { pageEnvelope } from "../lib/serializers";
import { parseBody } from "../lib/validate";
import { auditAgentAction } from "../services/agent-audit";
import { logEvent } from "../services/events";
import { emitDebateClosed, emitDebateTurnDue, emitWebhookEvent } from "../services/webhooks";
import {
  addEvidence,
  applyArgumentVote,
  argumentWireFor,
  castStanceVote,
  closeDebate,
  confirmSteelman,
  createArgument,
  createChallenge,
  createDebateWithPost,
  debateWireFor,
  fetchArticleCard,
  getDebateById,
  joinDebate,
  judgeDecision,
  listArguments,
  mindChangeStats,
  perspectiveFor,
  respondToChallenge,
  submitRoundArgument,
  type EvidenceInput,
} from "../services/debates";
import { getUserByHandle } from "../services/users";

const evidenceSchema = z.object({
  url: z.string().url(),
  kind: z.enum(["study", "news", "data", "personal_experience", "other"]),
  quote: z.string().max(500).optional(),
});

const debateCreateSchema = z.object({
  proposition: z.string().min(1).max(280),
  format: z.enum(["open", "structured_1v1", "team"]),
  community_slug: z.string().optional(),
  communitySlug: z.string().optional(),
  source_article_url: z.string().url().optional(),
  sourceArticleUrl: z.string().url().optional(),
  challenged_handle: z.string().optional(),
  challengedHandle: z.string().optional(),
  judge_handle: z.string().optional(),
  judgeHandle: z.string().optional(),
  challenger_side_key: z.string().optional(),
  side_key: z.string().optional(),
  turn_deadline_hours: z.number().int().min(1).max(168).optional(),
  live_turn_seconds: z.number().int().min(60).max(1800).optional(),
  per_turn_char_limit: z.number().int().min(280).max(10_000).optional(),
  rounds: z.number().int().min(1).max(7).optional(),
  steelman_required: z.boolean().optional(),
  steelmanRequired: z.boolean().optional(),
  scheduled_start_at: z.string().datetime().optional(),
  opening: z
    .object({
      side_key: z.string(),
      body_md: z.string().min(1).max(10_000),
      evidence: z.array(evidenceSchema).max(5).optional(),
    })
    .optional(),
  body_md: z.string().max(40_000).optional(),
});

async function communityIdForSlug(ctx: AppContext, slug: string | undefined): Promise<string | null> {
  if (!slug) return null;
  const [community] = await ctx.db
    .select()
    .from(communities)
    .where(eq(communities.slug, slug.toLowerCase()))
    .limit(1);
  if (!community) throw notFound("Community not found");
  return community.id;
}

async function userIdForHandle(ctx: AppContext, handle: string | undefined): Promise<string | null> {
  if (!handle) return null;
  const user = await getUserByHandle(ctx.db, handle.replace(/^@/, "").toLowerCase());
  if (!user) throw notFound(`User @${handle} not found`);
  return user.id;
}

export async function registerDebateRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db } = ctx;

  app.get("/api/v1/debates", { preHandler: optionalAuth(ctx) }, async (request, reply) => {
    const query = request.query as {
      status?: string;
      format?: string;
      community_slug?: string;
      topic?: string;
      cursor?: string;
      limit?: string;
    };
    const limit = Math.min(50, Math.max(1, Number(query.limit ?? 20) || 20));
    const conditions = [];
    if (query.status) conditions.push(eq(debates.status, query.status as typeof debates.$inferSelect.status));
    if (query.format) conditions.push(eq(debates.format, query.format as typeof debates.$inferSelect.format));
    if (query.community_slug) {
      const communityId = await communityIdForSlug(ctx, query.community_slug);
      conditions.push(eq(debates.communityId, communityId!));
    }
    if (query.cursor) {
      const cursor = decodeCursor<{ c: string }>(query.cursor);
      if (cursor) conditions.push(lt(debates.createdAt, new Date(cursor.c)));
    }
    let rows = await db
      .select()
      .from(debates)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(debates.createdAt))
      .limit(limit + 1);
    if (query.topic) {
      const needle = query.topic.toLowerCase();
      rows = rows.filter((r) => r.proposition.toLowerCase().includes(needle));
    }
    const page = rows.slice(0, limit);
    const wires = await Promise.all(
      page.map((row) => debateWireFor(db, row, request.authUser?.sub ?? null)),
    );
    const nextCursor =
      rows.length > limit && page.length > 0
        ? encodeCursor({ c: page[page.length - 1]!.createdAt.toISOString() })
        : null;
    return reply.send(pageEnvelope(wires, nextCursor));
  });

  app.post("/api/v1/debates", { preHandler: [requireAuth(ctx), requireScope("debate:participate")] }, async (request, reply) => {
    const body = parseBody(debateCreateSchema, request.body);
    const me = request.authUser!;
    const debate = await createDebateWithPost(
      db,
      { id: me.sub, authorType: me.authorType },
      {
        proposition: body.proposition,
        format: body.format,
        communityId: await communityIdForSlug(ctx, body.communitySlug ?? body.community_slug),
        sourceArticleUrl: body.source_article_url ?? body.sourceArticleUrl ?? null,
        challengedId: await userIdForHandle(ctx, body.challenged_handle ?? body.challengedHandle),
        judgeId: await userIdForHandle(ctx, body.judge_handle ?? body.judgeHandle),
        challengerSideKey: body.challenger_side_key ?? body.side_key ?? "for",
        turnDeadlineHours: body.turn_deadline_hours,
        liveTurnSeconds: body.live_turn_seconds ?? null,
        perTurnCharLimit: body.per_turn_char_limit,
        rounds: body.rounds,
        steelmanRequired: body.steelman_required ?? body.steelmanRequired,
        scheduledStartAt: body.scheduled_start_at ? new Date(body.scheduled_start_at) : null,
        opening: body.opening
          ? {
              sideKey: body.opening.side_key,
              bodyMd: body.opening.body_md,
              evidence: body.opening.evidence as EvidenceInput[] | undefined,
            }
          : body.body_md
            ? { sideKey: "for", bodyMd: body.body_md }
            : null,
      },
    );
    // Rounds config for later challenge-accept lives on the debate settings.
    if (body.rounds) {
      await db
        .update(debates)
        .set({ settings: { steelman_required: body.steelman_required ?? false, rounds: body.rounds } })
        .where(eq(debates.id, debate.id));
    }
    await auditAgentAction(db, request, "debate.create", "debate", debate.id);
    return reply.status(201).send(await debateWireFor(db, debate, me.sub));
  });

  app.post(
    "/api/v1/debates/from-article",
    { preHandler: [requireAuth(ctx), requireScope("debate:participate")] },
    async (request, reply) => {
      const body = parseBody(
        z.object({
          article_url: z.string().url(),
          articleUrl: z.string().url().optional(),
          proposition: z.string().min(1).max(280).optional(),
          community_slug: z.string().optional(),
          communitySlug: z.string().optional(),
        }),
        request.body,
      );
      const me = request.authUser!;
      const articleUrl = body.article_url ?? body.articleUrl!;
      const card = await fetchArticleCard(articleUrl);
      // Proposition defaults to the article's headline (D-031-style lazy
      // derivation): the hub's "Debate this article" flow pastes only a URL.
      const derivedTitle = (card.title ?? "").trim().slice(0, 280);
      const proposition =
        body.proposition ??
        (derivedTitle.length >= 10 ? derivedTitle : "This article's central claim holds up");
      const debate = await createDebateWithPost(
        db,
        { id: me.sub, authorType: me.authorType },
        {
          proposition,
          format: "open",
          communityId: await communityIdForSlug(ctx, body.communitySlug ?? body.community_slug),
          sourceArticleUrl: articleUrl,
          linkCard: { title: card.title, description: card.description, image: card.image },
        },
      );
      await auditAgentAction(db, request, "debate.create", "debate", debate.id, { source: "article" });
      return reply.status(201).send(await debateWireFor(db, debate, me.sub));
    },
  );

  app.get(
    "/api/v1/debates/:debateId",
    { preHandler: optionalAuth(ctx) },
    async (request, reply) => {
      const { debateId } = request.params as { debateId: string };
      const debate = await getDebateById(db, debateId);
      if (!debate) throw notFound("Debate not found");
      return reply.send(await debateWireFor(db, debate, request.authUser?.sub ?? null));
    },
  );

  app.patch(
    "/api/v1/debates/:debateId",
    { preHandler: [requireAuth(ctx), requireScope("debate:participate")] },
    async (request, reply) => {
      const { debateId } = request.params as { debateId: string };
      const debate = await getDebateById(db, debateId);
      if (!debate) throw notFound("Debate not found");
      const me = request.authUser!;
      if (debate.hostId !== me.sub && debate.judgeId !== me.sub) {
        throw forbidden("Only the host or judge can edit this debate");
      }
      const body = parseBody(
        z.object({
          proposition: z.string().min(1).max(280).optional(),
          scheduled_start_at: z.string().datetime().optional(),
        }),
        request.body,
      );
      const [updated] = await db
        .update(debates)
        .set({
          proposition: body.proposition ?? debate.proposition,
          scheduledStartAt: body.scheduled_start_at
            ? new Date(body.scheduled_start_at)
            : debate.scheduledStartAt,
        })
        .where(eq(debates.id, debate.id))
        .returning();
      return reply.send(await debateWireFor(db, updated!, me.sub));
    },
  );

  app.post(
    "/api/v1/debates/:debateId/join",
    { preHandler: [requireAuth(ctx), requireScope("debate:participate")] },
    async (request, reply) => {
      const { debateId } = request.params as { debateId: string };
      const body = parseBody(z.object({ side_key: z.string(), sideKey: z.string().optional() }), request.body);
      const me = request.authUser!;
      const debate = await joinDebate(
        db,
        { id: me.sub, authorType: me.authorType },
        debateId,
        body.sideKey ?? body.side_key,
      );
      await auditAgentAction(db, request, "debate.join", "debate", debate.id);
      return reply.send(await debateWireFor(db, debate, me.sub));
    },
  );

  app.post(
    "/api/v1/debates/:debateId/challenges",
    { preHandler: [requireAuth(ctx), requireScope("debate:participate")] },
    async (request, reply) => {
      const { debateId } = request.params as { debateId: string };
      const body = parseBody(
        z.object({
          challenged_handle: z.string(),
          side_key: z.string(),
          message: z.string().max(280).optional(),
        }),
        request.body,
      );
      const me = request.authUser!;
      const challengedId = await userIdForHandle(ctx, body.challenged_handle);
      const challenge = await createChallenge(
        db,
        { id: me.sub, authorType: me.authorType },
        debateId,
        { challengedId: challengedId!, sideKey: body.side_key, message: body.message ?? null },
      );
      {
        const debate = await getDebateById(db, debateId);
        if (debate) {
          await auditAgentAction(db, request, "debate.challenge", "debate", debate.id);
          await emitWebhookEvent(db, ctx.config, challengedId!, "debate.challenge", {
            debate_id: debate.id,
            challenge_id: challenge.id,
            challenger_handle: me.handle,
          });
        }
      }
      return reply.status(201).send(challenge);
    },
  );

  app.post(
    "/api/v1/debates/:debateId/challenges/:challengeId/respond",
    { preHandler: [requireAuth(ctx), requireScope("debate:participate")] },
    async (request, reply) => {
      const { debateId, challengeId } = request.params as { debateId: string; challengeId: string };
      const body = parseBody(z.object({ decision: z.enum(["accept", "decline"]) }), request.body);
      const me = request.authUser!;
      const debate = await getDebateById(db, debateId);
      const roundsCount =
        ((debate?.settings ?? {}) as { rounds?: number }).rounds ?? 3;
      const updated = await respondToChallenge(db, me.sub, debateId, challengeId, body.decision, roundsCount);
      await auditAgentAction(db, request, "debate.challenge.respond", "debate", updated.id, { decision: body.decision });
      if (body.decision === "accept") await emitDebateTurnDue(ctx, updated.id);
      return reply.send(await debateWireFor(db, updated, me.sub));
    },
  );

  app.get(
    "/api/v1/debates/:debateId/arguments",
    { preHandler: optionalAuth(ctx) },
    async (request, reply) => {
      const { debateId } = request.params as { debateId: string };
      const debate = await getDebateById(db, debateId);
      if (!debate) throw notFound("Debate not found");
      const query = request.query as { side_key?: string; round_no?: string; sort?: string };
      const wires = await listArguments(db, debate.id, {
        sideKey: query.side_key,
        roundNo: query.round_no ? Number(query.round_no) : undefined,
        sort: query.sort === "new" ? "new" : "top",
        viewerId: request.authUser?.sub ?? null,
      });
      return reply.send(pageEnvelope(wires, null));
    },
  );

  app.post(
    "/api/v1/debates/:debateId/arguments",
    { preHandler: [requireAuth(ctx), requireScope("debate:participate")] },
    async (request, reply) => {
      const { debateId } = request.params as { debateId: string };
      const body = parseBody(
        z.object({
          side_key: z.string(),
          sideKey: z.string().optional(),
          body_md: z.string().min(1),
          bodyMd: z.string().min(1).optional(),
          parent_argument_id: z.string().uuid().optional(),
          is_steelman: z.boolean().optional(),
          evidence: z.array(evidenceSchema).max(5).optional(),
        }),
        request.body,
      );
      const me = request.authUser!;
      const argument = await createArgument(
        db,
        { id: me.sub, authorType: me.authorType },
        debateId,
        {
          sideKey: body.sideKey ?? body.side_key,
          bodyMd: body.bodyMd ?? body.body_md,
          parentArgumentId: body.parent_argument_id ?? null,
          isSteelman: body.is_steelman ?? false,
          evidence: body.evidence as EvidenceInput[] | undefined,
        },
      );
      await auditAgentAction(db, request, "debate.argument", "debate", argument.debateId, { argument_id: argument.id });
      await auditAgentAction(db, request, "debate.evidence", "argument", argument.id);
      await logEvent(db, {
        userId: me.sub,
        type: "debate.argument",
        subjectType: "debate",
        subjectId: argument.debateId,
        props: { argument_id: argument.id },
      });
      return reply.status(201).send(await argumentWireFor(db, argument, me.sub));
    },
  );

  app.post(
    "/api/v1/debates/:debateId/rounds/:roundNo/submit",
    { preHandler: [requireAuth(ctx), requireScope("debate:participate")] },
    async (request, reply) => {
      const { debateId, roundNo } = request.params as { debateId: string; roundNo: string };
      const body = parseBody(
        z.object({
          body_md: z.string().min(1),
          bodyMd: z.string().min(1).optional(),
          is_steelman: z.boolean().optional(),
          evidence: z.array(evidenceSchema).max(5).optional(),
        }),
        request.body,
      );
      const me = request.authUser!;
      const debate = await submitRoundArgument(
        db,
        { id: me.sub, authorType: me.authorType },
        debateId,
        Number(roundNo),
        {
          bodyMd: body.bodyMd ?? body.body_md,
          isSteelman: body.is_steelman ?? false,
          evidence: body.evidence as EvidenceInput[] | undefined,
        },
      );
      await auditAgentAction(db, request, "debate.turn", "debate", debate.id, { round_no: Number(roundNo) });
      // Phase 5A (D-048): realtime turn ping to the other participants.
      const participantRows = await db
        .select({ userId: debateParticipants.userId })
        .from(debateParticipants)
        .where(eq(debateParticipants.debateId, debate.id));
      publishToUsers(
        participantRows.map((p) => p.userId),
        { type: "debate.turn", debate_id: debate.id, status: debate.status },
        me.sub,
      );
      if (debate.status === "closed") {
        await emitDebateClosed(ctx, debate, me.sub);
      } else {
        await emitDebateTurnDue(ctx, debate.id);
      }
      return reply.status(201).send(await debateWireFor(db, debate, me.sub));
    },
  );

  app.put(
    "/api/v1/arguments/:argumentId/vote",
    { preHandler: [requireAuth(ctx), requireScope("write:vote")] },
    async (request, reply) => {
      const { argumentId } = request.params as { argumentId: string };
      const body = parseBody(z.object({ value: z.enum(["up", "down"]) }), request.body);
      const me = request.authUser!;
      const summary = await applyArgumentVote(
        ctx,
        { id: me.sub, authorType: me.authorType },
        argumentId,
        body.value === "up" ? 1 : -1,
      );
      await auditAgentAction(db, request, "argument.vote", "argument", argumentId);
      return reply.send({
        up_count: summary.upCount,
        down_count: summary.downCount,
        score: summary.score,
        viewer_vote: summary.viewerVote === 1 ? "up" : summary.viewerVote === -1 ? "down" : null,
      });
    },
  );

  app.delete(
    "/api/v1/arguments/:argumentId/vote",
    { preHandler: [requireAuth(ctx), requireScope("write:vote")] },
    async (request, reply) => {
      const { argumentId } = request.params as { argumentId: string };
      const me = request.authUser!;
      const summary = await applyArgumentVote(
        ctx,
        { id: me.sub, authorType: me.authorType },
        argumentId,
        0,
      );
      await auditAgentAction(db, request, "argument.vote.retract", "argument", argumentId);
      return reply.send({
        up_count: summary.upCount,
        down_count: summary.downCount,
        score: summary.score,
        viewer_vote: null,
      });
    },
  );

  app.post(
    "/api/v1/arguments/:argumentId/evidence",
    { preHandler: [requireAuth(ctx), requireScope("debate:participate")] },
    async (request, reply) => {
      const { argumentId } = request.params as { argumentId: string };
      const body = parseBody(
        z.object({ evidence: z.array(evidenceSchema).min(1).max(5) }),
        request.body,
      );
      const me = request.authUser!;
      const argument = await addEvidence(db, me.sub, argumentId, body.evidence as EvidenceInput[]);
      return reply.status(201).send(await argumentWireFor(db, argument, me.sub));
    },
  );

  app.post(
    "/api/v1/arguments/:argumentId/steelman-confirm",
    { preHandler: [requireAuth(ctx), requireScope("debate:participate")] },
    async (request, reply) => {
      const { argumentId } = request.params as { argumentId: string };
      await confirmSteelman(db, request.authUser!.sub, argumentId);
      await auditAgentAction(db, request, "debate.steelman_confirm", "argument", argumentId);
      return reply.status(204).send();
    },
  );

  app.post(
    "/api/v1/debates/:debateId/stance-votes",
    { preHandler: [requireAuth(ctx), requireScope("write:vote")] },
    async (request, reply) => {
      const { debateId } = request.params as { debateId: string };
      const body = parseBody(
        z.object({
          phase: z.enum(["pre", "post"]),
          stance_value: z.number().int().min(-2).max(2),
          stanceValue: z.number().int().min(-2).max(2).optional(),
        }),
        request.body,
      );
      const me = request.authUser!;
      const debate = await getDebateById(db, debateId);
      if (!debate) throw notFound("Debate not found");
      await castStanceVote(
        db,
        { id: me.sub, authorType: me.authorType },
        debate.id,
        { phase: body.phase, stanceValue: body.stanceValue ?? body.stance_value },
      );
      await auditAgentAction(db, request, "debate.stance_vote", "debate", debate.id, { phase: body.phase });
      return reply.send(await debateStateFor(db, debate.id, me.sub));
    },
  );

  app.get(
    "/api/v1/debates/:debateId/state",
    { preHandler: optionalAuth(ctx) },
    async (request, reply) => {
      const { debateId } = request.params as { debateId: string };
      const debate = await getDebateById(db, debateId);
      if (!debate) throw notFound("Debate not found");
      return reply.send(await debateStateFor(db, debate.id, request.authUser?.sub ?? null));
    },
  );

  app.get(
    "/api/v1/debates/:debateId/perspective",
    { preHandler: optionalAuth(ctx) },
    async (request, reply) => {
      const { debateId } = request.params as { debateId: string };
      const debate = await getDebateById(db, debateId);
      if (!debate) throw notFound("Debate not found");
      const perspective = await perspectiveFor(db, debate, request.authUser?.sub ?? null);
      if (!perspective) throw notFound("No counter-argument yet");
      return reply.send(perspective);
    },
  );

  app.post(
    "/api/v1/debates/:debateId/close",
    { preHandler: [requireAuth(ctx), requireScope("debate:participate")] },
    async (request, reply) => {
      const { debateId } = request.params as { debateId: string };
      const debate = await getDebateById(db, debateId);
      if (!debate) throw notFound("Debate not found");
      const me = request.authUser!;
      const [meRow] = await db.select().from(users).where(eq(users.id, me.sub)).limit(1);
      const isPlatformAdmin = meRow?.platformRole === "admin";
      if (debate.hostId !== me.sub && debate.judgeId !== me.sub && !isPlatformAdmin) {
        throw unprocessable("Only the host, judge or a platform admin can close this debate");
      }
      const closed = await closeDebate(db, debate.id);
      await auditAgentAction(db, request, "debate.close", "debate", closed.id);
      await emitDebateClosed(ctx, closed, me.sub);
      return reply.send(await debateWireFor(db, closed, me.sub));
    },
  );

  app.post(
    "/api/v1/debates/:debateId/judge-decision",
    { preHandler: [requireAuth(ctx), requireScope("debate:participate")] },
    async (request, reply) => {
      const { debateId } = request.params as { debateId: string };
      const body = parseBody(
        z.object({
          winner_side_key: z.string().optional(),
          is_draw: z.boolean().optional(),
        }),
        request.body,
      );
      const updated = await judgeDecision(db, request.authUser!.sub, debateId, {
        winnerSideKey: body.winner_side_key ?? null,
        isDraw: body.is_draw ?? false,
      });
      await auditAgentAction(db, request, "debate.judge_decision", "debate", updated.id);
      return reply.send(await debateWireFor(db, updated, request.authUser!.sub));
    },
  );
}

/** DebateState wire (API_SPEC): distributions + viewer stance + turn clock. */
async function debateStateFor(
  db: AppContext["db"],
  debateId: string,
  viewerId: string | null,
) {
  const debate = await getDebateById(db, debateId);
  if (!debate) throw notFound("Debate not found");
  const wire = await debateWireFor(db, debate, viewerId);
  const stats = await mindChangeStats(db, debate);
  let viewerStance: { pre: number | null; post: number | null } | null = null;
  if (viewerId) {
    const rows = await db
      .select()
      .from(stanceVotes)
      .where(and(eq(stanceVotes.debateId, debateId), eq(stanceVotes.voterId, viewerId)));
    viewerStance = {
      pre: rows.find((r) => r.phase === "pre")?.stanceValue ?? null,
      post: rows.find((r) => r.phase === "post")?.stanceValue ?? null,
    };
  }
  const activeRound = wire.rounds.find((r) => r.status === "active");
  return {
    debate_id: debate.id,
    status: debate.status,
    sides: wire.sides,
    stance_distribution: stats.distribution,
    mind_changed_count: stats.changedCount,
    mind_change_rate: stats.rate,
    current_round: wire.current_round,
    turn_deadline_at: activeRound?.deadline_at ?? null,
    viewer_stance: viewerStance,
  };
}
