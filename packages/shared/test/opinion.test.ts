import { describe, expect, it } from "vitest";
import {
  computeDebateWinner,
  eloUpdate,
  evidenceQualityForLinks,
  tallyIrv,
} from "../src/index.js";

describe("tallyIrv", () => {
  it("returns no winner for zero ballots", () => {
    const result = tallyIrv([], ["a", "b"]);
    expect(result.winner_option_id).toBeNull();
    expect(result.rounds).toEqual([]);
  });

  it("elects a first-round majority winner", () => {
    const ballots = [["a"], ["a"], ["a"], ["b"], ["b"]];
    const result = tallyIrv(ballots, ["a", "b"]);
    expect(result.winner_option_id).toBe("a");
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]?.tallies).toEqual({ a: 3, b: 2 });
  });

  it("transfers votes after elimination until a majority emerges", () => {
    // a: 4, b: 3, c: 2 — c eliminated, its 2 ballots move to b → b 5 vs a 4.
    const ballots = [
      ["a"], ["a"], ["a"], ["a"],
      ["b"], ["b"], ["b"],
      ["c", "b"], ["c", "b"],
    ];
    const result = tallyIrv(ballots, ["a", "b", "c"]);
    expect(result.winner_option_id).toBe("b");
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]?.eliminated_option_id).toBe("c");
    expect(result.rounds[1]?.tallies).toEqual({ a: 4, b: 5 });
  });

  it("handles exhausted ballots shrinking the denominator", () => {
    // c's ballots rank nobody else: after c is eliminated they exhaust, so
    // the majority threshold drops from 6 (of 11) to 5 (of 9)… a has 5.
    const ballots = [
      ["a"], ["a"], ["a"], ["a"], ["a"],
      ["b"], ["b"], ["b"], ["b"],
      ["c"], ["c"],
    ];
    const result = tallyIrv(ballots, ["a", "b", "c"]);
    expect(result.winner_option_id).toBe("a");
    expect(result.exhausted_ballots).toBe(2);
  });

  it("breaks last-place ties by earlier-round tallies", () => {
    // Round 1: a 3, b 2, c 2, d 1 → d out, its ballot goes to c (c 3).
    // Round 2: a 3, b 2, c 3 → b out (sole lowest). b's ballots → a.
    // Round 3: a 5, c 3 → a wins.
    const ballots = [
      ["a"], ["a"], ["a"],
      ["b", "a"], ["b", "a"],
      ["c"], ["c"],
      ["d", "c"],
    ];
    const result = tallyIrv(ballots, ["a", "b", "c", "d"]);
    expect(result.rounds[0]?.eliminated_option_id).toBe("d");
    expect(result.rounds[1]?.eliminated_option_id).toBe("b");
    expect(result.winner_option_id).toBe("a");
  });

  it("is deterministic on a perfect tie (lexicographically last id eliminated)", () => {
    const ballots = [["a"], ["b"]];
    const result = tallyIrv(ballots, ["a", "b"]);
    // 1–1 tie, no earlier rounds: "b" eliminated by the documented rule.
    expect(result.rounds[0]?.eliminated_option_id).toBe("b");
    expect(result.winner_option_id).toBe("a");
  });

  it("last candidate standing wins without a majority of continuing ballots", () => {
    const ballots = [["a", "b"], ["b"], ["c", "b"]];
    const result = tallyIrv(ballots, ["a", "b", "c"]);
    // a 1, b 1, c 1 → tie at lowest: id rule eliminates c; then a 1, b 2 → b majority.
    expect(result.winner_option_id).toBe("b");
  });

  it("all ballots exhausted mid-tabulation → no winner, no crash", () => {
    const ballots = [["a"], ["b"]];
    const result = tallyIrv(ballots, ["a", "b", "c"]);
    // c has 0 and is eliminated first (sole lowest), then the 1–1 tie rule applies.
    expect(result.rounds[0]?.eliminated_option_id).toBe("c");
    expect(result.winner_option_id).toBe("a");
  });
});

