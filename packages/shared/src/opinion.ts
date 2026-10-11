/**
 * Phase 3 — Opinion & Debate pure functions (docs/DATA_MODEL.md §6/§8,
 * docs/DECISIONS.md D-029..D-033).
 *
 * Everything here is pure and deterministic: the IRV tabulation, the debate
 * winner formula, Elo updates and the evidence-quality heuristic. The API
 * and worker call these; the web may preview with them. No I/O, no clock
 * reads — callers pass time-sensitive inputs in.
 */

// ─── Stance scale ────────────────────────────────────────────────────────────

/** Stance values run −2 (strongly against) … +2 (strongly for). */
export const STANCE_MIN = -2;
export const STANCE_MAX = 2;

/** The five slider stops, most-against first — also the distribution buckets. */
export const STANCE_STOPS = [-2, -1, 0, 1, 2] as const;

// ─── Ranked-choice (IRV) tabulation ──────────────────────────────────────────

export interface IrvRound {
  /** 1-based round number. */
  round: number;
  /** Continuing (non-exhausted) ballots counted this round. */
  ballots_counted: number;
  /** First-preference tallies per still-active option id. */
  tallies: Record<string, number>;
  /** Option eliminated at the end of this round; null on the final round. */
  eliminated_option_id: string | null;
}

export interface IrvResult {
  winner_option_id: string | null;
  rounds: IrvRound[];
  total_ballots: number;
  /** Ballots with no continuing preference in the final round. */
  exhausted_ballots: number;
}

/**
 * Instant-runoff tabulation.
 *
 * Rules (each covered by unit tests):
 * - A ballot counts for its highest-ranked still-active option; a ballot with
 *   no active preference left is exhausted and leaves the denominator.
 * - A candidate wins with a strict majority (> 50%) of continuing ballots,
 *   or by being the last active candidate.
 * - The lowest-tally candidate is eliminated each round. Ties for lowest are
 *   broken by the tied candidates' tallies in earlier rounds (fewest in the
 *   earliest differing round loses); a tie that survives every round is
 *   broken deterministically by option id (lexicographically last loses) so
 *   tabulation is reproducible.
 * - Zero ballots (or all ballots empty) → no winner, no rounds.
 */
export function tallyIrv(ballots: string[][], optionIds: string[]): IrvResult {
  const usable = ballots.filter((ranking) => ranking.length > 0);
  if (usable.length === 0 || optionIds.length === 0) {
    return { winner_option_id: null, rounds: [], total_ballots: ballots.length, exhausted_ballots: ballots.length };
  }
  const active = new Set(optionIds);
  const rounds: IrvRound[] = [];
  let exhausted = 0;

  for (;;) {
    const tallies: Record<string, number> = {};
    for (const id of active) tallies[id] = 0;
    let counted = 0;
    exhausted = 0;
    for (const ranking of usable) {
      const pick = ranking.find((id) => active.has(id));
      if (pick === undefined) {
        exhausted += 1;
      } else {
        tallies[pick] = (tallies[pick] ?? 0) + 1;
        counted += 1;
      }
    }

    const roundNo = rounds.length + 1;
    const entries = Object.entries(tallies);
    const majorityPick = entries.find(([, count]) => counted > 0 && count > counted / 2);
    const lastStanding = active.size === 1 ? [...active][0]! : null;
    const winner = majorityPick?.[0] ?? lastStanding;

    if (winner !== null && winner !== undefined) {
      rounds.push({ round: roundNo, ballots_counted: counted, tallies, eliminated_option_id: null });
      return { winner_option_id: winner, rounds, total_ballots: ballots.length, exhausted_ballots: exhausted };
    }
    if (counted === 0) {
      // Every ballot exhausted with >1 candidate still active: no winner can
      // be derived — stop rather than eliminating on zero information.
      rounds.push({ round: roundNo, ballots_counted: 0, tallies, eliminated_option_id: null });
      return { winner_option_id: null, rounds, total_ballots: ballots.length, exhausted_ballots: exhausted };
    }

    // Eliminate the lowest tally with the documented tie-breaks.
    const minTally = Math.min(...entries.map(([, count]) => count));
    let tied = entries.filter(([, count]) => count === minTally).map(([id]) => id);
    for (let r = 0; r < rounds.length && tied.length > 1; r += 1) {
      const past = rounds[r]!.tallies;
      const pastMin = Math.min(...tied.map((id) => past[id] ?? 0));
      tied = tied.filter((id) => (past[id] ?? 0) === pastMin);
    }
    tied.sort();
    const eliminated = tied[tied.length - 1]!;
    rounds.push({ round: roundNo, ballots_counted: counted, tallies, eliminated_option_id: eliminated });
    active.delete(eliminated);
  }
}

// ─── Debate winner formula (DATA_MODEL §8.1, D-032) ─────────────────────────

export interface WinnerFormulaWeights {
  argument_votes: number;
  mind_change: number;
  evidence_quality: number;
}

/** The spec snapshot defaults, stored on every structured debate at creation. */
export const DEFAULT_WINNER_FORMULA: WinnerFormulaWeights = {
  argument_votes: 0.5,
  mind_change: 0.35,
  evidence_quality: 0.15,
};

/** Final-score gap below which a debate is a draw. */
export const WINNER_DRAW_THRESHOLD = 0.02;

export interface DebateSideScoreInput {
  key: string;
  /** Net score (up − down, split tallies combined at weight 1.0, D-012) of the side's arguments. */
  argumentScore: number;
  /** Mean evidence quality of the side's arguments, 0..1 (0 when none). */
  evidenceQuality: number;
  /** Total audience stance movement toward this side (sum of positive deltas). */
  mindChangeToward: number;
}

