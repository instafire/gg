/**
 * Debates (DATA_MODEL §8, Phase 3) — open debates, structured 1v1 with
 * challenges/rounds/Elo, team debates, arguments + evidence, stance votes
 * (the mind-change measure), winner computation and turn expiry.
 *
 * Scoring is the pure @gg/shared implementation (D-032): winner formula
 * {argument_votes 0.5, mind_change 0.35, evidence_quality 0.15} snapshotted
 * on the debate at creation; Elo K=32 <30 debates else 16. Open debates are
 * unrated (no Elo) — ratings come from structured formats.
 */
import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  DEFAULT_WINNER_FORMULA,
  computeDebateWinner,
  eloUpdate,
  evidenceQualityForLinks,
  type WinnerFormulaWeights,
} from "@gg/shared";
import type { AppContext } from "../context";
import type { Db } from "../db";
import {
  communities,
  debateArguments,
  debateChallenges,
  debateParticipants,
  debateRatingEvents,
  debateRatings,
  debateRounds,
  debateSides,
  debates,
  evidenceLinks,
  posts,
  stanceVotes,
  users,
  voteAudit,
  votes,
} from "../db/schema";
import { conflict, forbidden, notFound, unprocessable } from "../lib/errors";
import { pathLabel, shortCode, uuidv7 } from "../lib/ids";
import { renderBodyHtml } from "../lib/render";
import {
  communityRef,
  type ArgumentWire,
  type DebateRatingRow,
  type DebateRow,
  type DebateSideRow,
  type DebateWire,
  type EvidenceWire,
  evidenceWire,
} from "../lib/serializers";
import { effectiveTrustTier } from "../lib/trust-tier";
import { voteDelta, voteWeight } from "../lib/vote-math";
import { notify } from "./notifications";
import { logEvent } from "./events";
import type { AuthorRef } from "./posts";
import { authorMap } from "./users";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ArgumentRow = typeof debateArguments.$inferSelect;
type RoundRow = typeof debateRounds.$inferSelect;
type StanceRow = typeof stanceVotes.$inferSelect;

export const OPEN_SIDES = [
  { key: "for", label: "For", position: 0 },
  { key: "against", label: "Against", position: 1 },
  { key: "nuanced", label: "Nuanced", position: 2 },
] as const;
export const DUEL_SIDES = [
  { key: "for", label: "For", position: 0 },
  { key: "against", label: "Against", position: 1 },
] as const;
export const TEAM_SIDES = [
  { key: "a", label: "Team A", position: 0 },
  { key: "b", label: "Team B", position: 1 },
] as const;

const ARGUMENT_MAX_CHARS = 10_000;
const REBUTTAL_MAX_DEPTH = 3;

// ─── Creation ────────────────────────────────────────────────────────────────

export interface EvidenceInput {
  url: string;
  kind: "study" | "news" | "data" | "personal_experience" | "other";
  quote?: string | null;
}

export interface CreateDebateInput {
  proposition: string;
  format: DebateRow["format"];
  communityId?: string | null;
  sourceArticleUrl?: string | null;
  /** Host post link card override (from-article unfurl). */
  linkCard?: Record<string, unknown> | null;
  challengedId?: string | null;
  judgeId?: string | null;
  /** Challenger's side for structured_1v1 (default 'for'). */
  challengerSideKey?: string;
  turnDeadlineHours?: number;
  liveTurnSeconds?: number | null;
  perTurnCharLimit?: number;
  /** Number of rounds (each = one turn per debater); default 3. */
  rounds?: number;
  steelmanRequired?: boolean;
  scheduledStartAt?: Date | null;
  opening?: { sideKey: string; bodyMd: string; evidence?: EvidenceInput[] } | null;
}

function sideSetFor(format: DebateRow["format"]) {
  return format === "open" ? OPEN_SIDES : format === "team" ? TEAM_SIDES : DUEL_SIDES;
}

async function insertArgumentRow(
  tx: Tx,
  input: {
    debateId: string;
    sideId: string;
    author: AuthorRef;
    bodyMd: string;
    roundId?: string | null;
    parentArgumentId?: string | null;
    isOpening?: boolean;
    isSteelman?: boolean;
    evidence?: EvidenceInput[];
  },
): Promise<ArgumentRow> {
  const [row] = await tx
    .insert(debateArguments)
    .values({
      id: uuidv7(),
      debateId: input.debateId,
      sideId: input.sideId,
      authorId: input.author.id,
      authorType: input.author.authorType,
      roundId: input.roundId ?? null,
      parentArgumentId: input.parentArgumentId ?? null,
      bodyMd: input.bodyMd,
      bodyHtml: renderBodyHtml(input.bodyMd),
      isOpening: input.isOpening ?? false,
      isSteelman: input.isSteelman ?? false,
    })
    .returning();
  const argument = row!;
  if (input.evidence && input.evidence.length > 0) {
    await insertEvidence(tx, argument, input.evidence);
    const [fresh] = await tx
      .select()
      .from(debateArguments)
      .where(eq(debateArguments.id, argument.id))
      .limit(1);
    return fresh ?? argument;
  }
  return argument;
}

async function insertEvidence(
  tx: Tx,
  argument: ArgumentRow,
  links: EvidenceInput[],
): Promise<void> {
  for (const link of links) {
    let domain: string | null = null;
    try {
      domain = new URL(link.url).hostname;
    } catch {
      throw unprocessable(`Evidence URL is not valid: ${link.url}`);
    }
    await tx.insert(evidenceLinks).values({
      id: uuidv7(),
      argumentId: argument.id,
      url: link.url,
      kind: link.kind,
      quote: link.quote ?? null,
      domain,
    });
  }
  const rows = await tx
    .select()
    .from(evidenceLinks)
    .where(eq(evidenceLinks.argumentId, argument.id));
  await tx
    .update(debateArguments)
    .set({ evidenceQuality: evidenceQualityForLinks(rows) })
    .where(eq(debateArguments.id, argument.id));
}

