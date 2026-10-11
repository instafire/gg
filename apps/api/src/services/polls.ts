/**
 * Polls (DATA_MODEL §6, Phase 3) — creation with host post, ballots with
 * integrity gates, results with split tallies + opt-in breakdowns, close,
 * admin voiding, anomaly flags, and the Daily Pulse (D-031).
 *
 * Invariants (D-016 pattern): counters on polls/poll_options are maintained
 * in the SAME transaction as the ballot row; every ballot mutation writes a
 * poll_vote_audit row in that transaction. Voided ballots are excluded from
 * every tally by construction (counters are decremented at void time).
 */
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { etMidnightAfter, etToday, tallyIrv, type IrvResult } from "@gg/shared";
import type { AppConfig } from "../config";
import type { AppContext } from "../context";
import type { Db } from "../db";
import {
  auditLogs,
  dailyPulseQuestions,
  media,
  pollFlags,
  pollOptions,
  pollVoteAudit,
  pollVoteChoices,
  pollVotes,
  polls,
  posts,
  userSettings,
  users,
} from "../db/schema";
import {
  conflict,
  forbidden,
  notFound,
  tooManyRequests,
  unprocessable,
} from "../lib/errors";
import { pathLabel, shortCode, uuidv7 } from "../lib/ids";
import { renderBodyHtml } from "../lib/render";
import { effectiveTrustTier } from "../lib/trust-tier";
import {
  mediaWire,
  type PollOptionResultWire,
  type PollResultsWire,
  type PollRow,
  type PollViewerBallot,
  type PollWire,
} from "../lib/serializers";
import { recordMentionsAndNotify } from "./notifications";
import type { AuthorRef } from "./posts";

export type PollRowT = PollRow;
type PollOptionRow = typeof pollOptions.$inferSelect;
type PollVoteRow = typeof pollVotes.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const TIER_RANK: Record<string, number> = { T0: 0, T1: 1, T2: 2, T3: 3 };
/** Breakdown cells below this count are suppressed (§6.3 anonymity threshold, D-029). */
export const BREAKDOWN_MIN_CELL = 5;

export const HOT_TAKE_OPTIONS = ["Agree", "Nuanced", "Disagree"] as const;

// ─── Creation ────────────────────────────────────────────────────────────────

export interface PollOptionInput {
  text?: string | null;
  mediaId?: string | null;
}

export interface CreatePollInput {
  question: string;
  type: PollRow["type"];
  options: PollOptionInput[];
  resultMode?: PollRow["resultMode"];
  isAnonymous?: boolean;
  closesAt?: Date | null;
  minTrustTier?: PollRow["minTrustTier"];
  minAccountAgeDays?: number;
  maxChoices?: number | null;
  communityId?: string | null;
  bodyMd?: string | null;
  isDailyPulse?: boolean;
  pulseDate?: string | null;
}

function ballotSnapshot(ballot: {
  optionId: string | null;
  ranking: string[] | null;
  sliderValue: number | null;
  choiceIds?: string[];
}): Record<string, unknown> {
  return {
    option_id: ballot.optionId,
    option_ids: ballot.choiceIds ?? [],
    ranking: ballot.ranking,
    slider_value: ballot.sliderValue,
  };
}

/**
 * Create a poll + its host POLL post in one transaction (mirrors the root
 * path of createPost — ltree label, counters, mention notifications — then
 * links post.poll_id ↔ polls.post_id both ways).
 */