describe("computeDebateWinner", () => {
  it("weights argument votes 0.5 / mind-change 0.35 / evidence 0.15", () => {
    const result = computeDebateWinner([
      { key: "for", argumentScore: 10, evidenceQuality: 0.8, mindChangeToward: 3 },
      { key: "against", argumentScore: 0, evidenceQuality: 0.2, mindChangeToward: 1 },
    ]);
    // votes share 1/0, mind 0.75/0.25, evidence 0.8/0.2
    expect(result.scores.for).toBeCloseTo(0.5 * 1 + 0.35 * 0.75 + 0.15 * 0.8, 6);
    expect(result.scores.against).toBeCloseTo(0.5 * 0 + 0.35 * 0.25 + 0.15 * 0.2, 6);
    expect(result.winnerKey).toBe("for");
    expect(result.isDraw).toBe(false);
  });

  it("declares a draw inside the 0.02 threshold", () => {
    const result = computeDebateWinner([
      { key: "a", argumentScore: 5, evidenceQuality: 0.5, mindChangeToward: 2 },
      { key: "b", argumentScore: 5, evidenceQuality: 0.5, mindChangeToward: 2 },
    ]);
    expect(result.isDraw).toBe(true);
    expect(result.winnerKey).toBeNull();
  });

  it("shifts negative argument scores so only the gap matters", () => {
    const result = computeDebateWinner([
      { key: "a", argumentScore: -4, evidenceQuality: 0, mindChangeToward: 0 },
      { key: "b", argumentScore: -1, evidenceQuality: 0, mindChangeToward: 0 },
    ]);
    // shifted: a 0, b 3 → vote share a 0, b 1; other components equal shares.
    expect(result.components.a?.argument_votes).toBe(0);
    expect(result.components.b?.argument_votes).toBe(1);
    expect(result.winnerKey).toBe("b");
  });

  it("supports three sides (open debates)", () => {
    const result = computeDebateWinner([
      { key: "for", argumentScore: 9, evidenceQuality: 0.9, mindChangeToward: 4 },
      { key: "against", argumentScore: 3, evidenceQuality: 0.3, mindChangeToward: 1 },
      { key: "nuanced", argumentScore: 0, evidenceQuality: 0.1, mindChangeToward: 0 },
    ]);
    expect(result.winnerKey).toBe("for");
    const total = Object.values(result.scores).reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(1, 6);
  });
});

describe("eloUpdate", () => {
  it("equal ratings, decisive result: winner +16 / loser −16 at K=32", () => {
    const result = eloUpdate(1200, 1200, 1, 0, 0);
    expect(result.newA).toBe(1216);
    expect(result.newB).toBe(1184);
    expect(result.deltaA).toBe(16);
    expect(result.deltaB).toBe(-16);
  });

  it("draw between equals changes nothing", () => {
    const result = eloUpdate(1200, 1200, 0.5, 3, 9);
    expect(result.deltaA).toBe(0);
    expect(result.deltaB).toBe(0);
  });

  it("underdog win pays more than favourite win", () => {
    const upset = eloUpdate(1100, 1300, 1, 0, 0);
    const expected = eloUpdate(1300, 1100, 1, 0, 0);
    expect(upset.deltaA).toBeGreaterThan(expected.deltaA);
  });

  it("K drops to 16 at 30 rated debates", () => {
    const veteran = eloUpdate(1200, 1200, 1, 30, 30);
    expect(veteran.deltaA).toBe(8);
  });
});

describe("evidenceQualityForLinks", () => {
  it("no links → 0", () => {
    expect(evidenceQualityForLinks([])).toBe(0);
  });
  it("one study → 0.5", () => {
    expect(evidenceQualityForLinks([{ kind: "study", domain: "nature.com" }])).toBeCloseTo(0.5);
  });
  it("two studies on distinct domains → capped at 1 with the domain bonus", () => {
    const q = evidenceQualityForLinks([
      { kind: "study", domain: "a.org" },
      { kind: "study", domain: "b.org" },
    ]);
    expect(q).toBe(1);
  });
  it("personal experience weighs least", () => {
    expect(evidenceQualityForLinks([{ kind: "personal_experience", domain: "" }])).toBeCloseTo(0.15);
  });
});