export async function createDebateWithPost(
  db: Db,
  author: AuthorRef,
  input: CreateDebateInput,
): Promise<DebateRow> {
  const proposition = input.proposition.trim();
  if (proposition.length === 0 || proposition.length > 280) {
    throw unprocessable("Proposition must be 1–280 characters");
  }
  const sideSet = sideSetFor(input.format);
  return db.transaction(async (tx) => {
    const postId = uuidv7();
    const label = pathLabel(postId);
    const linkCard = input.sourceArticleUrl
      ? {
          url: input.sourceArticleUrl,
          domain: new URL(input.sourceArticleUrl).hostname,
          ...(input.linkCard ?? {}),
          source_article_url: input.sourceArticleUrl,
        }
      : null;
    const [post] = await tx
      .insert(posts)
      .values({
        id: postId,
        shortCode: shortCode(),
        authorId: author.id,
        authorType: author.authorType,
        type: "DEBATE",
        rootId: postId,
        path: label,
        pathLabel: label,
        depth: 0,
        communityId: input.communityId ?? null,
        title: proposition,
        bodyMd: "",
        bodyHtml: "",
        linkUrl: input.sourceArticleUrl ?? null,
        linkCard,
        visibility: input.communityId ? "community" : "public",
      })
      .returning();

    const debateId = uuidv7();
    const isDuel = input.format === "structured_1v1";
    const [debate] = await tx
      .insert(debates)
      .values({
        id: debateId,
        shortCode: shortCode(),
        postId,
        proposition,
        format: input.format,
        status: isDuel ? "draft" : "open",
        communityId: input.communityId ?? null,
        sourceArticleUrl: input.sourceArticleUrl ?? null,
        hostId: author.id,
        judgeId: input.judgeId ?? null,
        turnDeadlineHours: input.turnDeadlineHours ?? 24,
        liveTurnSeconds: input.liveTurnSeconds ?? null,
        perTurnCharLimit: input.perTurnCharLimit ?? 2000,
        scheduledStartAt: input.scheduledStartAt ?? null,
        winnerFormula: { ...DEFAULT_WINNER_FORMULA },
        settings: { steelman_required: input.steelmanRequired ?? false },
      })
      .returning();
    await tx.update(posts).set({ debateId }).where(eq(posts.id, postId));

    const sides: DebateSideRow[] = [];
    for (const side of sideSet) {
      const [row] = await tx
        .insert(debateSides)
        .values({ id: uuidv7(), debateId, key: side.key, label: side.label, position: side.position })
        .returning();
      sides.push(row!);
    }
    const sideByKey = new Map(sides.map((s) => [s.key, s]));

    if (input.format === "open") {
      const openingSide = input.opening
        ? sideByKey.get(input.opening.sideKey)
        : sideByKey.get("for");
      if (input.opening && !openingSide) {
        throw unprocessable(`Unknown side_key: ${input.opening.sideKey}`);
      }
      if (openingSide) {
        await tx.insert(debateParticipants).values({
          debateId,
          userId: author.id,
          sideId: openingSide.id,
          role: "host",
        });
      }
      if (input.opening) {
        await insertArgumentRow(tx, {
          debateId,
          sideId: openingSide!.id,
          author,
          bodyMd: input.opening.bodyMd,
          isOpening: true,
          evidence: input.opening.evidence,
        });
      }
    } else if (isDuel) {
      const challengerSideKey = input.challengerSideKey ?? "for";
      const challengerSide = sideByKey.get(challengerSideKey);
      if (!challengerSide) throw unprocessable(`Unknown side_key: ${challengerSideKey}`);
      await tx.insert(debateParticipants).values({
        debateId,
        userId: author.id,
        sideId: challengerSide.id,
        role: "debater",
        eloAtStart: await currentRating(tx, author.id),
      });
      if (input.challengedId) {
        const [challenge] = await tx
          .insert(debateChallenges)
          .values({
            id: uuidv7(),
            debateId,
            challengerId: author.id,
            challengedId: input.challengedId,
            sideKey: challengerSideKey,
            message: null,
          })
          .returning();
        await notify(tx, {
          recipientId: input.challengedId,
          type: "debate_challenge",
          actorId: author.id,
          subjectType: "debate",
          subjectId: debateId,
          payload: { challenge_id: challenge!.id, proposition },
        });
      }
    } else {
      // team: host captains side A; the debate is open for joins immediately.
      await tx.insert(debateParticipants).values({
        debateId,
        userId: author.id,
        sideId: sideByKey.get("a")!.id,
        role: "host",
      });
    }
    void post;
    return debate!;
  });
}

export async function getDebateById(db: Db, id: string): Promise<DebateRow | null> {
  const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const [row] = await db
    .select()
    .from(debates)
    .where(byId ? eq(debates.id, id) : eq(debates.shortCode, id))
    .limit(1);
  return row ?? null;
}

export async function getSides(db: Db, debateId: string): Promise<DebateSideRow[]> {
  return db
    .select()
    .from(debateSides)
    .where(eq(debateSides.debateId, debateId))
    .orderBy(asc(debateSides.position));
}

async function currentRating(exec: Db | Tx, userId: string): Promise<number> {
  const [row] = await exec
    .select()
    .from(debateRatings)
    .where(eq(debateRatings.userId, userId))
    .limit(1);
  return row?.rating ?? 1200;
}

// ─── Starting a structured debate (challenge accept / join-claim) ────────────

const ROUND_KINDS: Array<RoundRow["kind"]> = ["opening", "rebuttal", "cross", "closing"];

function kindForPair(pairIndex: number, totalPairs: number): RoundRow["kind"] {
  if (pairIndex === 0) return "opening";
  if (pairIndex === totalPairs - 1) return "closing";
  return ROUND_KINDS[Math.min(pairIndex, 2)] ?? "freeform";
}

/**
 * Generate the round rows and activate the first turn. Debaters alternate;
 * the challenger (first debater on their chosen side) opens.
 */
export async function startStructuredDebate(
  tx: Tx,
  debate: DebateRow,
  roundsCount: number,
): Promise<void> {
  const sides = await getSides(tx as unknown as Db, debate.id);
  const participants = await tx
    .select()
    .from(debateParticipants)
    .where(eq(debateParticipants.debateId, debate.id));
  const debaters = participants.filter((p) => p.role === "debater" || p.role === "host");
  if (debaters.length < 2) throw conflict("A structured debate needs two debaters");
  const first = debaters.find((p) => p.userId === debate.hostId) ?? debaters[0]!;
  const ordered = [first, ...debaters.filter((p) => p.userId !== first.userId)];
  const now = new Date();
  const turnMs = debate.liveTurnSeconds
    ? debate.liveTurnSeconds * 1000
    : debate.turnDeadlineHours * 3_600_000;
  const totalTurns = roundsCount * ordered.length;
  for (let turn = 0; turn < totalTurns; turn += 1) {
    const debater = ordered[turn % ordered.length]!;
    const isFirst = turn === 0;
    await tx.insert(debateRounds).values({
      id: uuidv7(),
      debateId: debate.id,
      roundNo: turn + 1,
      kind: kindForPair(Math.floor(turn / ordered.length), roundsCount),
      sideId: debater.sideId,
      turnUserId: debater.userId,
      startsAt: isFirst ? now : null,
      deadlineAt: isFirst ? new Date(now.getTime() + turnMs) : null,
      status: isFirst ? "active" : "pending",
    });
  }
  await tx
    .update(debates)
    .set({ status: debate.liveTurnSeconds ? "live" : "awaiting_turn" })
    .where(eq(debates.id, debate.id));
  void sides;
}

/** Activate the next pending round (after a submit or a miss). */
async function activateNextRound(tx: Tx, debate: DebateRow): Promise<RoundRow | null> {
  const [next] = await tx
    .select()
    .from(debateRounds)
    .where(and(eq(debateRounds.debateId, debate.id), eq(debateRounds.status, "pending")))
    .orderBy(asc(debateRounds.roundNo))
    .limit(1);
  if (!next) return null;
  const now = new Date();
  const turnMs = debate.liveTurnSeconds
    ? debate.liveTurnSeconds * 1000
    : debate.turnDeadlineHours * 3_600_000;
  const [activated] = await tx
    .update(debateRounds)
    .set({ status: "active", startsAt: now, deadlineAt: new Date(now.getTime() + turnMs) })
    .where(eq(debateRounds.id, next.id))
    .returning();
  if (activated?.turnUserId) {
    await notify(tx, {
      recipientId: activated.turnUserId,
      type: "debate_turn",
      actorId: null,
      subjectType: "debate",
      subjectId: debate.id,
      payload: { round_no: activated.roundNo },
    });
  }
  return activated ?? null;
}

// ─── Challenges & joins ──────────────────────────────────────────────────────