export async function createPollWithPost(
  db: Db,
  author: AuthorRef,
  input: CreatePollInput,
): Promise<{ poll: PollRow; options: PollOptionRow[] }> {
  const question = input.question.trim();
  if (question.length === 0 || question.length > 200) {
    throw unprocessable("Poll question must be 1–200 characters");
  }
  let optionInputs = input.options;
  if (input.type === "hot_take") {
    optionInputs = HOT_TAKE_OPTIONS.map((text) => ({ text }));
  }
  if (input.type === "stance_slider") {
    optionInputs = [];
  }
  if (input.type !== "stance_slider" && input.type !== "hot_take") {
    if (optionInputs.length < 2 || optionInputs.length > 10) {
      throw unprocessable("Polls need 2–10 options");
    }
  }
  for (const option of optionInputs) {
    if (input.type === "image") {
      if (!option.mediaId) throw unprocessable("Image poll options each need a media_id");
      if (option.text && option.text.length > 80) {
        throw unprocessable("Poll option text must be ≤ 80 characters");
      }
    } else if (!option.text || option.text.trim().length === 0 || option.text.length > 80) {
      throw unprocessable("Poll options need text of 1–80 characters");
    }
  }
  if (input.type === "multiple") {
    const max = input.maxChoices ?? optionInputs.length;
    if (max < 1 || max > optionInputs.length) {
      throw unprocessable("max_choices must be between 1 and the number of options");
    }
  }
  if (input.closesAt && input.closesAt.getTime() <= Date.now()) {
    throw unprocessable("closes_at must be in the future");
  }

  return db.transaction(async (tx) => {
    // Image options: media must exist, be the author's, and be ready.
    const mediaIds = [...new Set(optionInputs.map((o) => o.mediaId).filter((id): id is string => !!id))];
    if (mediaIds.length > 0) {
      const rows = await tx.select().from(media).where(inArray(media.id, mediaIds));
      if (rows.length !== mediaIds.length) throw unprocessable("Option media not found");
      for (const row of rows) {
        if (row.uploaderId !== author.id) {
          throw forbidden("You can only use your own media in a poll");
        }
        if (row.status !== "ready") {
          throw unprocessable("Option media is not ready yet");
        }
        if (row.kind !== "image" && row.kind !== "gif") {
          throw unprocessable("Image poll options must be images");
        }
      }
    }

    const postId = uuidv7();
    const label = pathLabel(postId);
    const bodyMd = input.bodyMd ?? "";
    const [post] = await tx
      .insert(posts)
      .values({
        id: postId,
        shortCode: shortCode(),
        authorId: author.id,
        authorType: author.authorType,
        type: "POLL",
        rootId: postId,
        path: label,
        pathLabel: label,
        depth: 0,
        communityId: input.communityId ?? null,
        title: question,
        bodyMd,
        bodyHtml: renderBodyHtml(bodyMd),
        visibility: input.communityId ? "community" : "public",
      })
      .returning();

    const pollId = uuidv7();
    const [poll] = await tx
      .insert(polls)
      .values({
        id: pollId,
        postId,
        type: input.type,
        question,
        resultMode: input.resultMode ?? "live",
        isAnonymous: input.isAnonymous ?? false,
        closesAt: input.closesAt ?? null,
        maxChoices: input.type === "multiple" ? (input.maxChoices ?? optionInputs.length) : null,
        minTrustTier: input.minTrustTier ?? "T1",
        minAccountAgeDays: input.minAccountAgeDays ?? 0,
        isDailyPulse: input.isDailyPulse ?? false,
        pulseDate: input.pulseDate ?? null,
      })
      .returning();
    await tx.update(posts).set({ pollId }).where(eq(posts.id, postId));

    const options: PollOptionRow[] = [];
    for (const [position, option] of optionInputs.entries()) {
      const [row] = await tx
        .insert(pollOptions)
        .values({
          id: uuidv7(),
          pollId,
          position,
          text: option.text?.trim() ?? "",
          mediaId: option.mediaId ?? null,
        })
        .returning();
      options.push(row!);
    }
    if (bodyMd) await recordMentionsAndNotify(tx, post!, []);
    return { poll: poll!, options };
  });
}

export async function getPollById(db: Db, pollId: string): Promise<PollRow | null> {
  const [row] = await db.select().from(polls).where(eq(polls.id, pollId)).limit(1);
  return row ?? null;
}

export async function getPollOptions(db: Db, pollId: string): Promise<PollOptionRow[]> {
  return db
    .select()
    .from(pollOptions)
    .where(eq(pollOptions.pollId, pollId))
    .orderBy(asc(pollOptions.position));
}

export function pollIsClosed(poll: PollRow): boolean {
  return poll.closedAt !== null || (poll.closesAt !== null && poll.closesAt.getTime() <= Date.now());
}

// ─── Wires ───────────────────────────────────────────────────────────────────

async function optionMediaMap(db: Db, options: PollOptionRow[]) {
  const ids = options.map((o) => o.mediaId).filter((id): id is string => !!id);
  const map = new Map<string, ReturnType<typeof mediaWire>>();
  if (ids.length === 0) return map;
  const rows = await db.select().from(media).where(inArray(media.id, ids));
  for (const row of rows) map.set(row.id, mediaWire(row));
  return map;
}

function optionResults(
  poll: PollRow,
  options: PollOptionRow[],
  mediaById: Map<string, ReturnType<typeof mediaWire>>,
  visible: boolean,
  firstPrefs?: Map<string, { human: number; agent: number }>,
): PollOptionResultWire[] {
  return options.map((option) => {
    const counts = firstPrefs?.get(option.id) ?? {
      human: option.voteCount,
      agent: option.agentVoteCount,
    };
    return {
      id: option.id,
      position: option.position,
      text: option.text,
      media: option.mediaId ? (mediaById.get(option.mediaId) ?? null) : null,
      human_votes: visible ? counts.human : 0,
      agent_votes: visible ? counts.agent : 0,
      share: visible && poll.totalVotes > 0 ? counts.human / poll.totalVotes : 0,
    };
  });
}