export interface DebateScoreResult {
  /** Final weighted score per side key, 0..1. */
  scores: Record<string, number>;
  /** Normalized component shares per side key (for display/audit). */
  components: Record<string, WinnerFormulaWeights>;
  winnerKey: string | null;
  isDraw: boolean;
}

/** Normalize raw values into shares summing to 1; all-zero input → equal shares. */
function shares(values: number[]): number[] {
  const total = values.reduce((sum, v) => sum + v, 0);
  if (total <= 0) return values.map(() => 1 / values.length);
  return values.map((v) => v / total);
}

/**
 * The debate winner formula as specified: argument votes 0.5 + mind-change
 * 0.35 + evidence quality 0.15, each component normalized to a share across
 * sides before weighting. Works for 2 sides (1v1/team) and 3 (open debates,
 * where the result reads as "leading side" unless the draw threshold hits).
 */
export function computeDebateWinner(
  sides: DebateSideScoreInput[],
  weights: WinnerFormulaWeights = DEFAULT_WINNER_FORMULA,
): DebateScoreResult {
  if (sides.length === 0) return { scores: {}, components: {}, winnerKey: null, isDraw: true };
  // Argument votes can be negative: shift so the lowest side sits at 0 —
  // only the *gap* between sides carries information.
  const minScore = Math.min(0, ...sides.map((s) => s.argumentScore));
  const voteShares = shares(sides.map((s) => s.argumentScore - minScore));
  const mindShares = shares(sides.map((s) => Math.max(0, s.mindChangeToward)));
  const evidenceShares = shares(sides.map((s) => Math.max(0, s.evidenceQuality)));

  const scores: Record<string, number> = {};
  const components: Record<string, WinnerFormulaWeights> = {};
  sides.forEach((side, i) => {
    components[side.key] = {
      argument_votes: voteShares[i]!,
      mind_change: mindShares[i]!,
      evidence_quality: evidenceShares[i]!,
    };
    scores[side.key] =
      weights.argument_votes * voteShares[i]! +
      weights.mind_change * mindShares[i]! +
      weights.evidence_quality * evidenceShares[i]!;
  });

  const ranked = [...sides].sort((a, b) => (scores[b.key] ?? 0) - (scores[a.key] ?? 0));
  const top = ranked[0]!;
  const runnerUp = ranked[1];
  const gap = (scores[top.key] ?? 0) - (runnerUp ? (scores[runnerUp.key] ?? 0) : 0);
  const isDraw = runnerUp !== undefined && gap < WINNER_DRAW_THRESHOLD;
  return { scores, components, winnerKey: isDraw ? null : top.key, isDraw };
}

// ─── Elo (D-032) ─────────────────────────────────────────────────────────────

export const ELO_START = 1200;
/** K-factor while a debater has fewer than 30 rated debates. */
export const ELO_K_EARLY = 32;
/** K-factor from 30 rated debates on. */
export const ELO_K_ESTABLISHED = 16;
export const ELO_K_THRESHOLD = 30;

export function eloKFactor(debatesCount: number): number {
  return debatesCount < ELO_K_THRESHOLD ? ELO_K_EARLY : ELO_K_ESTABLISHED;
}

export interface EloResult {
  deltaA: number;
  deltaB: number;
  newA: number;
  newB: number;
  expectedA: number;
}

/**
 * Standard Elo update for one rated debate. `scoreA` is 1 (A wins), 0.5
 * (draw) or 0 (B wins). Ratings are rounded to integers; deltas are the
 * applied integer changes.
 */
export function eloUpdate(
  ratingA: number,
  ratingB: number,
  scoreA: 0 | 0.5 | 1,
  debatesCountA: number,
  debatesCountB: number,
): EloResult {
  const expectedA = 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
  const expectedB = 1 - expectedA;
  const scoreB = 1 - scoreA;
  const newA = Math.round(ratingA + eloKFactor(debatesCountA) * (scoreA - expectedA));
  const newB = Math.round(ratingB + eloKFactor(debatesCountB) * (scoreB - expectedB));
  return { deltaA: newA - ratingA, deltaB: newB - ratingB, newA, newB, expectedA };
}

// ─── Evidence quality heuristic (D-032) ─────────────────────────────────────

/** Per-kind link weights for the evidence-quality heuristic. */
export const EVIDENCE_KIND_WEIGHTS: Record<string, number> = {
  study: 1.0,
  data: 0.9,
  news: 0.7,
  other: 0.4,
  personal_experience: 0.3,
};

export interface EvidenceLinkInput {
  kind: string;
  domain?: string | null;
}

/**
 * Evidence quality of one argument, 0..1. Transparent heuristic (no LLM):
 * link-kind weights summed and halved (two solid sources ≈ full marks),
 * +0.1 when the links span ≥ 2 distinct domains.
 */
export function evidenceQualityForLinks(links: EvidenceLinkInput[]): number {
  if (links.length === 0) return 0;
  const weight = links.reduce(
    (sum, link) => sum + (EVIDENCE_KIND_WEIGHTS[link.kind] ?? EVIDENCE_KIND_WEIGHTS.other!),
    0,
  );
  const domains = new Set(links.map((l) => l.domain ?? "").filter(Boolean));
  const bonus = domains.size >= 2 ? 0.1 : 0;
  return Math.min(1, Math.max(0, weight / 2 + bonus));
}

// ─── Daily Pulse ET calendar (D-031) ─────────────────────────────────────────

export const ET_TIME_ZONE = "America/Toronto";

/** The ET calendar date (YYYY-MM-DD) containing `now`. */
export function etToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ET_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** The ET midnight that ends `dateStr` (YYYY-MM-DD), as a UTC instant. */
export function etMidnightAfter(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  const guess = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIME_ZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(guess);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wallAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return new Date(guess.getTime() - (wallAsUtc - guess.getTime()));
}