export async function createChallenge(
  db: Db,
  challenger: AuthorRef,
  debateId: string,
  input: { challengedId: string; sideKey: string; message?: string | null },
): Promise<{ id: string }> {
  const debate = await getDebateById(db, debateId);
  if (!debate) throw notFound("Debate not found");
  if (debate.format !== "structured_1v1" || debate.status !== "draft") {
    throw conflict("Challenges can only be issued on a draft 1v1 debate");
  }
  const sides = await getSides(db, debateId);
  if (!sides.some((s) => s.key === input.sideKey)) {
    throw unprocessable(`Unknown side_key: ${input.sideKey}`);
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(debateChallenges)
      .values({
        id: uuidv7(),
        debateId,
        challengerId: challenger.id,
        challengedId: input.challengedId,
        sideKey: input.sideKey,
        message: input.message ?? null,
      })
      .returning();
    await notify(tx, {
      recipientId: input.challengedId,
      type: "debate_challenge",
      actorId: challenger.id,
      subjectType: "debate",
      subjectId: debateId,
      payload: { challenge_id: row!.id, proposition: debate.proposition },
    });
    return { id: row!.id };
  });
}

export async function respondToChallenge(
  db: Db,
  userId: string,
  debateId: string,
  challengeId: string,
  decision: "accept" | "decline",
  roundsCount = 3,
): Promise<DebateRow> {
  const debate = await getDebateById(db, debateId);
  if (!debate) throw notFound("Debate not found");
  return db.transaction(async (tx) => {
    const [challenge] = await tx
      .select()
      .from(debateChallenges)
      .where(
        and(eq(debateChallenges.id, challengeId), eq(debateChallenges.debateId, debateId)),
      )
      .limit(1);
    if (!challenge) throw notFound("Challenge not found");
    if (challenge.challengedId !== userId) {
      throw forbidden("Only the challenged debater can respond");
    }
    if (challenge.status !== "pending") throw conflict("This challenge was already answered");
    await tx
      .update(debateChallenges)
      .set({ status: decision === "accept" ? "accepted" : "declined", respondedAt: new Date() })
      .where(eq(debateChallenges.id, challengeId));
    if (decision === "decline") {
      // The creation challenge declined → the debate never happens.
      const isCreationChallenge = challenge.challengerId === debate.hostId;
      if (isCreationChallenge) {
        await tx
          .update(debates)
          .set({ status: "cancelled" })
          .where(eq(debates.id, debateId));
      }
      const [updated] = await tx.select().from(debates).where(eq(debates.id, debateId));
      return updated!;
    }
    const sides = await getSides(tx as unknown as Db, debateId);
    const challengerSide = sides.find((s) => s.key === challenge.sideKey);
    const otherSide = sides.find((s) => s.key !== challenge.sideKey);
    if (!challengerSide || !otherSide) throw unprocessable("Debate sides are incomplete");
    // Challenger keeps their participant row with their chosen side; make
    // sure it reflects the challenge's side_key, then add the challenged.
    await tx
      .update(debateParticipants)
      .set({ sideId: challengerSide.id })
      .where(
        and(
          eq(debateParticipants.debateId, debateId),
          eq(debateParticipants.userId, challenge.challengerId),
        ),
      );
    await tx
      .insert(debateParticipants)
      .values({
        debateId,
        userId,
        sideId: otherSide.id,
        role: "debater",
        eloAtStart: await currentRating(tx, userId),
      })
      .onConflictDoNothing();
    const [fresh] = await tx.select().from(debates).where(eq(debates.id, debateId));
    await startStructuredDebate(tx, fresh!, roundsCount);
    const [updated] = await tx.select().from(debates).where(eq(debates.id, debateId));
    return updated!;
  });
}

export async function joinDebate(
  db: Db,
  user: AuthorRef,
  debateId: string,
  sideKey: string,
): Promise<DebateRow> {
  const debate = await getDebateById(db, debateId);
  if (!debate) throw notFound("Debate not found");
  const sides = await getSides(db, debateId);
  const side = sides.find((s) => s.key === sideKey);
  if (!side) throw unprocessable(`Unknown side_key: ${sideKey}`);
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(debateParticipants)
      .where(
        and(eq(debateParticipants.debateId, debateId), eq(debateParticipants.userId, user.id)),
      )
      .limit(1);
    if (existing) throw conflict("You have already joined this debate");
    if (debate.format === "structured_1v1") {
      if (debate.status !== "draft") throw conflict("This debate has already started");
      const occupants = await tx
        .select()
        .from(debateParticipants)
        .where(eq(debateParticipants.debateId, debateId));
      if (occupants.some((p) => p.sideId === side.id)) {
        throw conflict("That side is already taken");
      }
      if (occupants.length >= 2) throw conflict("This debate already has two debaters");
      await tx.insert(debateParticipants).values({
        debateId,
        userId: user.id,
        sideId: side.id,
        role: "debater",
        eloAtStart: await currentRating(tx, user.id),
      });
      const [fresh] = await tx.select().from(debates).where(eq(debates.id, debateId));
      await startStructuredDebate(tx, fresh!, 3);
    } else {
      if (debate.status !== "open" && debate.status !== "live") {
        throw conflict("This debate is not open for joining");
      }
      if (debate.format === "team") {
        const occupants = await tx
          .select()
          .from(debateParticipants)
          .where(
            and(eq(debateParticipants.debateId, debateId), eq(debateParticipants.sideId, side.id)),
          );
        if (occupants.length >= 4) throw conflict("That team is full (4 debaters)");
      }
      await tx.insert(debateParticipants).values({
        debateId,
        userId: user.id,
        sideId: side.id,
        role: debate.hostId === user.id ? "host" : "debater",
      });
    }
    const [updated] = await tx.select().from(debates).where(eq(debates.id, debateId));
    return updated!;
  });
}

// ─── Arguments ───────────────────────────────────────────────────────────────

export interface ArgumentInput {
  sideKey: string;
  bodyMd: string;
  parentArgumentId?: string | null;
  isSteelman?: boolean;
  evidence?: EvidenceInput[];
}

async function argumentDepth(db: Db, argumentId: string): Promise<number> {
  let depth = 0;
  let current: string | null = argumentId;
  while (current) {
    const [row] = await db
      .select({ parent: debateArguments.parentArgumentId })
      .from(debateArguments)
      .where(eq(debateArguments.id, current))
      .limit(1);
    current = row?.parent ?? null;
    if (current) depth += 1;
    if (depth > 10) break;
  }
  return depth;
}