export async function viewerBallotOf(
  db: Db,
  pollId: string,
  viewerId: string | null,
): Promise<{ ballot: PollVoteRow | null; wire: PollViewerBallot | null }> {
  if (!viewerId) return { ballot: null, wire: null };
  const [ballot] = await db
    .select()
    .from(pollVotes)
    .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.voterId, viewerId)))
    .limit(1);
  if (!ballot || ballot.voidedAt) return { ballot: ballot ?? null, wire: null };
  let choiceIds: string[] = [];
  if (ballot.optionId === null && ballot.ranking === null && ballot.sliderValue === null) {
    const choices = await db
      .select()
      .from(pollVoteChoices)
      .where(eq(pollVoteChoices.pollVoteId, ballot.id));
    choiceIds = choices.map((c) => c.optionId);
  }
  return {
    ballot,
    wire: {
      option_id: ballot.optionId,
      option_ids: choiceIds,
      ranking: ballot.ranking ?? null,
      slider_value: ballot.sliderValue,
    },
  };
}

/** Who may see tallies for this poll right now (result_mode rules, §6.1). */
export function resultsVisibleFor(
  poll: PollRow,
  viewerId: string | null,
  postAuthorId: string,
  hasBallot: boolean,
): boolean {
  if (poll.voided) return true;
  if (viewerId !== null && viewerId === postAuthorId) return true;
  if (poll.resultMode === "live") return true;
  if (pollIsClosed(poll)) return true;
  if (poll.resultMode === "after_vote") return hasBallot;
  return false; // after_close, still open
}

export async function pollWireFor(
  db: Db,
  poll: PollRow,
  viewerId: string | null,
): Promise<PollWire> {
  const [post] = await db.select().from(posts).where(eq(posts.id, poll.postId)).limit(1);
  const options = await getPollOptions(db, poll.id);
  const mediaById = await optionMediaMap(db, options);
  const { wire: ballotWire } = await viewerBallotOf(db, poll.id, viewerId);
  const visible = resultsVisibleFor(poll, viewerId, post?.authorId ?? "", ballotWire !== null);
  const firstPrefs = poll.type === "ranked" ? await rankedFirstPreferences(db, poll.id) : undefined;
  return {
    id: poll.id,
    post_id: poll.postId,
    type: poll.type,
    question: poll.question,
    options: optionResults(poll, options, mediaById, visible, firstPrefs),
    result_mode: poll.resultMode,
    results_visible: visible,
    is_anonymous: poll.isAnonymous,
    is_daily_pulse: poll.isDailyPulse,
    min_trust_tier: poll.minTrustTier,
    total_votes: visible ? poll.totalVotes : 0,
    agent_total_votes: visible ? poll.agentTotalVotes : 0,
    closes_at: poll.closesAt?.toISOString() ?? null,
    is_closed: pollIsClosed(poll),
    voided: poll.voided,
    viewer_ballot: ballotWire,
  };
}

/** Poll wires for a batch of host posts (feed/thread hydration). */
export async function pollWiresForPosts(
  db: Db,
  postRows: Array<{ id: string; pollId: string | null }>,
  viewerId: string | null,
): Promise<Map<string, PollWire>> {
  const map = new Map<string, PollWire>();
  const pollIds = postRows.map((p) => p.pollId).filter((id): id is string => !!id);
  if (pollIds.length === 0) return map;
  const rows = await db.select().from(polls).where(inArray(polls.id, pollIds));
  for (const poll of rows) {
    map.set(poll.postId, await pollWireFor(db, poll, viewerId));
  }
  return map;
}

// ─── Tallies ─────────────────────────────────────────────────────────────────

/** Executor subset shared by Db and in-transaction handles. */
type SelectExecutor = Pick<Db, "select">;

async function liveBallots(db: SelectExecutor, pollId: string): Promise<PollVoteRow[]> {
  return db
    .select()
    .from(pollVotes)
    .where(and(eq(pollVotes.pollId, pollId), isNull(pollVotes.voidedAt)));
}

async function rankedFirstPreferences(
  db: SelectExecutor,
  pollId: string,
): Promise<Map<string, { human: number; agent: number }>> {
  const ballots = await liveBallots(db, pollId);
  const map = new Map<string, { human: number; agent: number }>();
  for (const ballot of ballots) {
    const first = ballot.ranking?.[0];
    if (!first) continue;
    const entry = map.get(first) ?? { human: 0, agent: 0 };
    if (ballot.authorType === "agent") entry.agent += 1;
    else entry.human += 1;
    map.set(first, entry);
  }
  return map;
}

export async function tabulateRanked(db: SelectExecutor, poll: PollRow): Promise<IrvResult> {
  const options = await getPollOptions(db as Db, poll.id);
  const ballots = await liveBallots(db, poll.id);
  return tallyIrv(
    ballots.map((b) => b.ranking ?? []),
    options.map((o) => o.id),
  );
}

async function breakdowns(db: Db, pollId: string) {
  const ballots = await liveBallots(db, pollId); // all non-voided ballots
  const byTier: Record<string, number> = {};
  const byAge: Record<string, number> = {};
  for (const ballot of ballots) {
    byTier[ballot.voterTrustTier] = (byTier[ballot.voterTrustTier] ?? 0) + 1;
    if (ballot.voterAgeBracket) {
      byAge[ballot.voterAgeBracket] = (byAge[ballot.voterAgeBracket] ?? 0) + 1;
    }
  }
  for (const [bracket, count] of Object.entries(byAge)) {
    if (count < BREAKDOWN_MIN_CELL) delete byAge[bracket];
  }
  return { by_trust_tier: byTier, by_age_bracket: byAge };
}

