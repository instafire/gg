/**
 * Phase 3 worker sweeps (queue `gg-opinion`):
 *  - `pulse.publish`      — Daily Pulse at 00:05 ET (D-031); the API also
 *                           lazy-creates on read, and the unique pulse_date
 *                           index arbitrates races. Idempotent per ET day.
 *  - `debate.expire-turns`— every 5 min: overdue structured-debate turns are
 *                           missed; 2 consecutive misses (or the final turn)
 *                           forfeit the debate (D-032), mirroring the API's
 *                           services/debates.expireOverdueTurns. All math
 *                           (winner formula, Elo) comes from @gg/shared.
 *  - `poll.close-expired` — every 5 min: polls past closes_at are closed;
 *                           ranked polls get their IRV snapshot cached.
 *  - `debate.archive`     — daily: debates closed > 30 days → archived.
 *
 * Follows the story-sweep pattern: pure orchestration over a repo
 * interface; drizzle implementation below; unit tests use a fake repo.
 */
import { randomBytes } from "node:crypto";
import { and, asc, eq, isNull, lt } from "drizzle-orm";
import {
  DEFAULT_WINNER_FORMULA,
  computeDebateWinner,
  eloUpdate,
  etMidnightAfter,
  etToday,
  tallyIrv,
  type WinnerFormulaWeights,
} from "@gg/shared";
import {
  dailyPulseQuestionsTable,
  debateArgumentsTable,
  debateParticipantsTable,
  debateRatingEventsTable,
  debateRatingsTable,
  debateRoundsTable,
  debateSidesTable,
  debatesTable,
  notificationsTable,
  pollOptionsTable,
  pollVotesTable,
  pollsTable,
  postsTable,
  stanceVotesTable,
  usersTable,
  type WorkerDb,
} from "./db";

// ─── id helpers (same algorithms as the API's lib/ids) ───────────────────────

export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
export function shortCode(): string {
  const bytes = randomBytes(10);
  let out = "";
  for (const b of bytes) out += BASE62[b % BASE62.length];
  return out;
}

// ─── Repo ────────────────────────────────────────────────────────────────────

export interface BankQuestion {
  id: string;
  question: string;
  type: string;
  options: string[];
  scheduledDate: string | null;
}

export interface DebateSweepRow {
  id: string;
  status: string;
  format: string;
  judgeId: string | null;
  liveTurnSeconds: number | null;
  turnDeadlineHours: number;
  winnerFormula: WinnerFormulaWeights | null;
}

export interface RoundSweepRow {
  id: string;
  debateId: string;
  roundNo: number;
  sideId: string | null;
  turnUserId: string | null;
  status: string;
  deadlineAt: Date | null;
}

export interface SideSweepRow {
  id: string;
  key: string;
  position: number;
}

export interface RatingSweepRow {
  userId: string;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  debatesCount: number;
  peakRating: number;
}

export interface EloApplication {
  userId: string;
  delta: number;
  ratingAfter: number;
  outcome: "win" | "loss" | "draw";
}

export interface OpinionRepo {
  pulseAuthor(handle: string): Promise<{ id: string; authorType: string } | null>;
  pulseForDate(date: string): Promise<{ id: string } | null>;
  bankQuestions(): Promise<BankQuestion[]>;
  createPulsePost(input: {
    postId: string;
    pollId: string;
    authorId: string;
    authorType: string;
    question: string;
    type: string;
    optionTexts: string[];
    closesAt: Date;
    pulseDate: string;
  }): Promise<void>;
  markQuestionUsed(questionId: string, date: string): Promise<void>;

  expiredOpenPolls(now: Date): Promise<Array<{ id: string; type: string }>>;
  pollOptionIds(pollId: string): Promise<string[]>;
  liveRankings(pollId: string): Promise<string[][]>;
  closePoll(pollId: string, rankingCache: unknown): Promise<void>;