export async function createArgument(
  db: Db,
  author: AuthorRef,
  debateId: string,
  input: ArgumentInput,
): Promise<ArgumentRow> {
  const debate = await getDebateById(db, debateId);
  if (!debate) throw notFound("Debate not found");
  if (debate.format === "structured_1v1") {
    throw conflict("Structured debates take arguments through round submissions");
  }
  if (debate.status !== "open" && debate.status !== "live") {
    throw conflict("This debate is not accepting arguments");
  }
  if (input.bodyMd.trim().length === 0 || input.bodyMd.length > ARGUMENT_MAX_CHARS) {
    throw unprocessable(`Arguments must be 1–${ARGUMENT_MAX_CHARS} characters`);
  }
  const sides = await getSides(db, debateId);
  const side = sides.find((s) => s.key === input.sideKey);
  if (!side) throw unprocessable(`Unknown side_key: ${input.sideKey}`);
  if (input.parentArgumentId) {
    const [parent] = await db
      .select()
      .from(debateArguments)
      .where(eq(debateArguments.id, input.parentArgumentId))
      .limit(1);
    if (!parent || parent.debateId !== debateId) throw notFound("Parent argument not found");
    if ((await argumentDepth(db, parent.id)) >= REBUTTAL_MAX_DEPTH) {
      throw unprocessable("Rebuttal chains are capped at depth 3");
    }
  }
  // Steelman gate (§8.3): with steelman_required, a debater's first argument
  // on their own side needs a confirmed steelman of the opposing side first.
  const settings = (debate.settings ?? {}) as { steelman_required?: boolean };
  if (settings.steelman_required && !input.isSteelman) {
    const [membership] = await db
      .select()
      .from(debateParticipants)
      .where(
        and(eq(debateParticipants.debateId, debateId), eq(debateParticipants.userId, author.id)),
      )
      .limit(1);
    if (membership && membership.sideId === side.id) {
      const confirmed = await db
        .select({ id: debateArguments.id })
        .from(debateArguments)
        .where(
          and(
            eq(debateArguments.debateId, debateId),
            eq(debateArguments.authorId, author.id),
            eq(debateArguments.isSteelman, true),
            sql`${debateArguments.steelmanConfirmedBy} is not null`,
          ),
        )
        .limit(1);
      if (confirmed.length === 0) {
        throw unprocessable(
          "This debate requires a confirmed steelman of the other side before your first argument",
        );
      }
    }
  }
  return db.transaction(async (tx) => {
    const argument = await insertArgumentRow(tx, {
      debateId,
      sideId: side.id,
      author,
      bodyMd: input.bodyMd,
      parentArgumentId: input.parentArgumentId ?? null,
      isSteelman: input.isSteelman ?? false,
      evidence: input.evidence,
    });
    return argument;
  });
}

export async function submitRoundArgument(
  db: Db,
  author: AuthorRef,
  debateId: string,
  roundNo: number,
  input: { bodyMd: string; isSteelman?: boolean; evidence?: EvidenceInput[] },
): Promise<DebateRow> {
  const debate = await getDebateById(db, debateId);
  if (!debate) throw notFound("Debate not found");
  if (input.bodyMd.length > debate.perTurnCharLimit) {
    throw unprocessable(
      `Turns in this debate are capped at ${debate.perTurnCharLimit} characters`,
    );
  }
  if (input.bodyMd.trim().length === 0) throw unprocessable("Turn body must not be empty");
  return db.transaction(async (tx) => {
    const [round] = await tx
      .select()
      .from(debateRounds)
      .where(and(eq(debateRounds.debateId, debateId), eq(debateRounds.roundNo, roundNo)))
      .limit(1);
    if (!round) throw notFound("Round not found");
    if (round.status !== "active") {
      throw conflict(
        round.status === "submitted"
          ? "This turn was already submitted"
          : "This round is not the active turn",
      );
    }
    if (round.turnUserId !== author.id) {
      throw forbidden("It is not your turn");
    }
    if (round.deadlineAt && round.deadlineAt.getTime() < Date.now()) {
      throw conflict("The deadline for this turn has passed");
    }
    const argument = await insertArgumentRow(tx, {
      debateId,
      sideId: round.sideId!,
      author,
      bodyMd: input.bodyMd,
      roundId: round.id,
      isSteelman: input.isSteelman ?? false,
      evidence: input.evidence,
    });
    await tx
      .update(debateRounds)
      .set({ status: "submitted", argumentId: argument.id })
      .where(eq(debateRounds.id, round.id));
    const [fresh] = await tx.select().from(debates).where(eq(debates.id, debateId));
    await activateNextRound(tx, fresh!);
    const [updated] = await tx.select().from(debates).where(eq(debates.id, debateId));
    return updated!;
  });
}

export async function addEvidence(
  db: Db,
  authorId: string,
  argumentId: string,
  links: EvidenceInput[],
): Promise<ArgumentRow> {
  const [argument] = await db
    .select()
    .from(debateArguments)
    .where(eq(debateArguments.id, argumentId))
    .limit(1);
  if (!argument || argument.deletedAt) throw notFound("Argument not found");
  if (argument.authorId !== authorId) {
    throw forbidden("Only the argument's author can add evidence");
  }
  return db.transaction(async (tx) => {
    await insertEvidence(tx, argument, links);
    const [updated] = await tx
      .select()
      .from(debateArguments)
      .where(eq(debateArguments.id, argumentId));
    return updated!;
  });
}

export async function confirmSteelman(
  db: Db,
  userId: string,
  argumentId: string,
): Promise<void> {
  const [argument] = await db
    .select()
    .from(debateArguments)
    .where(eq(debateArguments.id, argumentId))
    .limit(1);
  if (!argument || argument.deletedAt) throw notFound("Argument not found");
  if (!argument.isSteelman) throw unprocessable("This argument is not marked as a steelman");
  if (argument.authorId === userId) {
    throw forbidden("You cannot confirm your own steelman");
  }
  // Only an opposing-side participant (or the judge/host) can confirm.
  const [membership] = await db
    .select()
    .from(debateParticipants)
    .where(
      and(eq(debateParticipants.debateId, argument.debateId), eq(debateParticipants.userId, userId)),
    )
    .limit(1);
  const [debate] = await db.select().from(debates).where(eq(debates.id, argument.debateId));
  const allowed =
    debate?.hostId === userId ||
    debate?.judgeId === userId ||
    (membership !== undefined && membership.sideId !== argument.sideId);
  if (!allowed) {
    throw forbidden("Only the opposing side can confirm a steelman");
  }
  await db
    .update(debateArguments)
    .set({ steelmanConfirmedBy: userId })
    .where(eq(debateArguments.id, argumentId));
}

// ─── Argument votes (shared votes table, target_type 'argument') ────────────

export interface ArgumentVoteSummary {
  upCount: number;
  downCount: number;
  score: number;
  viewerVote: number | null;
}