export async function pollResultsFor(
  db: Db,
  poll: PollRow,
  viewerId: string | null,
): Promise<PollResultsWire> {
  const options = await getPollOptions(db, poll.id);
  const mediaById = await optionMediaMap(db, options);
  const { wire: ballotWire } = await viewerBallotOf(db, poll.id, viewerId);
  const visible = true; // caller enforces visibility before invoking
  let winner: string | null = null;
  let irvRounds: PollResultsWire["irv_rounds"] = [];
  let stanceDistribution: Record<string, number> | null = null;
  const firstPrefs = poll.type === "ranked" ? await rankedFirstPreferences(db, poll.id) : undefined;

  if (poll.type === "ranked") {
    const cached = poll.rankingCache as { irv?: IrvResult } | null;
    const irv = cached?.irv ?? (await tabulateRanked(db, poll));
    irvRounds = irv.rounds.map((r) => ({
      round: r.round,
      tallies: r.tallies,
      eliminated_option_id: r.eliminated_option_id,
    }));
    winner = pollIsClosed(poll) ? irv.winner_option_id : null;
  } else if (poll.type === "stance_slider") {
    const ballots = await liveBallots(db, poll.id);
    stanceDistribution = { "-2": 0, "-1": 0, "0": 0, "1": 0, "2": 0 };
    for (const ballot of ballots) {
      if (ballot.sliderValue !== null) {
        stanceDistribution[String(ballot.sliderValue)] =
          (stanceDistribution[String(ballot.sliderValue)] ?? 0) + 1;
      }
    }
  } else if (pollIsClosed(poll) && options.length > 0) {
    const ranked = [...options].sort(
      (a, b) =>
        b.voteCount + b.agentVoteCount - (a.voteCount + a.agentVoteCount) ||
        a.position - b.position,
    );
    winner = ranked[0]?.id ?? null;
  }

  return {
    poll_id: poll.id,
    options: optionResults(poll, options, mediaById, visible, firstPrefs),
    total_votes: poll.totalVotes,
    agent_total_votes: poll.agentTotalVotes,
    winner_option_id: winner,
    irv_rounds: irvRounds,
    breakdowns: await breakdowns(db, poll.id),
    viewer_ballot: ballotWire,
    stance_distribution: stanceDistribution,
  };
}

/** Withheld tallies for a vote response in after_close mode (§6.1: nothing leaks pre-close). */
export async function withheldResultsFor(
  db: Db,
  poll: PollRow,
  viewerId: string,
): Promise<PollResultsWire> {
  const options = await getPollOptions(db, poll.id);
  const mediaById = await optionMediaMap(db, options);
  const { wire: ballotWire } = await viewerBallotOf(db, poll.id, viewerId);
  return {
    poll_id: poll.id,
    options: optionResults(poll, options, mediaById, false),
    total_votes: 0,
    agent_total_votes: 0,
    winner_option_id: null,
    irv_rounds: [],
    breakdowns: { by_trust_tier: {}, by_age_bracket: {} },
    viewer_ballot: ballotWire,
    stance_distribution: null,
  };
}

// ─── Ballots ─────────────────────────────────────────────────────────────────

export interface BallotInput {
  optionId?: string | null;
  optionIds?: string[];
  ranking?: string[];
  sliderValue?: number | null;
}

// Process-local per-user ballot rate limiter (same precedent as the vote
// idempotency cache in services/posts.ts; shared store lands with Redis RL).
const ballotHits = new Map<string, number[]>();

function checkBallotRateLimit(config: AppConfig, voterId: string): void {
  const now = Date.now();
  const windowStart = now - 60_000;
  const hits = (ballotHits.get(voterId) ?? []).filter((t) => t > windowStart);
  if (hits.length >= config.POLL_VOTES_PER_MINUTE) {
    throw tooManyRequests("Too many poll votes in a minute — slow down and try again");
  }
  hits.push(now);
  ballotHits.set(voterId, hits);
}

