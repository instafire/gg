import { and, asc, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  COMMUNITY_POST_CHAR_LIMIT,
  POST_CHAR_LIMIT,
  TAKE_CHAR_LIMIT,
  postVoteSchema,
  reactionKindSchema,
} from "@gg/shared";
import type { AppContext } from "../context";
import {
  bookmarks,
  collections,
  communities,
  communityMembers,
  posts,
  reactions,
  users,
} from "../db/schema";
import { optionalAuth, requireAuth, requireScope } from "../lib/auth";
import { conflict, forbidden, notFound, unprocessable } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { decodeCursor, encodeCursor } from "../lib/pagination";
import { renderBodyHtml } from "../lib/render";
import { emptyBreakdown, pageEnvelope, type PostRow } from "../lib/serializers";
import { parseBody } from "../lib/validate";
import {
  applyVote,
  createPost,
  getPostByIdOrCode,
  hydratePosts,
  postPublishedCondition,
  publishScheduledPost,
  voteBreakdowns,
  type VoteSummary,
} from "../services/posts";
import { createDebateWithPost } from "../services/debates";
import { createPollWithPost } from "../services/polls";
import { auditAgentAction } from "../services/agent-audit";
import { emitPostWebhooks } from "../services/webhooks";
import { getUserByHandle } from "../services/users";
import { logEvent, logEventSoon } from "../services/events";
import { enqueuePostEmbedding } from "../lib/queue";
import {
  assertLockdownAllowsPost,
  runAutomod,
  type AutomodOutcome,
} from "../services/moderation";

/** Phase 5B: fetch the acting user's row (AutoMod author facts). */
async function authorRow(db: AppContext["db"], userId: string) {
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return row ?? null;
}

async function userIdForHandle(db: AppContext["db"], handle: string): Promise<string> {
  const user = await getUserByHandle(db, handle.replace(/^@/, "").toLowerCase());
  if (!user) throw notFound(`User @${handle} not found`);
  return user.id;
}

const createPostSchema = z.object({
  type: z.enum(["TEXT", "LINK", "IMAGE", "CAROUSEL", "VIDEO", "REEL", "POLL", "DEBATE", "STORY"]),
  body: z.string().optional(),
  bodyMd: z.string().optional(),
  body_md: z.string().optional(),
  // API_SPEC PostCreate: parent_id = reply, quoted_post_id = quote,
  // repost_of_id = repost (body must be empty). Both casings accepted.
  parentId: z.string().uuid().optional(),
  parent_id: z.string().uuid().optional(),
  quotedPostId: z.string().uuid().optional(),
  quoted_post_id: z.string().uuid().optional(),
  repostOfId: z.string().uuid().optional(),
  repost_of_id: z.string().uuid().optional(),
  title: z.string().max(300).nullable().optional(),
  linkUrl: z.string().optional(),
  link_url: z.string().optional(),
  communitySlug: z.string().optional(),
  community_slug: z.string().optional(),
  communityId: z.string().uuid().nullable().optional(),
  visibility: z
    .enum(["public", "followers", "community", "close_friends"])
    .optional(),
  isNsfw: z.boolean().optional(),
  isSpoiler: z.boolean().optional(),
  isLongForm: z.boolean().optional(),
  // Phase 5A: PostCreate.scheduled_for (spec) / scheduledFor (camel).
  scheduledFor: z.string().datetime().optional(),
  scheduled_for: z.string().datetime().optional(),
  // API_SPEC PostCreate.media_ids (≤ 10, ordered). Both casings accepted.
  mediaIds: z.array(z.string().uuid()).max(10).optional(),
  media_ids: z.array(z.string().uuid()).max(10).optional(),
  // Phase 3 inline payloads (API_SPEC PostCreate.poll / .debate).
  poll: z
    .object({
      question: z.string().min(1).max(200),
      type: z.enum(["single", "multiple", "ranked", "stance_slider", "image", "hot_take"]).optional(),
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
      is_anonymous: z.boolean().optional(),
      closes_at: z.string().datetime().optional(),
      min_trust_tier: z.enum(["T0", "T1", "T2", "T3"]).optional(),
      max_choices: z.number().int().min(1).max(10).optional(),
    })
    .optional(),
  debate: z
    .object({
      proposition: z.string().min(1).max(280),
      format: z.enum(["open", "structured_1v1", "team"]),
      community_slug: z.string().optional(),
      source_article_url: z.string().url().optional(),
      challenged_handle: z.string().optional(),
      judge_handle: z.string().optional(),
      turn_deadline_hours: z.number().int().min(1).max(168).optional(),
      live_turn_seconds: z.number().int().min(60).max(1800).optional(),
      per_turn_char_limit: z.number().int().min(280).max(10_000).optional(),
      steelman_required: z.boolean().optional(),
      scheduled_start_at: z.string().datetime().optional(),
    })
    .optional(),
});

const replySchema = z.object({
  body: z.string().optional(),
  bodyMd: z.string().optional(),
  body_md: z.string().optional(),
});

const threadQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  maxDepth: z.coerce.number().int().min(1).max(50).default(10),
});