export async function applyArgumentVote(
  ctx: AppContext,
  voter: AuthorRef,
  argumentId: string,
  newValue: number,
): Promise<ArgumentVoteSummary> {
  const { db, config } = ctx;
  return db.transaction(async (tx) => {
    const [argument] = await tx
      .select()
      .from(debateArguments)
      .where(eq(debateArguments.id, argumentId))
      .limit(1);
    if (!argument || argument.deletedAt) throw notFound("Argument not found");
    if (argument.authorId === voter.id) {
      throw forbidden("You cannot vote on your own argument");
    }
    const [existing] = await tx
      .select()
      .from(votes)
      .where(
        and(
          eq(votes.voterId, voter.id),
          eq(votes.targetType, "argument"),
          eq(votes.targetId, argumentId),
        ),
      )
      .limit(1);
    const oldValue = existing && !existing.voidedAt ? existing.value : 0;
    const weight = voteWeight(voter.authorType, config.AGENT_VOTE_WEIGHT);
    const delta = voteDelta(oldValue, newValue, weight);
    if (!delta) {
      return {
        upCount: argument.upCount,
        downCount: argument.downCount,
        score: Math.round(argument.score),
        viewerVote: oldValue === 0 ? null : oldValue,
      };
    }
    let voteId: string;
    if (newValue === 0) {
      voteId = existing!.id;
      await tx.delete(votes).where(eq(votes.id, existing!.id));
    } else if (existing) {
      voteId = existing.id;
      await tx
        .update(votes)
        .set({ value: newValue, voidedAt: null, voidReason: null, updatedAt: new Date() })
        .where(eq(votes.id, existing.id));
    } else {
      voteId = uuidv7();
      await tx.insert(votes).values({
        id: voteId,
        voterId: voter.id,
        authorType: voter.authorType,
        targetType: "argument",
        targetId: argumentId,
        value: newValue,
      });
    }
    await tx.insert(voteAudit).values({
      voteId,
      voterId: voter.id,
      targetType: "argument",
      targetId: argumentId,
      oldValue: oldValue === 0 ? null : oldValue,
      newValue: newValue === 0 ? null : newValue,
      changeKind: delta.changeKind,
    });
    // Split counters: the bucket follows the VOTER's class (D-012 display)
    // and the direction of the delta.
    const split = (upDelta: number, downDelta: number) =>
      voter.authorType === "agent"
        ? {
            agentUpCount: sql`${debateArguments.agentUpCount} + ${upDelta}`,
            agentDownCount: sql`${debateArguments.agentDownCount} + ${downDelta}`,
          }
        : {
            humanUpCount: sql`${debateArguments.humanUpCount} + ${upDelta}`,
            humanDownCount: sql`${debateArguments.humanDownCount} + ${downDelta}`,
          };
    const [updated] = await tx
      .update(debateArguments)
      .set({
        upCount: sql`${debateArguments.upCount} + ${delta.upDelta}`,
        downCount: sql`${debateArguments.downCount} + ${delta.downDelta}`,
        score: sql`${debateArguments.score} + ${delta.scoreDelta}`,
        ...split(delta.upDelta, delta.downDelta),
      })
      .where(eq(debateArguments.id, argumentId))
      .returning();
    return {
      upCount: updated!.upCount,
      downCount: updated!.downCount,
      score: Math.round(updated!.score),
      viewerVote: newValue === 0 ? null : newValue,
    };
  });
}

// ─── Stance votes & mind-change ──────────────────────────────────────────────

function stanceSideFor(sides: DebateSideRow[], value: number): DebateSideRow | null {
  if (value === 0) return sides.find((s) => s.key === "nuanced") ?? null;
  if (value > 0) {
    return sides.find((s) => s.key === "for") ?? sides.find((s) => s.position === 0) ?? null;
  }
  return (
    sides.find((s) => s.key === "against") ??
    sides.filter((s) => s.key !== "nuanced").sort((a, b) => b.position - a.position)[0] ??
    null
  );
}

export async function allRoundsSubmitted(db: Db, debateId: string): Promise<boolean> {
  const rows = await db
    .select({ status: debateRounds.status })
    .from(debateRounds)
    .where(eq(debateRounds.debateId, debateId));
  return rows.length > 0 && rows.every((r) => r.status === "submitted" || r.status === "missed" || r.status === "skipped");
}

export async function castStanceVote(
  db: Db,
  voter: AuthorRef,
  debateId: string,
  input: { phase: "pre" | "post"; stanceValue: number },
): Promise<void> {
  const debate = await getDebateById(db, debateId);
  if (!debate) throw notFound("Debate not found");
  const [voterRow] = await db.select().from(users).where(eq(users.id, voter.id)).limit(1);
  // D-014: debate stance votes are trust-gated at T1 (post votes are not).
  // D-045: an agent's effective tier is its owner's current tier.
  const voterTier = voterRow ? await effectiveTrustTier(db, voterRow) : null;
  if (!voterRow || voterTier === "T0") {
    throw forbidden("Debate stance votes require trust tier T1 or higher");
  }
  if (input.phase === "pre") {
    if (!["open", "live", "awaiting_turn"].includes(debate.status)) {
      throw conflict("Pre-debate stance is only open while the debate is running");
    }
  } else {
    const finished =
      debate.status === "closed" ||
      debate.status === "archived" ||
      (debate.format !== "open" && (await allRoundsSubmitted(db, debateId)));
    if (!finished) {
      throw conflict("Post-debate stance opens once the debate finishes");
    }
  }
  const sides = await getSides(db, debateId);
  const side = stanceSideFor(sides, input.stanceValue);
  await db
    .insert(stanceVotes)
    .values({
      id: uuidv7(),
      debateId,
      voterId: voter.id,
      authorType: voter.authorType,
      phase: input.phase,
      stanceValue: input.stanceValue,
      sideId: side?.id ?? null,
    })
    .onConflictDoUpdate({
      target: [stanceVotes.debateId, stanceVotes.voterId, stanceVotes.phase],
      set: { stanceValue: input.stanceValue, sideId: side?.id ?? null, updatedAt: new Date() },
    });
}

export interface MindChangeStats {
  preCount: number;
  postCount: number;
  changedCount: number;
  rate: number;
  /** Movement toward each side key (D-032 target-distance formula). */
  towardBySideKey: Map<string, number>;
  distribution: { pre: Record<string, number>; post: Record<string, number> };
}

const SIDE_TARGETS: Record<string, number> = { for: 2, against: -2, nuanced: 0, a: 2, b: -2 };

export async function mindChangeStats(
  db: Db,
  debate: DebateRow,
): Promise<MindChangeStats> {
  const sides = await getSides(db, debate.id);
  const rows = await db
    .select()
    .from(stanceVotes)
    .where(eq(stanceVotes.debateId, debate.id));
  const byVoter = new Map<string, { pre?: StanceRow; post?: StanceRow }>();
  const distribution: MindChangeStats["distribution"] = { pre: {}, post: {} };
  for (const row of rows) {
    distribution[row.phase as "pre" | "post"][String(row.stanceValue)] =
      (distribution[row.phase as "pre" | "post"][String(row.stanceValue)] ?? 0) + 1;
    const entry = byVoter.get(row.voterId) ?? {};
    if (row.phase === "pre") entry.pre = row;
    else entry.post = row;
    byVoter.set(row.voterId, entry);
  }
  let changed = 0;
  let paired = 0;
  const toward = new Map<string, number>(sides.map((s) => [s.key, 0]));
  for (const { pre, post } of byVoter.values()) {
    if (!pre || !post) continue;
    paired += 1;
    if (Math.abs(post.stanceValue - pre.stanceValue) >= 1) changed += 1;
    for (const side of sides) {
      const target = SIDE_TARGETS[side.key] ?? 0;
      const gain =
        Math.abs(pre.stanceValue - target) - Math.abs(post.stanceValue - target);
      if (gain > 0) toward.set(side.key, (toward.get(side.key) ?? 0) + gain);
    }
  }
  return {
    preCount: rows.filter((r) => r.phase === "pre").length,
    postCount: rows.filter((r) => r.phase === "post").length,
    changedCount: changed,
    rate: paired > 0 ? changed / paired : 0,
    towardBySideKey: toward,
    distribution,
  };
}

// ─── Wires ───────────────────────────────────────────────────────────────────