function validateBallotShape(poll: PollRow, options: PollOptionRow[], input: BallotInput): void {
  const optionIds = new Set(options.map((o) => o.id));
  const present = [
    input.optionId != null,
    (input.optionIds?.length ?? 0) > 0,
    (input.ranking?.length ?? 0) > 0,
    input.sliderValue != null,
  ].filter(Boolean).length;
  if (present !== 1) {
    throw unprocessable("Provide exactly one ballot field matching the poll type");
  }
  switch (poll.type) {
    case "single":
    case "image":
    case "hot_take":
      if (!input.optionId || !optionIds.has(input.optionId)) {
        throw unprocessable("option_id must be one of this poll's options");
      }
      break;
    case "multiple": {
      const picks = input.optionIds ?? [];
      if (picks.length === 0) throw unprocessable("option_ids must not be empty");
      if (new Set(picks).size !== picks.length) {
        throw unprocessable("option_ids must not contain duplicates");
      }
      if (picks.some((id) => !optionIds.has(id))) {
        throw unprocessable("option_ids must all belong to this poll");
      }
      const cap = poll.maxChoices ?? options.length;
      if (picks.length > cap) {
        throw unprocessable(`This poll allows at most ${cap} choices`);
      }
      break;
    }
    case "ranked": {
      const ranking = input.ranking ?? [];
      if (ranking.length === 0) throw unprocessable("ranking must not be empty");
      if (new Set(ranking).size !== ranking.length) {
        throw unprocessable("ranking must not contain duplicates");
      }
      if (ranking.some((id) => !optionIds.has(id))) {
        throw unprocessable("ranking must only contain this poll's options");
      }
      break;
    }
    case "stance_slider":
      if (input.sliderValue == null || input.sliderValue < -2 || input.sliderValue > 2) {
        throw unprocessable("slider_value must be between -2 and 2");
      }
      break;
  }
}

/** Shift option counters by a ballot's picks (+1 cast side / −1 retract side). */
async function shiftOptionCounters(
  tx: Tx,
  poll: PollRow,
  authorType: "human" | "agent",
  picks: string[],
  sign: 1 | -1,
): Promise<void> {
  if (poll.type === "ranked" || poll.type === "stance_slider") return;
  for (const optionId of picks) {
    await tx
      .update(pollOptions)
      .set(
        authorType === "agent"
          ? { agentVoteCount: sql`${pollOptions.agentVoteCount} + ${sign}` }
          : { voteCount: sql`${pollOptions.voteCount} + ${sign}` },
      )
      .where(eq(pollOptions.id, optionId));
  }
}

async function shiftPollTotals(
  tx: Tx,
  poll: PollRow,
  authorType: "human" | "agent",
  sign: 1 | -1,
): Promise<void> {
  await tx
    .update(polls)
    .set(
      authorType === "agent"
        ? { agentTotalVotes: sql`${polls.agentTotalVotes} + ${sign}` }
        : { totalVotes: sql`${polls.totalVotes} + ${sign}` },
    )
    .where(eq(polls.id, poll.id));
}

/**
 * Cast, change or retract (input = null) a ballot. All integrity gates from
 * §6.3/D-014 run here: closed/voided polls, trust tier, account age, one
 * ballot per account (unique index), voided ballots cannot be re-cast.
 */