function bodyOf(body: { body?: string; bodyMd?: string; body_md?: string }): string {
  return body.bodyMd ?? body.body_md ?? body.body ?? "";
}

/** API_SPEC VoteSummary + the D-012 split tally (vote_breakdown). */
async function voteWire(
  ctx: AppContext,
  post: PostRow,
  voterId: string,
  summary: VoteSummary,
): Promise<Record<string, unknown>> {
  const breakdowns = await voteBreakdowns(ctx.db, [post.id]);
  const withheldDown = post.communityId === null && voterId !== post.authorId;
  return {
    up_count: summary.upCount,
    down_count: withheldDown ? null : summary.downCount,
    score: summary.score,
    viewer_vote:
      summary.viewerVote === 1 ? "up" : summary.viewerVote === -1 ? "down" : null,
    vote_breakdown: breakdowns.get(post.id) ?? emptyBreakdown(),
  };
}

export async function registerPostRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db } = ctx;

  app.post("/api/v1/posts", { preHandler: [requireAuth(ctx), requireScope("write:post")] }, async (request, reply) => {
    const body = parseBody(createPostSchema, request.body);
    const me = request.authUser!;
    if (body.type === "STORY") {
      throw unprocessable("Post type STORY is created through the stories endpoints");
    }
    if (
      (body.scheduledFor ?? body.scheduled_for) &&
      (body.type === "POLL" || body.type === "DEBATE")
    ) {
      throw unprocessable("Poll and debate posts cannot be scheduled (D-050)");
    }
    const bodyMd = bodyOf(body);
    const parentId = body.parentId ?? body.parent_id ?? null;
    const quotedPostId = body.quotedPostId ?? body.quoted_post_id ?? null;
    const repostOfId = body.repostOfId ?? body.repost_of_id ?? null;
    const slug = body.communitySlug ?? body.community_slug;
    let communityId = body.communityId ?? null;
    if (slug) {
      const [community] = await db
        .select()
        .from(communities)
        .where(eq(communities.slug, slug.toLowerCase()))
        .limit(1);
      if (!community) throw notFound("Community not found");
      communityId = community.id;
    }
    let communityRow: typeof communities.$inferSelect | null = null;
    if (communityId) {
      const [membership] = await db
        .select()
        .from(communityMembers)
        .where(
          and(
            eq(communityMembers.communityId, communityId),
            eq(communityMembers.userId, me.sub),
            eq(communityMembers.status, "active"),
          ),
        )
        .limit(1);
      if (!membership) throw forbidden("Join this community before posting in it");
      // Phase 5B: mod-applied mutes block posting until muted_until passes.
      if (membership.mutedUntil && membership.mutedUntil.getTime() > Date.now()) {
        throw forbidden(
          `You are muted in this community until ${membership.mutedUntil.toISOString()}`,
        );
      }
      const [row] = await db
        .select()
        .from(communities)
        .where(eq(communities.id, communityId))
        .limit(1);
      communityRow = row ?? null;
      // Phase 5B: lockdown gate (mods + pre-lockdown members only).
      if (communityRow) {
        await assertLockdownAllowsPost(db, communityRow, me.sub);
      }
    }
    const limit = parentId
      ? POST_CHAR_LIMIT
      : communityId
        ? COMMUNITY_POST_CHAR_LIMIT
        : body.isLongForm
          ? TAKE_CHAR_LIMIT
          : POST_CHAR_LIMIT;
    if (bodyMd.length > limit) {
      throw unprocessable(`Post body exceeds the ${limit}-character limit for this context`);
    }
    const mediaIds = body.mediaIds ?? body.media_ids ?? [];
    // Reposts carry no body of their own (API_SPEC). Media posts treat the
    // body as a caption and may be empty; TEXT needs a body unless it
    // carries media attachments.
    if (
      body.type === "TEXT" &&
      !repostOfId &&
      mediaIds.length === 0 &&
      bodyMd.trim().length === 0
    ) {
      throw unprocessable("Post body must not be empty");
    }
    if (
      (body.type === "IMAGE" ||
        body.type === "CAROUSEL" ||
        body.type === "VIDEO" ||
        body.type === "REEL") &&
      mediaIds.length === 0
    ) {
      throw unprocessable(`${body.type} posts require media_ids`);
    }
    const linkUrl = body.linkUrl ?? body.link_url ?? null;
    if (body.type === "LINK") {
      if (!linkUrl) throw unprocessable("LINK posts require linkUrl");
      try {
        const url = new URL(linkUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
      } catch {
        throw unprocessable("linkUrl must be a valid http(s) URL");
      }
    }
    // Phase 3: POLL / DEBATE posts carry their inline payload and are built
    // by the opinion services (host post + poll/debate in one transaction).
    if (body.type === "POLL") {
      if (!body.poll) throw unprocessable("POLL posts require a poll object");
      if (parentId || quotedPostId || repostOfId) {
        throw unprocessable("Polls cannot be replies, quotes or reposts");
      }
      const { poll } = await createPollWithPost(
        db,
        { id: me.sub, authorType: me.authorType },
        {
          question: body.poll.question,
          type: body.poll.type ?? "single",
          options: (body.poll.options ?? []).map((o) => ({
            text: o.text ?? null,
            mediaId: o.media_id ?? o.mediaId ?? null,
          })),
          resultMode: body.poll.result_mode,
          isAnonymous: body.poll.is_anonymous,
          closesAt: body.poll.closes_at ? new Date(body.poll.closes_at) : null,
          minTrustTier: body.poll.min_trust_tier,
          maxChoices: body.poll.max_choices ?? null,
          communityId,
          bodyMd: bodyMd || null,
        },
      );
      const [hostPost] = await db
        .select()
        .from(posts)
        .where(eq(posts.id, poll.postId))
        .limit(1);
      const [wire] = await hydratePosts(db, [hostPost!], me.sub);
      await auditAgentAction(db, request, "poll.create", "poll", poll.id);
      await emitPostWebhooks(ctx, hostPost!);
      await logEvent(db, {
        userId: me.sub,
        type: "post.create",
        subjectType: "post",
        subjectId: hostPost!.id,
        props: { post_type: "POLL" },
      });
      await enqueuePostEmbedding(ctx.config, hostPost!.id);
      return reply.status(201).send(wire);
    }
    if (body.type === "DEBATE") {
      if (!body.debate) throw unprocessable("DEBATE posts require a debate object");
      if (parentId || quotedPostId || repostOfId) {
        throw unprocessable("Debates cannot be replies, quotes or reposts");
      }
      const debateCommunitySlug = body.debate.community_slug ?? slug;
      let debateCommunityId = communityId;
      if (debateCommunitySlug && debateCommunitySlug !== slug) {
        const [community] = await db
          .select()
          .from(communities)
          .where(eq(communities.slug, debateCommunitySlug.toLowerCase()))
          .limit(1);
        if (!community) throw notFound("Community not found");
        debateCommunityId = community.id;
      }
      const challengedId = body.debate.challenged_handle
        ? await userIdForHandle(db, body.debate.challenged_handle)
        : null;
      const judgeId = body.debate.judge_handle
        ? await userIdForHandle(db, body.debate.judge_handle)
        : null;
      const debate = await createDebateWithPost(
        db,
        { id: me.sub, authorType: me.authorType },
        {
          proposition: body.debate.proposition,
          format: body.debate.format,
          communityId: debateCommunityId,
          sourceArticleUrl: body.debate.source_article_url ?? null,
          challengedId,
          judgeId,
          turnDeadlineHours: body.debate.turn_deadline_hours,
          liveTurnSeconds: body.debate.live_turn_seconds ?? null,
          perTurnCharLimit: body.debate.per_turn_char_limit,
          steelmanRequired: body.debate.steelman_required,
          scheduledStartAt: body.debate.scheduled_start_at
            ? new Date(body.debate.scheduled_start_at)
            : null,
          opening: bodyMd ? { sideKey: "for", bodyMd } : null,
        },
      );
      const [hostPost] = await db
        .select()
        .from(posts)
        .where(eq(posts.id, debate.postId))
        .limit(1);
      const [wire] = await hydratePosts(db, [hostPost!], me.sub);
      await auditAgentAction(db, request, "debate.create", "debate", debate.id);
      await emitPostWebhooks(ctx, hostPost!);
      await logEvent(db, {
        userId: me.sub,
        type: "post.create",
        subjectType: "post",
        subjectId: hostPost!.id,
        props: { post_type: "DEBATE" },
      });
      await enqueuePostEmbedding(ctx.config, hostPost!.id);
      return reply.status(201).send(wire);
    }
    // Phase 5A (D-050): scheduling is top-level only and strictly future.
    const scheduledRaw = body.scheduledFor ?? body.scheduled_for ?? null;
    let scheduledFor: Date | null = null;
    if (scheduledRaw) {
      if (parentId || quotedPostId || repostOfId) {
        throw unprocessable("Only top-level posts can be scheduled");
      }
      scheduledFor = new Date(scheduledRaw);
      if (scheduledFor.getTime() <= Date.now()) {
        throw unprocessable("scheduled_for must be in the future");
      }
    }
    const post = await createPost(
      db,
      { id: me.sub, authorType: me.authorType },
      {
        type: body.type as "TEXT" | "LINK" | "IMAGE" | "CAROUSEL" | "VIDEO" | "REEL",
        bodyMd,
        title: body.title ?? null,
        linkUrl: body.type === "LINK" ? linkUrl : null,
        communityId,
        parentId,
        quotedPostId,
        repostOfId,
        visibility: body.visibility,
        isNsfw: body.isNsfw,
        isSpoiler: body.isSpoiler,
        isLongForm: body.isLongForm,
        mediaIds,
        scheduledFor,
      },
    );
    await auditAgentAction(db, request, post.parentId ? "post.reply" : "post.create", "post", post.id);
    // Scheduled posts emit their webhooks at publish time, not at create.
    if (!scheduledFor) await emitPostWebhooks(ctx, post);
    await logEvent(db, {
      userId: me.sub,
      type: "post.create",
      subjectType: "post",
      subjectId: post.id,
      props: { post_type: post.type, reply: Boolean(post.parentId) },
    });
    // Phase 5B AutoMod: community posts are screened synchronously; the
    // outcome rides back on the response so the author sees it immediately.
    let automod: AutomodOutcome | null = null;
    if (!scheduledFor && post.communityId) {
      const author = await authorRow(db, me.sub);
      if (author) automod = await runAutomod(db, post, author, request.log);
    }
    if (!scheduledFor && automod?.action !== "remove") {
      await enqueuePostEmbedding(ctx.config, post.id);
    }
    const [fresh] = await db
      .select()
      .from(posts)
      .where(eq(posts.id, post.id))
      .limit(1);
    const [wire] = await hydratePosts(db, [fresh ?? post], me.sub);
    return reply.status(201).send(
      automod
        ? {
            ...wire,
            automod: {
              action: automod.action,
              rule_id: automod.ruleId,
              rule_kind: automod.ruleKind,
              detail: automod.detail,
            },
          }
        : wire,
    );
  });

  app.post(
    "/api/v1/posts/:postId/replies",
    { preHandler: [requireAuth(ctx), requireScope("write:post")] },
    async (request, reply) => {
      const { postId } = request.params as { postId: string };
      const body = parseBody(replySchema, request.body);
      const me = request.authUser!;
      const parent = await getPostByIdOrCode(db, postId);
      if (!parent) throw notFound("Post not found");
      const bodyMd = bodyOf(body);
      if (bodyMd.trim().length === 0) throw unprocessable("Reply body must not be empty");
      if (bodyMd.length > POST_CHAR_LIMIT) {
        throw unprocessable(`Reply body exceeds the ${POST_CHAR_LIMIT}-character limit`);
      }
      // Phase 5B: lockdown also gates replies inside a locked community.
      if (parent.communityId) {
        const [community] = await db
          .select()
          .from(communities)
          .where(eq(communities.id, parent.communityId))
          .limit(1);
        if (community) await assertLockdownAllowsPost(db, community, me.sub);
      }
      const post = await createPost(
        db,
        { id: me.sub, authorType: me.authorType },
        { type: "TEXT", bodyMd, parentId: parent.id },
      );
      await auditAgentAction(db, request, "post.reply", "post", post.id, { parent_id: parent.id });
      await emitPostWebhooks(ctx, post);
      await logEvent(db, {
        userId: me.sub,
        type: "post.create",
        subjectType: "post",
        subjectId: post.id,
        props: { post_type: "TEXT", reply: true },
      });
      let automod: AutomodOutcome | null = null;
      if (post.communityId) {
        const author = await authorRow(db, me.sub);
        if (author) automod = await runAutomod(db, post, author, request.log);
      }
      const [fresh] = await db
        .select()
        .from(posts)
        .where(eq(posts.id, post.id))
        .limit(1);
      const [wire] = await hydratePosts(db, [fresh ?? post], me.sub);
      return reply.status(201).send(
        automod
          ? {
              ...wire,
              automod: {
                action: automod.action,
                rule_id: automod.ruleId,
                rule_kind: automod.ruleKind,
                detail: automod.detail,
              },
            }
          : wire,
      );
    },
  );

  // ── Direct replies (API_SPEC listReplies) — powers per-branch paging ────
  const repliesQuerySchema = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sort: z.enum(["best", "new", "top", "controversial"]).default("best"),
  });

  app.get(
    "/api/v1/posts/:postId/replies",
    { preHandler: optionalAuth(ctx) },
    async (request) => {
      const { postId } = request.params as { postId: string };
      const query = parseBody(repliesQuerySchema, request.query);
      const parent = await getPostByIdOrCode(db, postId);
      if (!parent) throw notFound("Post not found");
      const viewerId = request.authUser?.sub ?? null;
      if (
        parent.scheduledFor &&
        parent.scheduledFor.getTime() > Date.now() &&
        parent.authorId !== viewerId
      ) {
        throw notFound("Post not found");
      }
      const base = [
        eq(posts.parentId, parent.id),
        isNull(posts.deletedAt),
        postPublishedCondition(viewerId),
      ];

      let rows;
      let nextCursor: string | null = null;
      if (query.sort === "new") {
        const cursor = decodeCursor<{ createdAt: string; id: string }>(query.cursor);
        rows = await db
          .select()
          .from(posts)
          .where(
            and(
              ...base,
              cursor
                ? or(
                    lt(posts.createdAt, new Date(cursor.createdAt)),
                    and(
                      eq(posts.createdAt, new Date(cursor.createdAt)),
                      lt(posts.id, cursor.id),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(posts.createdAt), desc(posts.id))
          .limit(query.limit + 1);
        const pageRows = rows.slice(0, query.limit);
        const last = pageRows[pageRows.length - 1];
        nextCursor =
          rows.length > query.limit && last
            ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
            : null;
        rows = pageRows;
      } else {
        const offset = decodeCursor<{ offset: number }>(query.cursor)?.offset ?? 0;
        const order =
          query.sort === "controversial"
            ? [desc(sql<number>`coalesce(${posts.controversyRank}, 0)`), desc(posts.id)]
            : [desc(posts.score), desc(posts.createdAt), desc(posts.id)];
        rows = await db
          .select()
          .from(posts)
          .where(and(...base))
          .orderBy(...order)
          .limit(query.limit + 1)
          .offset(offset);
        nextCursor =
          rows.length > query.limit
            ? encodeCursor({ offset: offset + query.limit })
            : null;
        rows = rows.slice(0, query.limit);
      }
      const wires = await hydratePosts(db, rows, viewerId);
      return pageEnvelope(wires, nextCursor);
    },
  );

  // ── Subtree (API_SPEC getSubtree): flattened descendants, depth-capped, ─
  // with `depth` reported relative to the subtree root per the spec.
  const subtreeQuerySchema = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    max_depth: z.coerce.number().int().min(1).max(10).optional(),
    maxDepth: z.coerce.number().int().min(1).max(10).optional(),
  });

  app.get(
    "/api/v1/posts/:postId/subtree",
    { preHandler: optionalAuth(ctx) },
    async (request) => {
      const { postId } = request.params as { postId: string };
      const query = parseBody(subtreeQuerySchema, request.query);
      const focus = await getPostByIdOrCode(db, postId);
      if (!focus) throw notFound("Post not found");
      const maxDepth = query.max_depth ?? query.maxDepth ?? 5;
      const offset = decodeCursor<{ offset: number }>(query.cursor)?.offset ?? 0;
      const rows = await db
        .select()
        .from(posts)
        .where(
          and(
            sql`${posts.path} <@ ${focus.path} and ${posts.id} <> ${focus.id} and ${posts.depth} <= ${focus.depth + maxDepth}`,
            isNull(posts.deletedAt),
          ),
        )
        .orderBy(asc(posts.path))
        .limit(query.limit + 1)
        .offset(offset);
      const pageRows = rows.slice(0, query.limit);
      const wires = await hydratePosts(
        db,
        pageRows,
        request.authUser?.sub ?? null,
      );
      return pageEnvelope(
        wires.map((wire) => ({ ...wire, depth: wire.depth - focus.depth })),
        rows.length > query.limit
          ? encodeCursor({ offset: offset + query.limit })
          : null,
      );
    },
  );

  app.get(
    "/api/v1/posts/:postId",
    { preHandler: optionalAuth(ctx) },
    async (request) => {
      const { postId } = request.params as { postId: string };
      const post = await getPostByIdOrCode(db, postId);
      if (!post) throw notFound("Post not found");
      // Phase 5A (D-050): unpublished scheduled posts are author-only.
      if (
        post.scheduledFor &&
        post.scheduledFor.getTime() > Date.now() &&
        post.authorId !== request.authUser?.sub
      ) {
        throw notFound("Post not found");
      }
      // Phase 5B: held posts are author + community-mod only.
      if (post.heldAt && post.authorId !== request.authUser?.sub) {
        const viewerId = request.authUser?.sub;
        const isMod =
          viewerId && post.communityId
            ? await (async () => {
                const [membership] = await db
                  .select({ role: communityMembers.role, status: communityMembers.status })
                  .from(communityMembers)
                  .where(
                    and(
                      eq(communityMembers.communityId, post.communityId!),
                      eq(communityMembers.userId, viewerId),
                    ),
                  )
                  .limit(1);
                return (
                  membership?.status === "active" &&
                  ["owner", "admin", "moderator"].includes(membership.role)
                );
              })()
            : false;
        if (!isMod) throw notFound("Post not found");
      }
      const [wire] = await hydratePosts(db, [post], request.authUser?.sub ?? null);
      logEventSoon(
        db,
        {
          userId: request.authUser?.sub ?? null,
          type: "post.view",
          subjectType: "post",
          subjectId: post.id,
          props: { self: post.authorId === request.authUser?.sub },
        },
        request.log,
      );
      return wire;
    },
  );

  // ── Edit own post (API_SPEC updatePost / PostUpdate) ────────────────────
  const updatePostSchema = z.object({
    body: z.string().optional(),
    bodyMd: z.string().optional(),
    body_md: z.string().optional(),
    title: z.string().max(300).nullable().optional(),
    isNsfw: z.boolean().optional(),
    is_nsfw: z.boolean().optional(),
    isSpoiler: z.boolean().optional(),
    is_spoiler: z.boolean().optional(),
    flairId: z.string().uuid().nullable().optional(),
    flair_id: z.string().uuid().nullable().optional(),
    // Phase 5A (D-050): reschedule (future datetime) or publish now (null).
    scheduledFor: z.string().datetime().nullable().optional(),
    scheduled_for: z.string().datetime().nullable().optional(),
  });

  app.patch(
    "/api/v1/posts/:postId",
    { preHandler: [requireAuth(ctx), requireScope("write:post")] },
    async (request) => {
      const { postId } = request.params as { postId: string };
      const me = request.authUser!;
      const post = await getPostByIdOrCode(db, postId);
      if (!post) throw notFound("Post not found");
      if (post.authorId !== me.sub) throw forbidden("Only the author can edit this post");
      if (post.deletedAt) throw conflict("A deleted post cannot be edited");
      if (post.isLocked) throw conflict("This post is locked");
      if (post.removedBy) throw conflict("A removed post cannot be edited");
      const body = parseBody(updatePostSchema, request.body);
      // Phase 5A (D-050): schedule changes on a still-scheduled post.
      const scheduledRaw =
        body.scheduledFor !== undefined ? body.scheduledFor : body.scheduled_for;
      if (scheduledRaw !== undefined) {
        if (!post.scheduledFor) {
          throw unprocessable("Only a scheduled post can be rescheduled or published early");
        }
        if (scheduledRaw === null) {
          const published = await publishScheduledPost(db, post);
          await emitPostWebhooks(ctx, published);
          await auditAgentAction(db, request, "post.publish", "post", post.id);
          const [wire] = await hydratePosts(db, [published], me.sub);
          return wire;
        }
        const when = new Date(scheduledRaw);
        if (when.getTime() <= Date.now()) {
          throw unprocessable("scheduled_for must be in the future");
        }
        const [updated] = await db
          .update(posts)
          .set({ scheduledFor: when, updatedAt: new Date() })
          .where(eq(posts.id, post.id))
          .returning();
        await auditAgentAction(db, request, "post.reschedule", "post", post.id);
        const [wire] = await hydratePosts(db, [updated!], me.sub);
        return wire;
      }
      const patch: Partial<PostRow> = {};
      const newBody = body.bodyMd ?? body.body_md ?? body.body;
      if (newBody !== undefined) {
        if (post.type === "TEXT" && newBody.trim().length === 0) {
          throw unprocessable("Post body must not be empty");
        }
        const limit = post.communityId
          ? COMMUNITY_POST_CHAR_LIMIT
          : post.isLongForm
            ? TAKE_CHAR_LIMIT
            : POST_CHAR_LIMIT;
        if (newBody.length > limit) {
          throw unprocessable(
            `Post body exceeds the ${limit}-character limit for this context`,
          );
        }
        patch.bodyMd = newBody;
        patch.bodyHtml = renderBodyHtml(newBody);
      }
      if (body.title !== undefined) patch.title = body.title;
      const isNsfw = body.isNsfw ?? body.is_nsfw;
      if (isNsfw !== undefined) patch.isNsfw = isNsfw;
      const isSpoiler = body.isSpoiler ?? body.is_spoiler;
      if (isSpoiler !== undefined) patch.isSpoiler = isSpoiler;
      const flairId = body.flairId ?? body.flair_id;
      if (flairId !== undefined) patch.flairId = flairId;
      if (Object.keys(patch).length === 0) {
        const [wire] = await hydratePosts(db, [post], me.sub);
        return wire;
      }
      const [updated] = await db
        .update(posts)
        .set({ ...patch, editedAt: new Date(), editCount: post.editCount + 1 })
        .where(eq(posts.id, post.id))
        .returning();
      await auditAgentAction(db, request, "post.update", "post", post.id);
      // Phase 5B: keep the semantic index in step with edits.
      if (patch.bodyMd !== undefined || patch.title !== undefined) {
        await enqueuePostEmbedding(ctx.config, post.id);
      }
      const [wire] = await hydratePosts(db, [updated!], me.sub);
      return wire;
    },
  );

  app.get(
    "/api/v1/posts/:postId/thread",
    { preHandler: optionalAuth(ctx) },
    async (request) => {
      const { postId } = request.params as { postId: string };
      const query = parseBody(threadQuerySchema, request.query);
      const focus = await getPostByIdOrCode(db, postId);
      if (!focus) throw notFound("Post not found");
      const threadViewerId = request.authUser?.sub ?? null;
      if (
        focus.scheduledFor &&
        focus.scheduledFor.getTime() > Date.now() &&
        focus.authorId !== threadViewerId
      ) {
        throw notFound("Post not found");
      }
      const [root] = await db
        .select()
        .from(posts)
        .where(eq(posts.id, focus.rootId))
        .limit(1);
      const ancestorRows = await db
        .select()
        .from(posts)
        .where(sql`${posts.path} @> ${focus.path} and ${posts.id} <> ${focus.id}`)
        .orderBy(asc(posts.depth));
      const offset = decodeCursor<{ offset: number }>(query.cursor)?.offset ?? 0;
      const subtreeRows = await db
        .select()
        .from(posts)
        .where(
          sql`${posts.path} <@ ${focus.path} and ${posts.depth} <= ${focus.depth + query.maxDepth} and ${postPublishedCondition(threadViewerId)}`,
        )
        .orderBy(asc(posts.path))
        .limit(query.limit + 1)
        .offset(offset);
      const pageRows = subtreeRows.slice(0, query.limit);
      const hydrated = await hydratePosts(
        db,
        [root!, focus, ...ancestorRows, ...pageRows],
        threadViewerId,
      );
      const byId = new Map(hydrated.map((wire) => [wire.id, wire]));
      const nextCursor =
        subtreeRows.length > query.limit
          ? encodeCursor({ offset: offset + query.limit })
          : null;
      return {
        root: byId.get(root!.id),
        focus: byId.get(focus.id),
        ancestors: ancestorRows.map((row) => byId.get(row.id)),
        // PostPage envelope; the subtree page includes the focus post itself.
        replies: pageEnvelope(
          pageRows.filter((p) => p.id !== focus.id).map((row) => byId.get(row.id)!),
          nextCursor,
        ),
      };
    },
  );

  app.delete(
    "/api/v1/posts/:postId",
    { preHandler: [requireAuth(ctx), requireScope("write:post")] },
    async (request, reply) => {
      const { postId } = request.params as { postId: string };
      const me = request.authUser!;
      const post = await getPostByIdOrCode(db, postId);
      if (!post) throw notFound("Post not found");
      if (post.authorId !== me.sub) throw forbidden("Only the author can delete this post");
      if (!post.deletedAt) {
        await db
          .update(posts)
          .set({
            deletedAt: new Date(),
            deleteReason: { by: "author" },
          })
          .where(eq(posts.id, post.id));
      }
      await auditAgentAction(db, request, "post.delete", "post", post.id);
      return reply.status(204).send();
    },
  );

  const voteHandler = async (request: FastifyRequest) => {
    const { postId } = request.params as { postId: string };
    const raw = (request.body ?? {}) as { value?: unknown };
    const normalized =
      raw.value === "up" ? 1 : raw.value === "down" ? -1 : raw.value;
    const body = parseBody(postVoteSchema, { value: normalized });
    const post = await getPostByIdOrCode(db, postId);
    if (
      !post ||
      (post.scheduledFor &&
        post.scheduledFor.getTime() > Date.now() &&
        post.authorId !== request.authUser!.sub)
    ) {
      throw notFound("Post not found");
    }
    const keyHeader = request.headers["idempotency-key"];
    const summary = await applyVote(
      ctx,
      { id: request.authUser!.sub, authorType: request.authUser!.authorType },
      post.id,
      body.value,
      typeof keyHeader === "string" ? keyHeader : undefined,
    );
    await auditAgentAction(db, request, "vote.cast", "post", post.id);
    await logEvent(db, {
      userId: request.authUser!.sub,
      type: "post.vote",
      subjectType: "post",
      subjectId: post.id,
      props: { value: body.value },
    });
    return voteWire(ctx, post, request.authUser!.sub, summary);
  };

  app.post("/api/v1/posts/:postId/vote", { preHandler: [requireAuth(ctx), requireScope("write:vote")] }, voteHandler);
  app.put("/api/v1/posts/:postId/vote", { preHandler: [requireAuth(ctx), requireScope("write:vote")] }, voteHandler);
  app.delete(
    "/api/v1/posts/:postId/vote",
    { preHandler: [requireAuth(ctx), requireScope("write:vote")] },
    async (request) => {
      const { postId } = request.params as { postId: string };
      const post = await getPostByIdOrCode(db, postId);
      if (
        !post ||
        (post.scheduledFor &&
          post.scheduledFor.getTime() > Date.now() &&
          post.authorId !== request.authUser!.sub)
      ) {
        throw notFound("Post not found");
      }
      const summary = await applyVote(
        ctx,
        { id: request.authUser!.sub, authorType: request.authUser!.authorType },
        post.id,
        0,
      );
      await auditAgentAction(db, request, "vote.retract", "post", post.id);
      return voteWire(ctx, post, request.authUser!.sub, summary);
    },
  );

  app.post(
    "/api/v1/posts/:postId/reactions",
    { preHandler: [requireAuth(ctx), requireScope("write:post")] },
    async (request) => {
      const { postId } = request.params as { postId: string };
      const body = parseBody(z.object({ kind: reactionKindSchema }), request.body);
      const me = request.authUser!;
      const post = await getPostByIdOrCode(db, postId);
      if (
        !post ||
        post.deletedAt ||
        (post.scheduledFor &&
          post.scheduledFor.getTime() > Date.now() &&
          post.authorId !== me.sub)
      ) {
        throw notFound("Post not found");
      }
      const counts = await db.transaction(async (tx) => {
        await tx
          .insert(reactions)
          .values({
            id: uuidv7(),
            userId: me.sub,
            targetType: "post",
            targetId: post.id,
            kind: body.kind,
          })
          .onConflictDoNothing();
        const rows = await tx
          .select({ kind: reactions.kind, count: sql<number>`count(*)::int` })
          .from(reactions)
          .where(and(eq(reactions.targetType, "post"), eq(reactions.targetId, post.id)))
          .groupBy(reactions.kind);
        const map: Record<string, number> = {};
        for (const row of rows) map[row.kind] = row.count;
        await tx
          .update(posts)
          .set({ reactionCounts: map })
          .where(eq(posts.id, post.id));
        return map;
      });
      return { counts };
    },
  );

  app.delete(
    "/api/v1/posts/:postId/reactions",
    { preHandler: [requireAuth(ctx), requireScope("write:post")] },
    async (request, reply) => {
      const { postId } = request.params as { postId: string };
      const query = parseBody(z.object({ kind: reactionKindSchema }), request.query);
      const me = request.authUser!;
      const post = await getPostByIdOrCode(db, postId);
      if (!post) throw notFound("Post not found");
      await db.transaction(async (tx) => {
        await tx
          .delete(reactions)
          .where(
            and(
              eq(reactions.userId, me.sub),
              eq(reactions.targetType, "post"),
              eq(reactions.targetId, post.id),
              eq(reactions.kind, query.kind),
            ),
          );
        const rows = await tx
          .select({ kind: reactions.kind, count: sql<number>`count(*)::int` })
          .from(reactions)
          .where(and(eq(reactions.targetType, "post"), eq(reactions.targetId, post.id)))
          .groupBy(reactions.kind);
        const map: Record<string, number> = {};
        for (const row of rows) map[row.kind] = row.count;
        await tx.update(posts).set({ reactionCounts: map }).where(eq(posts.id, post.id));
      });
      return reply.status(204).send();
    },
  );

  app.post(
    "/api/v1/posts/:postId/bookmark",
    { preHandler: [requireAuth(ctx), requireScope("write:post")] },
    async (request, reply) => {
      const { postId } = request.params as { postId: string };
      const me = request.authUser!;
      const post = await getPostByIdOrCode(db, postId);
      if (
        !post ||
        post.deletedAt ||
        (post.scheduledFor &&
          post.scheduledFor.getTime() > Date.now() &&
          post.authorId !== me.sub)
      ) {
        throw notFound("Post not found");
      }
      const body = (request.body ?? {}) as { collection_id?: string; collectionId?: string };
      const collectionId = body.collectionId ?? body.collection_id ?? null;
      if (collectionId) {
        const [collection] = await db
          .select()
          .from(collections)
          .where(eq(collections.id, collectionId))
          .limit(1);
        if (!collection || collection.ownerId !== me.sub) {
          throw notFound("Collection not found");
        }
      }
      // Phase 5A: upsert — re-bookmarking with a collection moves the
      // bookmark; save_count only grows for genuinely new bookmarks.
      const [existing] = await db
        .select()
        .from(bookmarks)
        .where(and(eq(bookmarks.userId, me.sub), eq(bookmarks.postId, post.id)))
        .limit(1);
      await db
        .insert(bookmarks)
        .values({ userId: me.sub, postId: post.id, collectionId })
        .onConflictDoUpdate({
          target: [bookmarks.userId, bookmarks.postId],
          set: { collectionId },
        });
      const bumpCollection = async (id: string | null, delta: 1 | -1) => {
        if (!id) return;
        await db
          .update(collections)
          .set({
            itemCount:
              delta === 1
                ? sql`${collections.itemCount} + 1`
                : sql`greatest(${collections.itemCount} - 1, 0)`,
            updatedAt: new Date(),
          })
          .where(eq(collections.id, id));
      };
      if (!existing) {
        await db
          .update(posts)
          .set({ saveCount: sql`${posts.saveCount} + 1` })
          .where(eq(posts.id, post.id));
        await bumpCollection(collectionId, 1);
      } else if (existing.collectionId !== collectionId) {
        await bumpCollection(existing.collectionId, -1);
        await bumpCollection(collectionId, 1);
      }
      return reply.status(204).send();
    },
  );

  app.delete(
    "/api/v1/posts/:postId/bookmark",
    { preHandler: [requireAuth(ctx), requireScope("write:post")] },
    async (request, reply) => {
      const { postId } = request.params as { postId: string };
      const me = request.authUser!;
      const post = await getPostByIdOrCode(db, postId);
      if (!post) throw notFound("Post not found");
      const deleted = await db
        .delete(bookmarks)
        .where(and(eq(bookmarks.userId, me.sub), eq(bookmarks.postId, post.id)))
        .returning();
      if (deleted.length > 0) {
        await db
          .update(posts)
          .set({ saveCount: sql`greatest(${posts.saveCount} - 1, 0)` })
          .where(eq(posts.id, post.id));
        const removedFrom = deleted[0]!.collectionId;
        if (removedFrom) {
          await db
            .update(collections)
            .set({
              itemCount: sql`greatest(${collections.itemCount} - 1, 0)`,
              updatedAt: new Date(),
            })
            .where(eq(collections.id, removedFrom));
        }
      }
      return reply.status(204).send();
    },
  );

  // ── My scheduled posts (Phase 5A, D-050; spec delta) ───────────────────
  app.get(
    "/api/v1/users/me/scheduled",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const me = request.authUser!;
      const rows = await db
        .select()
        .from(posts)
        .where(
          and(
            eq(posts.authorId, me.sub),
            isNull(posts.deletedAt),
            sql`${posts.scheduledFor} is not null`,
          ),
        )
        .orderBy(asc(posts.scheduledFor));
      const wires = await hydratePosts(db, rows, me.sub);
      return pageEnvelope(wires, null);
    },
  );
}