export async function argumentWireFor(
  db: Db,
  argument: ArgumentRow,
  viewerId: string | null,
): Promise<ArgumentWire> {
  const authors = await authorMap(db, [argument.authorId]);
  const sides = await getSides(db, argument.debateId);
  const side = sides.find((s) => s.id === argument.sideId);
  const evidence = await db
    .select()
    .from(evidenceLinks)
    .where(eq(evidenceLinks.argumentId, argument.id));
  let roundNo: number | null = null;
  if (argument.roundId) {
    const [round] = await db
      .select()
      .from(debateRounds)
      .where(eq(debateRounds.id, argument.roundId))
      .limit(1);
    roundNo = round?.roundNo ?? null;
  }
  let viewerVote: "up" | "down" | null = null;
  if (viewerId) {
    const [vote] = await db
      .select()
      .from(votes)
      .where(
        and(
          eq(votes.voterId, viewerId),
          eq(votes.targetType, "argument"),
          eq(votes.targetId, argument.id),
        ),
      )
      .limit(1);
    if (vote && !vote.voidedAt) viewerVote = vote.value === 1 ? "up" : "down";
  }
  const flags = (argument.fallacyFlags ?? []) as Array<{
    fallacy: string;
    confirmed_by_mod?: unknown;
  }>;
  return {
    id: argument.id,
    debate_id: argument.debateId,
    side_key: side?.key ?? "",
    author: authors.get(argument.authorId)!,
    author_type: argument.authorType,
    round_no: roundNo,
    parent_argument_id: argument.parentArgumentId,
    body_md: argument.deletedAt ? "" : argument.bodyMd,
    body_html: argument.deletedAt ? "" : argument.bodyHtml,
    is_steelman: argument.isSteelman,
    steelman_confirmed: argument.steelmanConfirmedBy !== null,
    evidence: evidence.map(evidenceWire),
    fallacy_flags: flags.map((f) => ({
      fallacy: f.fallacy,
      confirmed_by_mod: Boolean(f.confirmed_by_mod),
    })),
    up_count: argument.upCount,
    down_count: argument.downCount,
    score: Math.round(argument.score),
    vote_breakdown: {
      human: { up: argument.humanUpCount, down: argument.humanDownCount },
      agent: { up: argument.agentUpCount, down: argument.agentDownCount },
    },
    evidence_quality: argument.evidenceQuality,
    created_at: argument.createdAt.toISOString(),
    viewer_state: { vote: viewerVote },
  };
}

export async function listArguments(
  db: Db,
  debateId: string,
  opts: { sideKey?: string; roundNo?: number; sort?: "top" | "new"; viewerId: string | null },
): Promise<ArgumentWire[]> {
  const sides = await getSides(db, debateId);
  const conditions = [eq(debateArguments.debateId, debateId), isNull(debateArguments.deletedAt)];
  if (opts.sideKey) {
    const side = sides.find((s) => s.key === opts.sideKey);
    if (!side) return [];
    conditions.push(eq(debateArguments.sideId, side.id));
  }
  let rows = await db
    .select()
    .from(debateArguments)
    .where(and(...conditions))
    .orderBy(desc(debateArguments.createdAt));
  if (opts.roundNo !== undefined) {
    const [round] = await db
      .select()
      .from(debateRounds)
      .where(and(eq(debateRounds.debateId, debateId), eq(debateRounds.roundNo, opts.roundNo)))
      .limit(1);
    rows = round ? rows.filter((r) => r.roundId === round.id) : [];
  }
  if (opts.sort !== "new") rows = [...rows].sort((a, b) => b.score - a.score);
  return Promise.all(rows.map((row) => argumentWireFor(db, row, opts.viewerId)));
}

export async function debateWireFor(
  db: Db,
  debate: DebateRow,
  viewerId: string | null,
): Promise<DebateWire> {
  const sides = await getSides(db, debate.id);
  const participants = await db
    .select()
    .from(debateParticipants)
    .where(eq(debateParticipants.debateId, debate.id));
  const authors = await authorMap(
    db,
    [debate.hostId, debate.judgeId, ...participants.map((p) => p.userId)].filter(
      (id): id is string => !!id,
    ),
  );
  const argumentRows = await db
    .select()
    .from(debateArguments)
    .where(and(eq(debateArguments.debateId, debate.id), isNull(debateArguments.deletedAt)));
  const rounds = await db
    .select()
    .from(debateRounds)
    .where(eq(debateRounds.debateId, debate.id))
    .orderBy(asc(debateRounds.roundNo));
  const sideKeyById = new Map(sides.map((s) => [s.id, s.key]));
  const stats = await mindChangeStats(db, debate);
  // Viewer-specific extras: a pending challenge addressed to the viewer
  // (so the debate page can offer accept/decline) and the pending-judge
  // flag (both debaters missed rounds; the judge must decide).
  let viewerChallenge: { id: string } | null = null;
  if (viewerId && debate.status === "draft") {
    const [challenge] = await db
      .select()
      .from(debateChallenges)
      .where(
        and(
          eq(debateChallenges.debateId, debate.id),
          eq(debateChallenges.challengedId, viewerId),
          eq(debateChallenges.status, "pending"),
        ),
      )
      .limit(1);
    if (challenge) viewerChallenge = { id: challenge.id };
  }
  const winnerDetails = (debate.winnerDetails ?? {}) as { pending_judge?: boolean };
  const activeRound = rounds.find((r) => r.status === "active");
  const winnerSide = debate.winnerSideId
    ? sides.find((s) => s.id === debate.winnerSideId)
    : null;
  const formula = debate.winnerFormula as WinnerFormulaWeights | null;
  let community = null;
  if (debate.communityId) {
    const [row] = await db
      .select()
      .from(communities)
      .where(eq(communities.id, debate.communityId))
      .limit(1);
    if (row) community = communityRef(row);
  }
  return {
    id: debate.id,
    short_code: debate.shortCode,
    post_id: debate.postId,
    proposition: debate.proposition,
    format: debate.format,
    status: debate.status,
    host: authors.get(debate.hostId)!,
    judge: debate.judgeId ? (authors.get(debate.judgeId) ?? null) : null,
    community,
    source_article_url: debate.sourceArticleUrl,
    sides: sides.map((side) => {
      const sideArgs = argumentRows.filter((a) => a.sideId === side.id);
      return {
        id: side.id,
        key: side.key,
        label: side.label,
        argument_count: sideArgs.length,
        human_argument_votes: sideArgs.reduce(
          (sum, a) => sum + a.humanUpCount - a.humanDownCount,
          0,
        ),
        agent_argument_votes: sideArgs.reduce(
          (sum, a) => sum + a.agentUpCount - a.agentDownCount,
          0,
        ),
      };
    }),
    participants: participants.map((p) => ({
      user: authors.get(p.userId)!,
      side_key: sideKeyById.get(p.sideId) ?? "",
      role: p.role,
      elo_at_start: p.eloAtStart,
    })),
    rounds: rounds.map((round) => ({
      round_no: round.roundNo,
      kind: round.kind,
      side_key: round.sideId ? (sideKeyById.get(round.sideId) ?? null) : null,
      deadline_at: round.deadlineAt?.toISOString() ?? null,
      status: round.status,
      argument_id: round.argumentId,
    })),
    current_round: activeRound?.roundNo ?? null,
    per_turn_char_limit: debate.perTurnCharLimit,
    turn_deadline_hours: debate.liveTurnSeconds ? null : debate.turnDeadlineHours,
    winner_side_key: winnerSide?.key ?? null,
    is_draw: debate.isDraw,
    winner_formula: formula
      ? {
          argument_votes: formula.argument_votes,
          mind_change: formula.mind_change,
          evidence_quality: formula.evidence_quality,
        }
      : null,
    mind_change: {
      audience_pre_count: stats.preCount,
      audience_post_count: stats.postCount,
      mind_changed_count: stats.changedCount,
      mind_change_rate: stats.rate,
    },
    scheduled_start_at: debate.scheduledStartAt?.toISOString() ?? null,
    closed_at: debate.closedAt?.toISOString() ?? null,
    created_at: debate.createdAt.toISOString(),
    viewer_challenge: viewerChallenge,
    pending_judge: winnerDetails.pending_judge === true,
  };
}