export async function castBallot(
  ctx: AppContext,
  voterId: string,
  pollId: string,
  input: BallotInput | null,
): Promise<PollResultsWire> {
  const { db, config } = ctx;
  const poll = await getPollById(db, pollId);
  if (!poll) throw notFound("Poll not found");
  if (poll.voided) throw unprocessable("This poll has been voided by the moderation team");
  if (pollIsClosed(poll)) throw conflict("This poll is closed");

  const [voter] = await db.select().from(users).where(eq(users.id, voterId)).limit(1);
  if (!voter) throw notFound("Voter not found");
  // D-045: an agent's gate tier is its owner's current tier, resolved fresh.
  const voterTier = await effectiveTrustTier(db, voter);
  if ((TIER_RANK[voterTier] ?? 0) < (TIER_RANK[poll.minTrustTier] ?? 1)) {
    throw forbidden(
      `This poll requires trust tier ${poll.minTrustTier}; your account is ${voterTier}`,
    );
  }
  const ageDays = (Date.now() - voter.createdAt.getTime()) / 86_400_000;
  if (ageDays < poll.minAccountAgeDays) {
    throw forbidden(`This poll requires an account at least ${poll.minAccountAgeDays} days old`);
  }
  checkBallotRateLimit(config, voterId);

  const options = await getPollOptions(db, pollId);
  if (input !== null) validateBallotShape(poll, options, input);

  const [settings] = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, voterId))
    .limit(1);
  const ageBracketSnapshot =
    settings?.demographicBreakdownsOptIn === true ? voter.ageBracket : null;

  const fresh = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(pollVotes)
      .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.voterId, voterId)))
      .limit(1);
    if (existing?.voidedAt) {
      throw conflict("Your ballot on this poll was voided and cannot be re-cast");
    }
    const existingChoices = existing
      ? await tx
          .select()
          .from(pollVoteChoices)
          .where(eq(pollVoteChoices.pollVoteId, existing.id))
      : [];
    const existingPicks = existing
      ? existing.optionId
        ? [existing.optionId]
        : existingChoices.map((c) => c.optionId)
      : [];
    const before = existing
      ? ballotSnapshot({
          optionId: existing.optionId,
          ranking: existing.ranking,
          sliderValue: existing.sliderValue,
          choiceIds: existingPicks.length > 0 && !existing.optionId ? existingPicks : [],
        })
      : null;

    if (input === null) {
      if (!existing) {
        const [row] = await tx.select().from(polls).where(eq(polls.id, pollId)).limit(1);
        return row ?? poll;
      }
      await shiftOptionCounters(tx, poll, existing.authorType, existingPicks, -1);
      await shiftPollTotals(tx, poll, existing.authorType, -1);
      await tx.delete(pollVotes).where(eq(pollVotes.id, existing.id));
      await tx.insert(pollVoteAudit).values({
        id: uuidv7(),
        pollId,
        voterId,
        changeKind: "retract",
        beforeState: before,
        afterState: null,
        actorId: voterId,
      });
    } else {
      const newPicks =
        poll.type === "multiple"
          ? (input.optionIds ?? [])
          : input.optionId
            ? [input.optionId]
            : [];
      if (existing) {
        // Change: remove the old picks, add the new ones; totals unchanged.
        const removed = existingPicks.filter((id) => !newPicks.includes(id));
        const added = newPicks.filter((id) => !existingPicks.includes(id));
        await shiftOptionCounters(tx, poll, existing.authorType, removed, -1);
        await shiftOptionCounters(tx, poll, existing.authorType, added, 1);
        await tx
          .update(pollVotes)
          .set({
            optionId: input.optionId ?? null,
            ranking: input.ranking ?? null,
            sliderValue: input.sliderValue ?? null,
            voterTrustTier: voterTier,
            voterAgeBracket: ageBracketSnapshot,
            updatedAt: new Date(),
          })
          .where(eq(pollVotes.id, existing.id));
        await tx.delete(pollVoteChoices).where(eq(pollVoteChoices.pollVoteId, existing.id));
        if (poll.type === "multiple") {
          await tx.insert(pollVoteChoices).values(
            newPicks.map((optionId) => ({ pollVoteId: existing.id, optionId })),
          );
        }
      } else {
        const ballotId = uuidv7();
        await tx.insert(pollVotes).values({
          id: ballotId,
          pollId,
          voterId,
          authorType: voter.authorType,
          optionId: input.optionId ?? null,
          ranking: input.ranking ?? null,
          sliderValue: input.sliderValue ?? null,
          voterAgeBracket: ageBracketSnapshot,
          voterTrustTier: voterTier,
        });
        if (poll.type === "multiple") {
          await tx.insert(pollVoteChoices).values(
            newPicks.map((optionId) => ({ pollVoteId: ballotId, optionId })),
          );
        }
        await shiftOptionCounters(tx, poll, voter.authorType, newPicks, 1);
        await shiftPollTotals(tx, poll, voter.authorType, 1);
      }
      await tx.insert(pollVoteAudit).values({
        id: uuidv7(),
        pollId,
        voterId,
        changeKind: existing ? "change" : "cast",
        beforeState: before,
        afterState: ballotSnapshot({
          optionId: input.optionId ?? null,
          ranking: input.ranking ?? null,
          sliderValue: input.sliderValue ?? null,
          choiceIds: poll.type === "multiple" ? newPicks : [],
        }),
        actorId: voterId,
      });
    }
    const [row] = await tx.select().from(polls).where(eq(polls.id, pollId)).limit(1);
    return row!;
  });

  // Anomaly scan (best-effort, outside the ballot transaction).
  await scanForAnomalies(db, config, pollId).catch(() => undefined);

  if (fresh.resultMode === "after_close" && !pollIsClosed(fresh)) {
    return withheldResultsFor(db, fresh, voterId);
  }
  return pollResultsFor(db, fresh, voterId);
}

// ─── Close ───────────────────────────────────────────────────────────────────

export async function closePoll(
  db: Db,
  poll: PollRow,
  actorId: string,
): Promise<PollRow> {
  const [post] = await db.select().from(posts).where(eq(posts.id, poll.postId)).limit(1);
  if (!post || post.authorId !== actorId) {
    throw forbidden("Only the poll author can close this poll");
  }
  if (poll.closedAt) return poll;
  return db.transaction(async (tx) => {
    let rankingCache: PollRow["rankingCache"] = poll.rankingCache;
    if (poll.type === "ranked") {
      const irv = await tabulateRanked(tx, poll);
      rankingCache = { irv, tabulated_at: new Date().toISOString() };
    }
    const [updated] = await tx
      .update(polls)
      .set({ closedAt: new Date(), rankingCache })
      .where(eq(polls.id, poll.id))
      .returning();
    return updated!;
  });
}

// ─── Integrity: anomaly flags + voiding ──────────────────────────────────────

/**
 * Velocity scan (§6.3 integrity): after each ballot, look at the trailing
 * window; a burst of ballots — especially from day-old accounts — raises a
 * poll_flags row for admin review. Deduped per kind per 10 minutes.
 */
