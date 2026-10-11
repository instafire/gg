import { describe, expect, it } from "vitest";
import { hotScore, voteDelta, voteWeight } from "../src/lib/vote-math";

describe("voteWeight (D-012)", () => {
  it("humans always weigh 1", () => {
    expect(voteWeight("human", 1.0)).toBe(1);
    expect(voteWeight("human", 0.5)).toBe(1);
    expect(voteWeight("human", 0)).toBe(1);
  });

  it("agents use the configured weight — 1.0 by owner decision", () => {
    expect(voteWeight("agent", 1.0)).toBe(1);
    expect(voteWeight("agent", 0.5)).toBe(0.5);
    expect(voteWeight("agent", 0)).toBe(0);
  });
});

describe("voteDelta", () => {
  it("cast up: +1 ballot, +weight score", () => {
    expect(voteDelta(0, 1, 1)).toEqual({
      upDelta: 1,
      downDelta: 0,
      scoreDelta: 1,
      changeKind: "cast",
    });
  });

  it("cast down: +1 down ballot, −weight score", () => {
    expect(voteDelta(0, -1, 1)).toEqual({
      upDelta: 0,
      downDelta: 1,
      scoreDelta: -1,
      changeKind: "cast",
    });
  });

  it("agent cast at weight 1.0 moves the score exactly like a human (D-012)", () => {
    expect(voteDelta(0, 1, voteWeight("agent", 1.0))?.scoreDelta).toBe(1);
  });

  it("agent cast at a fractional weight moves only the score, not ballot counts", () => {
    const delta = voteDelta(0, 1, 0.5);
    expect(delta?.upDelta).toBe(1);
    expect(delta?.scoreDelta).toBe(0.5);
  });

  it("flip up→down swings the score by 2×weight", () => {
    expect(voteDelta(1, -1, 1)).toEqual({
      upDelta: -1,
      downDelta: 1,
      scoreDelta: -2,
      changeKind: "flip",
    });
  });

  it("retract removes the ballot and its weighted score", () => {
    expect(voteDelta(1, 0, 1)).toEqual({
      upDelta: -1,
      downDelta: 0,
      scoreDelta: -1,
      changeKind: "retract",
    });
    expect(voteDelta(-1, 0, 1)).toEqual({
      upDelta: 0,
      downDelta: -1,
      scoreDelta: 1,
      changeKind: "retract",
    });
  });

  it("repeating the same value is a no-op (idempotent set semantics)", () => {
    expect(voteDelta(1, 1, 1)).toBeNull();
    expect(voteDelta(-1, -1, 1)).toBeNull();
    expect(voteDelta(0, 0, 1)).toBeNull();
  });
});

describe("hotScore (ARCHITECTURE §7.2)", () => {
  const t0 = new Date("2026-10-10T12:00:00Z");

  it("zero score is pure recency", () => {
    expect(hotScore(0, t0)).toBeCloseTo((t0.getTime() / 1000 - 1_134_028_003) / 45000, 6);
  });

  it("higher score ranks higher at the same age; newer ranks higher at the same score", () => {
    expect(hotScore(10, t0)).toBeGreaterThan(hotScore(1, t0));
    expect(hotScore(-10, t0)).toBeLessThan(hotScore(-1, t0));
    const later = new Date(t0.getTime() + 45_000 * 1000);
    expect(hotScore(1, later)).toBeGreaterThan(hotScore(1, t0));
  });
});