  overdueRounds(now: Date): Promise<RoundSweepRow[]>;
  debateById(id: string): Promise<DebateSweepRow | null>;
  roundsOf(debateId: string): Promise<RoundSweepRow[]>;
  markRoundMissed(roundId: string): Promise<void>;
  activateRound(roundId: string, startsAt: Date, deadlineAt: Date): Promise<void>;
  skipPendingRounds(debateId: string): Promise<void>;
  notifyTurn(recipientId: string, debateId: string, roundNo: number): Promise<void>;

  sidesOf(debateId: string): Promise<SideSweepRow[]>;
  participantsOf(debateId: string): Promise<Array<{ userId: string; sideId: string; role: string }>>;
  argumentsOf(debateId: string): Promise<Array<{ sideId: string; score: number; evidenceQuality: number }>>;
  stancePairs(debateId: string): Promise<Array<{ voterId: string; phase: string; stanceValue: number }>>;
  ratingsOf(userIds: string[]): Promise<Map<string, RatingSweepRow>>;
  closeDebate(input: {
    debateId: string;
    winnerSideId: string | null;
    isDraw: boolean;
    details: Record<string, unknown>;
    mindChangedCount: number;
    mindChangeRate: number;
    preCount: number;
    postCount: number;
    elo: EloApplication[];
    ratings: RatingSweepRow[];
  }): Promise<void>;

  archiveClosedBefore(cutoff: Date): Promise<number>;
}

// ─── Orchestration: Daily Pulse ──────────────────────────────────────────────

export async function publishDailyPulse(
  repo: OpinionRepo,
  authorHandle: string,
  now: Date = new Date(),
): Promise<{ published: boolean; reason?: string }> {
  const today = etToday(now);
  if (await repo.pulseForDate(today)) return { published: false, reason: "already published" };
  const author = await repo.pulseAuthor(authorHandle);
  if (!author) return { published: false, reason: "pulse author missing" };
  const bank = await repo.bankQuestions();
  const question =
    bank.find((q) => q.scheduledDate === today) ?? bank.find((q) => q.scheduledDate === null);
  if (!question) return { published: false, reason: "question bank empty" };
  await repo.createPulsePost({
    postId: uuidv7(),
    pollId: uuidv7(),
    authorId: author.id,
    authorType: author.authorType,
    question: question.question,
    type: question.type,
    optionTexts: question.options,
    closesAt: etMidnightAfter(today),
    pulseDate: today,
  });
  await repo.markQuestionUsed(question.id, today);
  return { published: true };
}

// ─── Orchestration: poll auto-close ──────────────────────────────────────────

export async function closeExpiredPolls(
  repo: OpinionRepo,
  now: Date = new Date(),
  hooks?: { onPollClosed?: (pollId: string) => Promise<void> },
): Promise<{ closed: number }> {
  const expired = await repo.expiredOpenPolls(now);
  for (const poll of expired) {
    let cache: unknown = null;
    if (poll.type === "ranked") {
      const optionIds = await repo.pollOptionIds(poll.id);
      const rankings = await repo.liveRankings(poll.id);
      cache = { irv: tallyIrv(rankings, optionIds), tabulated_at: now.toISOString() };
    }
    await repo.closePoll(poll.id, cache);
    // Phase 4: poll.closed webhooks for sweep-closed polls (D-042).
    await hooks?.onPollClosed?.(poll.id).catch(() => undefined);
  }
  return { closed: expired.length };
}

// ─── Orchestration: debate turn expiry ───────────────────────────────────────

const SIDE_TARGETS: Record<string, number> = { for: 2, against: -2, nuanced: 0, a: 2, b: -2 };

function mindChange(
  pairs: Array<{ voterId: string; phase: string; stanceValue: number }>,
  sides: SideSweepRow[],
): { changed: number; rate: number; preCount: number; postCount: number; toward: Map<string, number> } {
  const byVoter = new Map<string, { pre?: number; post?: number }>();
  let preCount = 0;
  let postCount = 0;
  for (const row of pairs) {
    if (row.phase === "pre") preCount += 1;
    else postCount += 1;
    const entry = byVoter.get(row.voterId) ?? {};
    if (row.phase === "pre") entry.pre = row.stanceValue;
    else entry.post = row.stanceValue;
    byVoter.set(row.voterId, entry);
  }
  let changed = 0;
  let paired = 0;
  const toward = new Map<string, number>(sides.map((s) => [s.key, 0]));
  for (const { pre, post } of byVoter.values()) {
    if (pre === undefined || post === undefined) continue;
    paired += 1;
    if (Math.abs(post - pre) >= 1) changed += 1;
    for (const side of sides) {
      const target = SIDE_TARGETS[side.key] ?? 0;
      const gain = Math.abs(pre - target) - Math.abs(post - target);
      if (gain > 0) toward.set(side.key, (toward.get(side.key) ?? 0) + gain);
    }
  }
  return {
    changed,
    rate: paired > 0 ? changed / paired : 0,
    preCount,
    postCount,
    toward,
  };
}