export async function scanForAnomalies(
  db: Db,
  config: AppConfig,
  pollId: string,
): Promise<void> {
  const since = new Date(Date.now() - config.POLL_FLAG_WINDOW_SECONDS * 1000);
  const recent = await db
    .select({ voterId: pollVotes.voterId, optionId: pollVotes.optionId, createdAt: pollVotes.createdAt })
    .from(pollVotes)
    .where(and(eq(pollVotes.pollId, pollId), gte(pollVotes.createdAt, since), isNull(pollVotes.voidedAt)));
  if (recent.length < config.POLL_FLAG_MIN_BALLOTS) return;

  const voterIds = [...new Set(recent.map((r) => r.voterId))];
  const voterRows = await db
    .select({ id: users.id, createdAt: users.createdAt })
    .from(users)
    .where(inArray(users.id, voterIds));
  const dayAgo = Date.now() - 86_400_000;
  const youngVoterIds = voterRows.filter((v) => v.createdAt.getTime() > dayAgo).map((v) => v.id);
  const young = youngVoterIds.length;
  const youngShare = voterRows.length > 0 ? young / voterRows.length : 0;

  const kinds: Array<{ kind: string; details: Record<string, unknown> }> = [];
  if (youngShare >= config.POLL_FLAG_YOUNG_ACCOUNT_SHARE) {
    kinds.push({
      kind: "young_account_burst",
      details: {
        window_seconds: config.POLL_FLAG_WINDOW_SECONDS,
        ballots: recent.length,
        young_accounts: young,
        young_share: youngShare,
        // Only the young accounts — voiding by this flag must never sweep
        // up established voters who happened to vote in the same window.
        voter_ids: youngVoterIds,
      },
    });
  } else {
    kinds.push({
      kind: "velocity_burst",
      details: {
        window_seconds: config.POLL_FLAG_WINDOW_SECONDS,
        ballots: recent.length,
        voter_ids: voterIds,
      },
    });
  }
  const perOption = new Map<string, number>();
  for (const row of recent) {
    if (row.optionId) perOption.set(row.optionId, (perOption.get(row.optionId) ?? 0) + 1);
  }
  for (const [optionId, count] of perOption) {
    if (count >= config.POLL_FLAG_MIN_BALLOTS) {
      kinds.push({
        kind: "single_option_surge",
        details: { window_seconds: config.POLL_FLAG_WINDOW_SECONDS, option_id: optionId, ballots: count, voter_ids: voterIds },
      });
    }
  }

  const dedupeSince = new Date(Date.now() - 10 * 60 * 1000);
  for (const flag of kinds) {
    const [existing] = await db
      .select()
      .from(pollFlags)
      .where(
        and(
          eq(pollFlags.pollId, pollId),
          eq(pollFlags.kind, flag.kind),
          eq(pollFlags.status, "open"),
          gte(pollFlags.createdAt, dedupeSince),
        ),
      )
      .limit(1);
    if (existing) {
      // Keep an open flag tracking the ongoing burst: union the voter list
      // so voiding by flag covers every ballot seen so far.
      const prev = (existing.details ?? {}) as { voter_ids?: string[]; ballots?: number };
      const incoming = flag.details as { voter_ids?: string[]; ballots?: number };
      const merged = [...new Set([...(prev.voter_ids ?? []), ...(incoming.voter_ids ?? [])])];
      await db
        .update(pollFlags)
        .set({
          details: {
            ...prev,
            ...flag.details,
            voter_ids: merged,
            ballots: Math.max(prev.ballots ?? 0, incoming.ballots ?? 0, merged.length),
          },
        })
        .where(eq(pollFlags.id, existing.id));
      continue;
    }
    await db.insert(pollFlags).values({
      id: uuidv7(),
      pollId,
      kind: flag.kind,
      details: flag.details,
    });
  }
}

export async function voidBallots(
  db: Db,
  adminId: string,
  pollId: string,
  voterIds: string[],
  reason: string,
): Promise<{ voided: number }> {
  const poll = await getPollById(db, pollId);
  if (!poll) throw notFound("Poll not found");
  if (voterIds.length === 0) throw unprocessable("voter_ids must not be empty");
  return db.transaction(async (tx) => {
    let voided = 0;
    for (const voterId of voterIds) {
      const [ballot] = await tx
        .select()
        .from(pollVotes)
        .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.voterId, voterId)))
        .limit(1);
      if (!ballot || ballot.voidedAt) continue;
      const choices = await tx
        .select()
        .from(pollVoteChoices)
        .where(eq(pollVoteChoices.pollVoteId, ballot.id));
      const picks = ballot.optionId ? [ballot.optionId] : choices.map((c) => c.optionId);
      await shiftOptionCounters(tx, poll, ballot.authorType, picks, -1);
      await shiftPollTotals(tx, poll, ballot.authorType, -1);
      await tx
        .update(pollVotes)
        .set({ voidedAt: new Date(), voidedBy: adminId, voidReason: reason })
        .where(eq(pollVotes.id, ballot.id));
      await tx.insert(pollVoteAudit).values({
        id: uuidv7(),
        pollId,
        voterId,
        changeKind: "void",
        beforeState: ballotSnapshot({
          optionId: ballot.optionId,
          ranking: ballot.ranking,
          sliderValue: ballot.sliderValue,
          choiceIds: picks,
        }),
        afterState: null,
        actorId: adminId,
        reason,
      });
      voided += 1;
    }
    await tx.insert(auditLogs).values({
      id: uuidv7(),
      actorId: adminId,
      action: "poll.void_ballots",
      targetType: "poll",
      targetId: pollId,
      metadata: { voter_ids: voterIds, voided, reason },
    });
    return { voided };
  });
}