/** Debate wires for a batch of host posts (feed/thread hydration). */
export async function debateWiresForPosts(
  db: Db,
  postRows: Array<{ id: string; debateId: string | null }>,
  viewerId: string | null,
): Promise<Map<string, DebateWire>> {
  const map = new Map<string, DebateWire>();
  const ids = postRows.map((p) => p.debateId).filter((id): id is string => !!id);
  if (ids.length === 0) return map;
  const rows = await db.select().from(debates).where(inArray(debates.id, ids));
  for (const debate of rows) {
    map.set(debate.postId, await debateWireFor(db, debate, viewerId));
  }
  return map;
}

// ─── Close: winner + Elo ─────────────────────────────────────────────────────

async function applyEloForDebaters(
  tx: Tx,
  debate: DebateRow,
  sides: DebateSideRow[],
  winnerSideKey: string | null,
  isDraw: boolean,
): Promise<void> {
  const participants = await tx
    .select()
    .from(debateParticipants)
    .where(eq(debateParticipants.debateId, debate.id));
  const debaters = participants.filter((p) => p.role === "debater" || p.role === "host");
  if (debaters.length < 2) return;
  const bySide = new Map<string, typeof debaters>();
  for (const debater of debaters) {
    const list = bySide.get(debater.sideId) ?? [];
    list.push(debater);
    bySide.set(debater.sideId, list);
  }
  if (bySide.size !== 2) return;
  const sideList = sides.filter((s) => bySide.has(s.id));
  const [sideX, sideY] = [sideList[0]!, sideList[1]!];
  const ratingsOf = async (members: typeof debaters) => {
    const rows: DebateRatingRow[] = [];
    for (const member of members) {
      const [row] = await tx
        .select()
        .from(debateRatings)
        .where(eq(debateRatings.userId, member.userId))
        .limit(1);
      rows.push(
        row ?? {
          userId: member.userId,
          rating: 1200,
          wins: 0,
          losses: 0,
          draws: 0,
          debatesCount: 0,
          peakRating: 1200,
          updatedAt: new Date(),
        },
      );
    }
    return rows;
  };
  const membersX = bySide.get(sideX.id)!;
  const membersY = bySide.get(sideY.id)!;
  const rowsX = await ratingsOf(membersX);
  const rowsY = await ratingsOf(membersY);
  const mean = (rows: DebateRatingRow[], pick: (r: DebateRatingRow) => number) =>
    rows.reduce((sum, r) => sum + pick(r), 0) / rows.length;
  const meanRatingX = mean(rowsX, (r) => r.rating);
  const meanRatingY = mean(rowsY, (r) => r.rating);
  const meanCountX = mean(rowsX, (r) => r.debatesCount);
  const meanCountY = mean(rowsY, (r) => r.debatesCount);
  const scoreFor = (side: DebateSideRow): 0 | 0.5 | 1 =>
    isDraw ? 0.5 : winnerSideKey === side.key ? 1 : 0;

  const applySide = async (
    rows: DebateRatingRow[],
    oppMean: number,
    oppMeanCount: number,
    side: DebateSideRow,
  ) => {
    const score = scoreFor(side);
    for (const row of rows) {
      const result = eloUpdate(
        row.rating,
        Math.round(oppMean),
        score,
        row.debatesCount,
        Math.round(oppMeanCount),
      );
      const updated = {
        rating: result.newA,
        wins: row.wins + (score === 1 ? 1 : 0),
        losses: row.losses + (score === 0 ? 1 : 0),
        draws: row.draws + (score === 0.5 ? 1 : 0),
        debatesCount: row.debatesCount + 1,
        peakRating: Math.max(row.peakRating, result.newA),
        updatedAt: new Date(),
      };
      await tx
        .insert(debateRatings)
        .values({ userId: row.userId, ...updated })
        .onConflictDoUpdate({ target: debateRatings.userId, set: updated });
      await tx.insert(debateRatingEvents).values({
        id: uuidv7(),
        userId: row.userId,
        debateId: debate.id,
        delta: result.deltaA,
        ratingAfter: result.newA,
      });
    }
  };
  await applySide(rowsX, meanRatingY, meanCountY, sideX);
  await applySide(rowsY, meanRatingX, meanCountX, sideY);
}

export interface CloseOptions {
  /** Set when the close comes from a turn-expiry forfeit. */
  forfeit?: { loserUserId: string; reason: string };
  /** Close without a winner pending a judge decision (both sides missed). */
  pendingJudge?: boolean;
}

export async function closeDebate(
  db: Db,
  debateId: string,
  opts: CloseOptions = {},
): Promise<DebateRow> {
  const debate = await getDebateById(db, debateId);
  if (!debate) throw notFound("Debate not found");
  if (debate.status === "closed" || debate.status === "archived") return debate;
  const sides = await getSides(db, debate.id);
  const stats = await mindChangeStats(db, debate);
  const argumentRows = await db
    .select()
    .from(debateArguments)
    .where(and(eq(debateArguments.debateId, debate.id), isNull(debateArguments.deletedAt)));
  const weights = (debate.winnerFormula as WinnerFormulaWeights) ?? DEFAULT_WINNER_FORMULA;

  const closed = await db.transaction(async (tx) => {
    let winnerSideId: string | null = null;
    let isDraw = false;
    let details: Record<string, unknown> = {};
    if (opts.pendingJudge) {
      details = { pending_judge: true, forfeit: opts.forfeit ?? null };
    } else if (opts.forfeit) {
      const participants = await tx
        .select()
        .from(debateParticipants)
        .where(eq(debateParticipants.debateId, debate.id));
      const loser = participants.find((p) => p.userId === opts.forfeit!.loserUserId);
      const winnerSide = sides.find((s) => s.id !== loser?.sideId) ?? null;
      winnerSideId = winnerSide?.id ?? null;
      details = { forfeit: opts.forfeit, scores: null };
      if (debate.format !== "open" && winnerSide) {
        const [fresh] = await tx.select().from(debates).where(eq(debates.id, debate.id));
        await applyEloForDebaters(tx, fresh!, sides, winnerSide.key, false);
      }
    } else {
      const inputs = sides.map((side) => {
        const sideArgs = argumentRows.filter((a) => a.sideId === side.id);
        return {
          key: side.key,
          argumentScore: sideArgs.reduce((sum, a) => sum + a.score, 0),
          evidenceQuality:
            sideArgs.length > 0
              ? sideArgs.reduce((sum, a) => sum + a.evidenceQuality, 0) / sideArgs.length
              : 0,
          mindChangeToward: stats.towardBySideKey.get(side.key) ?? 0,
        };
      });
      const result = computeDebateWinner(inputs, weights);
      isDraw = result.isDraw;
      winnerSideId = result.winnerKey
        ? (sides.find((s) => s.key === result.winnerKey)?.id ?? null)
        : null;
      details = { scores: result.scores, components: result.components, inputs };
      if (debate.format !== "open") {
        await applyEloForDebaters(tx, debate, sides, result.winnerKey, result.isDraw);
      }
    }
    const [updated] = await tx
      .update(debates)
      .set({
        status: "closed",
        closedAt: new Date(),
        winnerSideId,
        isDraw,
        winnerDetails: details,
        mindChangedCount: stats.changedCount,
        mindChangeRate: stats.rate,
        audiencePreCount: stats.preCount,
        audiencePostCount: stats.postCount,
      })
      .where(eq(debates.id, debate.id))
      .returning();
    return updated!;
  });
  // Phase 5B analytics: debate completion + mind-change outcome.
  await logEvent(db, {
    userId: null,
    type: "debate.completed",
    subjectType: "debate",
    subjectId: closed.id,
    props: {
      mind_changed_count: closed.mindChangedCount,
      mind_change_rate: closed.mindChangeRate,
      audience_pre: closed.audiencePreCount,
      audience_post: closed.audiencePostCount,
    },
  });
  return closed;
}

