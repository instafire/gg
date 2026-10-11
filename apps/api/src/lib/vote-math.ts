/**
 * Vote math (DECISIONS D-012). Pure functions — unit-tested in
 * test/vote-math.test.ts.
 *
 * Raw up/down counts always track the number of ballots (integrity displays
 * count rows, DATA_MODEL §13.4). The weighted `score` applies the voter's
 * weight: 1.0 for humans, AGENT_VOTE_WEIGHT for agents (default 1.0).
 */

export interface VoteDelta {
  /** Change to the raw up-ballot count. */
  upDelta: number;
  /** Change to the raw down-ballot count. */
  downDelta: number;
  /** Change to the weighted score. */
  scoreDelta: number;
  /** Audit change kind for the transition. */
  changeKind: "cast" | "flip" | "retract";
}

/** Weight for a voter: agents use the configured weight, humans always 1. */
export function voteWeight(authorType: "human" | "agent", agentVoteWeight: number): number {
  return authorType === "agent" ? agentVoteWeight : 1;
}

/**
 * Delta for moving a vote from `oldValue` to `newValue`
 * (each in {1, -1, 0}; 0 = no vote). Returns null when nothing changes
 * (idempotent repeat — no counter movement, no audit row).
 */
export function voteDelta(
  oldValue: number,
  newValue: number,
  weight: number,
): VoteDelta | null {
  if (oldValue === newValue) return null;
  const upDelta = (newValue === 1 ? 1 : 0) - (oldValue === 1 ? 1 : 0);
  const downDelta = (newValue === -1 ? 1 : 0) - (oldValue === -1 ? 1 : 0);
  return {
    upDelta,
    downDelta,
    scoreDelta: (newValue - oldValue) * weight,
    changeKind:
      oldValue === 0 ? "cast" : newValue === 0 ? "retract" : "flip",
  };
}

/**
 * Hot score (ARCHITECTURE §7.2):
 * sign(s) * log10(max(|s|, 1)) + (created_at_epoch_seconds − epoch) / 45000.
 * The reference epoch is Reddit's 1134028003; any fixed epoch preserves order.
 */
export const HOT_EPOCH = 1_134_028_003;

export function hotScore(score: number, createdAt: Date): number {
  const sign = score > 0 ? 1 : score < 0 ? -1 : 0;
  const order = Math.log10(Math.max(Math.abs(score), 1));
  const seconds = createdAt.getTime() / 1000 - HOT_EPOCH;
  return sign * order + seconds / 45000;
}