export async function voidWholePoll(
  db: Db,
  adminId: string,
  pollId: string,
  reason: string,
): Promise<PollRow> {
  const poll = await getPollById(db, pollId);
  if (!poll) throw notFound("Poll not found");
  const [updated] = await db
    .update(polls)
    .set({ voided: true, voidedBy: adminId, voidedReason: reason })
    .where(eq(polls.id, pollId))
    .returning();
  await db.insert(auditLogs).values({
    id: uuidv7(),
    actorId: adminId,
    action: "poll.void",
    targetType: "poll",
    targetId: pollId,
    metadata: { reason },
  });
  return updated!;
}

// ─── Daily Pulse (D-031) ─────────────────────────────────────────────────────

/**
 * Publish (or fetch) today's Daily Pulse. Idempotent per ET date: the
 * partial unique index on pulse_date plus the existence check make repeat
 * calls return the same poll. Returns null when the bank is empty or the
 * pulse author account is missing.
 */
export async function ensureTodaysPulse(
  db: Db,
  config: AppConfig,
  now: Date = new Date(),
): Promise<PollRow | null> {
  const today = etToday(now);
  const [existing] = await db
    .select()
    .from(polls)
    .where(and(eq(polls.isDailyPulse, true), eq(polls.pulseDate, today)))
    .limit(1);
  if (existing) return existing;

  const [author] = await db
    .select()
    .from(users)
    .where(eq(users.handle, config.PULSE_AUTHOR_HANDLE))
    .limit(1);
  if (!author) return null;

  const bank = await db
    .select()
    .from(dailyPulseQuestions)
    .where(and(eq(dailyPulseQuestions.isActive, true), isNull(dailyPulseQuestions.usedDate)))
    .orderBy(asc(dailyPulseQuestions.createdAt));
  const question =
    bank.find((q) => q.scheduledDate === today) ??
    bank.find((q) => q.scheduledDate === null) ??
    null;
  if (!question) return null;

  try {
    const { poll } = await createPollWithPost(
      db,
      { id: author.id, authorType: author.authorType },
      {
        question: question.question,
        type: question.type,
        options: (question.options as string[]).map((text) => ({ text })),
        resultMode: "live",
        minTrustTier: "T1",
        closesAt: etMidnightAfter(today),
        bodyMd: "Today's Daily Pulse — one question, one day. Results are final at midnight ET.",
        isDailyPulse: true,
        pulseDate: today,
      },
    );
    await db
      .update(dailyPulseQuestions)
      .set({ usedDate: today })
      .where(eq(dailyPulseQuestions.id, question.id));
    return poll;
  } catch (error) {
    // Lost a publish race (unique pulse_date) — return the winner's poll.
    const [winner] = await db
      .select()
      .from(polls)
      .where(and(eq(polls.isDailyPulse, true), eq(polls.pulseDate, today)))
      .limit(1);
    if (winner) return winner;
    throw error;
  }
}

/** Share-card SVG for the Daily Pulse (D-031: SVG is the card image). */
export function pulseCardSvg(poll: PollRow, results: PollResultsWire): string {
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const total = Math.max(1, results.total_votes + results.agent_total_votes);
  const bars = results.options
    .slice(0, 5)
    .map((option, i) => {
      const votes = option.human_votes + option.agent_votes;
      const pct = Math.round((votes / total) * 100);
      const y = 118 + i * 44;
      return `
  <text x="48" y="${y}" font-family="Inter, sans-serif" font-size="17" fill="#f5f2ea">${escape(option.text ?? "")}</text>
  <text x="1152" y="${y}" text-anchor="end" font-family="Inter, sans-serif" font-size="17" fill="#ffbf47">${pct}%</text>
  <rect x="48" y="${y + 10}" width="1104" height="10" rx="5" fill="#2a2a2a"/>
  <rect x="48" y="${y + 10}" width="${Math.round((1104 * votes) / total)}" height="10" rx="5" fill="#ffbf47"/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#121212"/>
  <text x="48" y="58" font-family="'Space Grotesk', sans-serif" font-size="24" letter-spacing="4" fill="#ffbf47">GG · DAILY PULSE</text>
  <text x="48" y="98" font-family="'Space Grotesk', sans-serif" font-size="30" font-weight="600" fill="#ffffff">${escape(poll.question)}</text>
  ${bars}
  <text x="48" y="590" font-family="Inter, sans-serif" font-size="15" fill="#9ca3af">${results.total_votes + results.agent_total_votes} ballots · gg.genznewz.com</text>
</svg>`;
}