/** Elo applications for a decided debate (mirrors the API close path). */
export function eloApplications(
  participants: Array<{ userId: string; sideId: string; role: string }>,
  sides: SideSweepRow[],
  ratings: Map<string, RatingSweepRow>,
  winnerSideKey: string | null,
  isDraw: boolean,
): { elo: EloApplication[]; ratings: RatingSweepRow[] } {
  const debaters = participants.filter((p) => p.role === "debater" || p.role === "host");
  const bySide = new Map<string, typeof debaters>();
  for (const d of debaters) {
    const list = bySide.get(d.sideId) ?? [];
    list.push(d);
    bySide.set(d.sideId, list);
  }
  if (bySide.size !== 2) return { elo: [], ratings: [] };
  const sideList = sides.filter((s) => bySide.has(s.id));
  const [sideX, sideY] = [sideList[0]!, sideList[1]!];
  const ratingOf = (userId: string): RatingSweepRow =>
    ratings.get(userId) ?? {
      userId,
      rating: 1200,
      wins: 0,
      losses: 0,
      draws: 0,
      debatesCount: 0,
      peakRating: 1200,
    };
  const mean = (members: typeof debaters, pick: (r: RatingSweepRow) => number) =>
    members.reduce((sum, m) => sum + pick(ratingOf(m.userId)), 0) / members.length;
  const elo: EloApplication[] = [];
  const updated: RatingSweepRow[] = [];
  const applySide = (side: SideSweepRow, opp: SideSweepRow) => {
    const members = bySide.get(side.id)!;
    const opponents = bySide.get(opp.id)!;
    const oppMeanRating = Math.round(mean(opponents, (r) => r.rating));
    const oppMeanCount = Math.round(mean(opponents, (r) => r.debatesCount));
    const score: 0 | 0.5 | 1 = isDraw ? 0.5 : winnerSideKey === side.key ? 1 : 0;
    for (const member of members) {
      const row = ratingOf(member.userId);
      const result = eloUpdate(row.rating, oppMeanRating, score, row.debatesCount, oppMeanCount);
      elo.push({
        userId: member.userId,
        delta: result.deltaA,
        ratingAfter: result.newA,
        outcome: score === 1 ? "win" : score === 0 ? "loss" : "draw",
      });
      updated.push({
        userId: member.userId,
        rating: result.newA,
        wins: row.wins + (score === 1 ? 1 : 0),
        losses: row.losses + (score === 0 ? 1 : 0),
        draws: row.draws + (score === 0.5 ? 1 : 0),
        debatesCount: row.debatesCount + 1,
        peakRating: Math.max(row.peakRating, result.newA),
      });
    }
  };
  applySide(sideX, sideY);
  applySide(sideY, sideX);
  return { elo, ratings: updated };
}