/** Judge decision after a both-sides-missed close (D-032). */
export async function judgeDecision(
  db: Db,
  judgeId: string,
  debateId: string,
  input: { winnerSideKey?: string | null; isDraw?: boolean },
): Promise<DebateRow> {
  const debate = await getDebateById(db, debateId);
  if (!debate) throw notFound("Debate not found");
  if (debate.judgeId !== judgeId) throw forbidden("Only the debate judge can decide");
  const details = (debate.winnerDetails ?? {}) as { pending_judge?: boolean };
  if (!details.pending_judge) throw conflict("This debate is not awaiting a judge decision");
  const sides = await getSides(db, debate.id);
  return db.transaction(async (tx) => {
    const isDraw = input.isDraw === true || !input.winnerSideKey;
    const winnerSide = isDraw ? null : sides.find((s) => s.key === input.winnerSideKey);
    if (!isDraw && !winnerSide) throw unprocessable(`Unknown side_key: ${input.winnerSideKey}`);
    if (debate.format !== "open") {
      await applyEloForDebaters(tx, debate, sides, winnerSide?.key ?? null, isDraw);
    }
    const [updated] = await tx
      .update(debates)
      .set({
        winnerSideId: winnerSide?.id ?? null,
        isDraw,
        winnerDetails: { ...details, pending_judge: false, judge_decision: true },
      })
      .where(eq(debates.id, debate.id))
      .returning();
    return updated!;
  });
}

// ─── Turn expiry (worker + tests share this; D-032) ──────────────────────────

/**
 * Sweep overdue active rounds. A missed turn advances the debate; two
 * consecutive misses by one debater — or missing the final turn — forfeits
 * the debate to the other side. If both debaters have missed and a judge is
 * set, the debate closes pending the judge instead.
 */
export async function expireOverdueTurns(db: Db, now: Date = new Date()): Promise<number> {
  const overdue = await db
    .select()
    .from(debateRounds)
    .where(and(eq(debateRounds.status, "active"), lt(debateRounds.deadlineAt, now)));
  let handled = 0;
  for (const round of overdue) {
    const debate = await getDebateById(db, round.debateId);
    if (!debate || debate.status === "closed" || debate.status === "archived" || debate.status === "cancelled") {
      continue;
    }
    await db.transaction(async (tx) => {
      const [fresh] = await tx
        .select()
        .from(debateRounds)
        .where(eq(debateRounds.id, round.id))
        .limit(1);
      if (!fresh || fresh.status !== "active") return;
      await tx
        .update(debateRounds)
        .set({ status: "missed" })
        .where(eq(debateRounds.id, round.id));
      const rounds = await tx
        .select()
        .from(debateRounds)
        .where(eq(debateRounds.debateId, debate.id))
        .orderBy(asc(debateRounds.roundNo));
      const loserId = fresh.turnUserId;
      // Consecutive misses by this debater, walking back from this round.
      let consecutive = 0;
      for (const r of [...rounds].reverse()) {
        if (r.roundNo > fresh.roundNo) continue;
        if (r.turnUserId === loserId && (r.status === "missed" || r.id === fresh.id)) {
          consecutive += 1;
        } else if (r.turnUserId === loserId) {
          break;
        }
      }
      const isFinalTurn = rounds.every(
        (r) => r.roundNo <= fresh.roundNo || r.status !== "pending",
      );
      const anyoneMissed = rounds.some(
        (r) => r.status === "missed" && r.turnUserId !== loserId,
      );
      if (consecutive >= 2 || isFinalTurn) {
        if (debate.judgeId && anyoneMissed) {
          await closeDebate(tx as unknown as Db, debate.id, {
            pendingJudge: true,
            forfeit: { loserUserId: loserId ?? "", reason: "both sides missed turns" },
          });
        } else if (loserId) {
          await closeDebate(tx as unknown as Db, debate.id, {
            forfeit: { loserUserId: loserId, reason: "missed turn deadline" },
          });
        }
        // Mark remaining pending rounds skipped for a clean archive.
        await tx
          .update(debateRounds)
          .set({ status: "skipped" })
          .where(
            and(eq(debateRounds.debateId, debate.id), eq(debateRounds.status, "pending")),
          );
      } else {
        const [freshDebate] = await tx.select().from(debates).where(eq(debates.id, debate.id));
        await activateNextRound(tx, freshDebate!);
      }
    });
    handled += 1;
  }
  return handled;
}

// ─── Perspective ("Other side" card) ─────────────────────────────────────────

export async function perspectiveFor(
  db: Db,
  debate: DebateRow,
  viewerId: string | null,
): Promise<ArgumentWire | null> {
  const sides = await getSides(db, debate.id);
  let targetSide: DebateSideRow | undefined;
  if (viewerId) {
    const [pre] = await db
      .select()
      .from(stanceVotes)
      .where(
        and(
          eq(stanceVotes.debateId, debate.id),
          eq(stanceVotes.voterId, viewerId),
          eq(stanceVotes.phase, "pre"),
        ),
      )
      .limit(1);
    if (pre) {
      targetSide =
        pre.stanceValue > 0
          ? sides.find((s) => s.key === "against")
          : pre.stanceValue < 0
            ? sides.find((s) => s.key === "for")
            : sides.find((s) => s.key === "for");
    }
  }
  const rows = await db
    .select()
    .from(debateArguments)
    .where(and(eq(debateArguments.debateId, debate.id), isNull(debateArguments.deletedAt)))
    .orderBy(desc(debateArguments.score));
  const pick = targetSide
    ? (rows.find((r) => r.sideId === targetSide!.id) ?? rows[0])
    : rows[0];
  if (!pick) return null;
  return argumentWireFor(db, pick, viewerId);
}

// ─── From-article unfurl (best-effort, pattern follows the LINK card stub) ──

export async function fetchArticleCard(
  articleUrl: string,
): Promise<{ title: string | null; description: string | null; image: string | null; domain: string }> {
  const domain = new URL(articleUrl).hostname;
  const fallback = { title: null, description: null, image: null, domain };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(articleUrl, {
      signal: controller.signal,
      headers: { "user-agent": "GG debate unfurl (+https://gg.genznewz.com)" },
    });
    clearTimeout(timer);
    if (!response.ok) return fallback;
    const html = (await response.text()).slice(0, 200_000);
    const meta = (property: string): string | null => {
      const match =
        html.match(new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, "i")) ??
        html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, "i"));
      return match?.[1]?.trim() ?? null;
    };
    const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? null;
    return {
      title: meta("og:title") ?? titleTag,
      description: meta("og:description"),
      image: meta("og:image"),
      domain,
    };
  } catch {
    return fallback;
  }
}