export async function expireDebateTurns(
  repo: OpinionRepo,
  now: Date = new Date(),
  hooks?: { onDebateTouched?: (debateId: string) => Promise<void> },
): Promise<{ expired: number }> {
  const overdue = await repo.overdueRounds(now);
  const touchedDebates = new Set<string>();
  let handled = 0;
  for (const round of overdue) {
    const debate = await repo.debateById(round.debateId);
    if (!debate || ["closed", "archived", "cancelled"].includes(debate.status)) continue;
    await repo.markRoundMissed(round.id);
    const rounds = await repo.roundsOf(debate.id);
    const loserId = round.turnUserId;
    let consecutive = 0;
    for (const r of [...rounds].reverse()) {
      if (r.roundNo > round.roundNo) continue;
      if (r.turnUserId === loserId && (r.status === "missed" || r.id === round.id)) consecutive += 1;
      else if (r.turnUserId === loserId) break;
    }
    const isFinalTurn = rounds.every((r) => r.roundNo <= round.roundNo || r.status !== "pending");
    const anyoneMissed = rounds.some((r) => r.status === "missed" && r.turnUserId !== loserId);
    if ((consecutive >= 2 || isFinalTurn) && loserId) {
      const sides = await repo.sidesOf(debate.id);
      const participants = await repo.participantsOf(debate.id);
      const pairs = await repo.stancePairs(debate.id);
      const stats = mindChange(pairs, sides);
      if (debate.judgeId && anyoneMissed) {
        await repo.closeDebate({
          debateId: debate.id,
          winnerSideId: null,
          isDraw: false,
          details: { pending_judge: true, forfeit: { loserUserId: loserId, reason: "both sides missed turns" } },
          mindChangedCount: stats.changed,
          mindChangeRate: stats.rate,
          preCount: stats.preCount,
          postCount: stats.postCount,
          elo: [],
          ratings: [],
        });
      } else {
        const loser = participants.find((p) => p.userId === loserId);
        const winnerSide = sides.find((s) => s.id !== loser?.sideId) ?? null;
        const { elo, ratings } = eloApplications(
          participants,
          sides,
          await repo.ratingsOf(participants.map((p) => p.userId)),
          winnerSide?.key ?? null,
          false,
        );
        await repo.closeDebate({
          debateId: debate.id,
          winnerSideId: winnerSide?.id ?? null,
          isDraw: false,
          details: { forfeit: { loserUserId: loserId, reason: "missed turn deadline" }, scores: null },
          mindChangedCount: stats.changed,
          mindChangeRate: stats.rate,
          preCount: stats.preCount,
          postCount: stats.postCount,
          elo,
          ratings,
        });
      }
      await repo.skipPendingRounds(debate.id);
    } else {
      const next = rounds
        .filter((r) => r.status === "pending")
        .sort((a, b) => a.roundNo - b.roundNo)[0];
      if (next) {
        const turnMs = debate.liveTurnSeconds
          ? debate.liveTurnSeconds * 1000
          : debate.turnDeadlineHours * 3_600_000;
        await repo.activateRound(next.id, now, new Date(now.getTime() + turnMs));
        if (next.turnUserId) await repo.notifyTurn(next.turnUserId, debate.id, next.roundNo);
      }
    }
    handled += 1;
    touchedDebates.add(round.debateId);
  }
  // Phase 4: debate.turn_due / debate.closed webhooks for expiry-driven
  // turn changes (D-042). Hook failures never fail the sweep.
  if (hooks?.onDebateTouched) {
    for (const debateId of touchedDebates) {
      await hooks.onDebateTouched(debateId).catch(() => undefined);
    }
  }
  return { expired: handled };
}

/** Non-forfeit close computation (used by tests to pin the formula wiring). */
export function winnerComputation(
  sides: SideSweepRow[],
  args: Array<{ sideId: string; score: number; evidenceQuality: number }>,
  toward: Map<string, number>,
  weights: WinnerFormulaWeights = DEFAULT_WINNER_FORMULA,
) {
  const inputs = sides.map((side) => {
    const sideArgs = args.filter((a) => a.sideId === side.id);
    return {
      key: side.key,
      argumentScore: sideArgs.reduce((sum, a) => sum + a.score, 0),
      evidenceQuality:
        sideArgs.length > 0
          ? sideArgs.reduce((sum, a) => sum + a.evidenceQuality, 0) / sideArgs.length
          : 0,
      mindChangeToward: toward.get(side.key) ?? 0,
    };
  });
  return computeDebateWinner(inputs, weights);
}

// ─── Drizzle repo ────────────────────────────────────────────────────────────

export function drizzleOpinionRepo(db: WorkerDb, pulseAuthorHandle: string): OpinionRepo {
  void pulseAuthorHandle;
  return {
    async pulseAuthor(handle) {
      const [row] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.handle, handle))
        .limit(1);
      return row ? { id: row.id, authorType: row.authorType } : null;
    },
    async pulseForDate(date) {
      const [row] = await db
        .select()
        .from(pollsTable)
        .where(and(eq(pollsTable.isDailyPulse, true), eq(pollsTable.pulseDate, date)))
        .limit(1);
      return row ? { id: row.id } : null;
    },
    async bankQuestions() {
      const rows = await db
        .select()
        .from(dailyPulseQuestionsTable)
        .where(and(eq(dailyPulseQuestionsTable.isActive, true), isNull(dailyPulseQuestionsTable.usedDate)))
        .orderBy(asc(dailyPulseQuestionsTable.createdAt));
      return rows.map((row) => ({
        id: row.id,
        question: row.question,
        type: row.type,
        options: (row.options as string[]) ?? [],
        scheduledDate: row.scheduledDate,
      }));
    },
    async createPulsePost(input) {
      const label = input.postId.replaceAll("-", "");
      await db.insert(postsTable).values({
        id: input.postId,
        shortCode: shortCode(),
        authorId: input.authorId,
        authorType: input.authorType,
        type: "POLL",
        rootId: input.postId,
        path: label,
        pathLabel: label,
        title: input.question,
        bodyMd: "Today's Daily Pulse — one question, one day. Results are final at midnight ET.",
        bodyHtml: "<p>Today&#39;s Daily Pulse — one question, one day. Results are final at midnight ET.</p>",
        visibility: "public",
        pollId: input.pollId,
      });
      await db.insert(pollsTable).values({
        id: input.pollId,
        postId: input.postId,
        type: input.type,
        question: input.question,
        resultMode: "live",
        closesAt: input.closesAt,
        isDailyPulse: true,
        pulseDate: input.pulseDate,
      });
      for (const [position, text] of input.optionTexts.entries()) {
        await db.insert(pollOptionsTable).values({
          id: uuidv7(),
          pollId: input.pollId,
          position,
          text,
        });
      }
    },
    async markQuestionUsed(questionId, date) {
      await db
        .update(dailyPulseQuestionsTable)
        .set({ usedDate: date })
        .where(eq(dailyPulseQuestionsTable.id, questionId));
    },
    async expiredOpenPolls(now) {
      const rows = await db
        .select()
        .from(pollsTable)
        .where(and(isNull(pollsTable.closedAt), lt(pollsTable.closesAt, now)));
      return rows.map((r) => ({ id: r.id, type: r.type }));
    },
    async pollOptionIds(pollId) {
      const rows = await db
        .select()
        .from(pollOptionsTable)
        .where(eq(pollOptionsTable.pollId, pollId))
        .orderBy(asc(pollOptionsTable.position));
      return rows.map((r) => r.id);
    },
    async liveRankings(pollId) {
      const rows = await db
        .select()
        .from(pollVotesTable)
        .where(and(eq(pollVotesTable.pollId, pollId), isNull(pollVotesTable.voidedAt)));
      return rows.map((r) => r.ranking ?? []).filter((r) => r.length > 0);
    },
    async closePoll(pollId, rankingCache) {
      await db
        .update(pollsTable)
        .set({ closedAt: new Date(), rankingCache })
        .where(eq(pollsTable.id, pollId));
    },
    async overdueRounds(now) {
      const rows = await db
        .select()
        .from(debateRoundsTable)
        .where(and(eq(debateRoundsTable.status, "active"), lt(debateRoundsTable.deadlineAt, now)));
      return rows.map((r) => ({ ...r, deadlineAt: r.deadlineAt ?? null }));
    },
    async debateById(id) {
      const [row] = await db.select().from(debatesTable).where(eq(debatesTable.id, id)).limit(1);
      if (!row) return null;
      return {
        id: row.id,
        status: row.status,
        format: row.format,
        judgeId: row.judgeId,
        liveTurnSeconds: row.liveTurnSeconds,
        turnDeadlineHours: row.turnDeadlineHours,
        winnerFormula: (row.winnerFormula as WinnerFormulaWeights | null) ?? null,
      };
    },
    async roundsOf(debateId) {
      const rows = await db
        .select()
        .from(debateRoundsTable)
        .where(eq(debateRoundsTable.debateId, debateId))
        .orderBy(asc(debateRoundsTable.roundNo));
      return rows.map((r) => ({ ...r, deadlineAt: r.deadlineAt ?? null }));
    },
    async markRoundMissed(roundId) {
      await db
        .update(debateRoundsTable)
        .set({ status: "missed" })
        .where(eq(debateRoundsTable.id, roundId));
    },
    async activateRound(roundId, startsAt, deadlineAt) {
      await db
        .update(debateRoundsTable)
        .set({ status: "active", startsAt, deadlineAt })
        .where(eq(debateRoundsTable.id, roundId));
    },
    async skipPendingRounds(debateId) {
      await db
        .update(debateRoundsTable)
        .set({ status: "skipped" })
        .where(and(eq(debateRoundsTable.debateId, debateId), eq(debateRoundsTable.status, "pending")));
    },
    async notifyTurn(recipientId, debateId, roundNo) {
      await db.insert(notificationsTable).values({
        id: uuidv7(),
        recipientId,
        type: "debate_turn",
        actorId: null,
        subjectType: "debate",
        subjectId: debateId,
        groupKey: `debate_turn:system:debate:${debateId}`,
        payload: { round_no: roundNo },
      });
    },
    async sidesOf(debateId) {
      const rows = await db
        .select()
        .from(debateSidesTable)
        .where(eq(debateSidesTable.debateId, debateId))
        .orderBy(asc(debateSidesTable.position));
      return rows;
    },
    async participantsOf(debateId) {
      return db
        .select()
        .from(debateParticipantsTable)
        .where(eq(debateParticipantsTable.debateId, debateId));
    },
    async argumentsOf(debateId) {
      const rows = await db
        .select()
        .from(debateArgumentsTable)
        .where(and(eq(debateArgumentsTable.debateId, debateId), isNull(debateArgumentsTable.deletedAt)));
      return rows.map((r) => ({
        sideId: r.sideId,
        score: r.score ?? 0,
        evidenceQuality: r.evidenceQuality ?? 0,
      }));
    },
    async stancePairs(debateId) {
      return db
        .select()
        .from(stanceVotesTable)
        .where(eq(stanceVotesTable.debateId, debateId));
    },
    async ratingsOf(userIds) {
      const map = new Map<string, RatingSweepRow>();
      for (const userId of userIds) {
        const [row] = await db
          .select()
          .from(debateRatingsTable)
          .where(eq(debateRatingsTable.userId, userId))
          .limit(1);
        if (row) map.set(userId, row);
      }
      return map;
    },
    async closeDebate(input) {
      await db
        .update(debatesTable)
        .set({
          status: "closed",
          closedAt: new Date(),
          winnerSideId: input.winnerSideId,
          isDraw: input.isDraw,
          winnerDetails: input.details,
          mindChangedCount: input.mindChangedCount,
          mindChangeRate: input.mindChangeRate,
          audiencePreCount: input.preCount,
          audiencePostCount: input.postCount,
        })
        .where(eq(debatesTable.id, input.debateId));
      for (const rating of input.ratings) {
        await db
          .insert(debateRatingsTable)
          .values(rating)
          .onConflictDoUpdate({ target: debateRatingsTable.userId, set: rating });
      }
      for (const event of input.elo) {
        await db.insert(debateRatingEventsTable).values({
          id: uuidv7(),
          userId: event.userId,
          debateId: input.debateId,
          delta: event.delta,
          ratingAfter: event.ratingAfter,
        });
      }
    },
    async archiveClosedBefore(cutoff) {
      const rows = await db
        .select()
        .from(debatesTable)
        .where(and(eq(debatesTable.status, "closed"), lt(debatesTable.closedAt, cutoff)));
      for (const row of rows) {
        await db
          .update(debatesTable)
          .set({ status: "archived" })
          .where(eq(debatesTable.id, row.id));
      }
      return rows.length;
    },
  };
}
