import { describe, expect, it } from "vitest";
import {
  closeExpiredPolls,
  eloApplications,
  expireDebateTurns,
  publishDailyPulse,
  winnerComputation,
  type OpinionRepo,
  type RoundSweepRow,
} from "../src/opinion.js";

/** In-memory OpinionRepo fake: records writes, serves scripted reads. */
function fakeRepo(overrides: Partial<OpinionRepo> = {}): OpinionRepo & {
  createdPulses: unknown[];
  closedPolls: Array<{ pollId: string; cache: unknown }>;
  closedDebates: unknown[];
  missed: string[];
  activated: string[];
} {
  const state = {
    createdPulses: [] as unknown[],
    closedPolls: [] as Array<{ pollId: string; cache: unknown }>,
    closedDebates: [] as unknown[],
    missed: [] as string[],
    activated: [] as string[],
  };
  const base: OpinionRepo = {
    async pulseAuthor() {
      return { id: "author-1", authorType: "agent" };
    },
    async pulseForDate() {
      return null;
    },
    async bankQuestions() {
      return [
        { id: "q1", question: "Pineapple on pizza?", type: "single", options: ["Yes", "No"], scheduledDate: null },
      ];
    },
    async createPulsePost(input) {
      state.createdPulses.push(input);
    },
    async markQuestionUsed() {},
    async expiredOpenPolls() {
      return [];
    },
    async pollOptionIds() {
      return ["a", "b", "c"];
    },
    async liveRankings() {
      return [];
    },
    async closePoll(pollId, cache) {
      state.closedPolls.push({ pollId, cache });
    },
    async overdueRounds() {
      return [];
    },
    async debateById() {
      return null;
    },
    async roundsOf() {
      return [];
    },
    async markRoundMissed(roundId) {
      state.missed.push(roundId);
    },
    async activateRound(roundId) {
      state.activated.push(roundId);
    },
    async skipPendingRounds() {},
    async notifyTurn() {},
    async sidesOf() {
      return [
        { id: "side-for", key: "for", position: 0 },
        { id: "side-against", key: "against", position: 1 },
      ];
    },
    async participantsOf() {
      return [
        { userId: "u-for", sideId: "side-for", role: "debater" },
        { userId: "u-against", sideId: "side-against", role: "debater" },
      ];
    },
    async argumentsOf() {
      return [];
    },
    async stancePairs() {
      return [];
    },
    async ratingsOf() {
      return new Map();
    },
    async closeDebate(input) {
      state.closedDebates.push(input);
    },
    async archiveClosedBefore() {
      return 0;
    },
  };
  return Object.assign(base, overrides, state) as never;
}

const round = (partial: Partial<RoundSweepRow>): RoundSweepRow => ({
  id: "r1",
  debateId: "d1",
  roundNo: 1,
  sideId: "side-for",
  turnUserId: "u-for",
  status: "active",
  deadlineAt: new Date(Date.now() - 1000),
  ...partial,
});

describe("publishDailyPulse", () => {
  it("publishes once and is idempotent per day", async () => {
    let published = false;
    const repo = fakeRepo({
      async pulseForDate() {
        return published ? { id: "p1" } : null;
      },
      async createPulsePost(input) {
        published = true;
        (repo.createdPulses as unknown[]).push(input);
      },
    });
    const first = await publishDailyPulse(repo, "gg_scout", new Date("2026-10-11T12:00:00Z"));
    const second = await publishDailyPulse(repo, "gg_scout", new Date("2026-10-11T13:00:00Z"));
    expect(first.published).toBe(true);
    expect(second.published).toBe(false);
    expect(repo.createdPulses).toHaveLength(1);
  });

  it("prefers the question scheduled for today", async () => {
    const repo = fakeRepo({
      async bankQuestions() {
        return [
          { id: "q-queue", question: "Queued?", type: "single", options: ["A", "B"], scheduledDate: null },
          { id: "q-today", question: "Scheduled?", type: "single", options: ["A", "B"], scheduledDate: "2026-10-11" },
        ];
      },
    });
    // 2026-10-11 12:00Z is 2026-10-11 in ET.
    await publishDailyPulse(repo, "gg_scout", new Date("2026-10-11T12:00:00Z"));
    const created = repo.createdPulses[0] as { question: string };
    expect(created.question).toBe("Scheduled?");
  });

  it("skips cleanly when the bank is empty", async () => {
    const repo = fakeRepo({
      async bankQuestions() {
        return [];
      },
    });
    const result = await publishDailyPulse(repo, "gg_scout", new Date());
    expect(result.published).toBe(false);
    expect(result.reason).toBe("question bank empty");
  });
});

describe("closeExpiredPolls", () => {
  it("caches the IRV tabulation for ranked polls", async () => {
    const repo = fakeRepo({
      async expiredOpenPolls() {
        return [{ id: "poll-1", type: "ranked" }];
      },
      async liveRankings() {
        return [["a"], ["a"], ["b"], ["c", "b"], ["c", "b"]];
      },
    });
    const result = await closeExpiredPolls(repo, new Date());
    expect(result.closed).toBe(1);
    const cache = repo.closedPolls[0]?.cache as { irv: { winner_option_id: string } };
    // a:2, b:1(+2 via c) — c eliminated first (2 first-prefs vs b 1? no:
    // first prefs a2 b1 c2; b is lowest → b's ballot exhausts; then a2 c2 tie
    // → id rule eliminates c → a wins.
    expect(cache.irv.winner_option_id).toBe("a");
  });
});

describe("expireDebateTurns", () => {
  const debate = {
    id: "d1",
    status: "awaiting_turn",
    format: "structured_1v1",
    judgeId: null,
    liveTurnSeconds: null,
    turnDeadlineHours: 24,
    winnerFormula: null,
  };

  it("a single missed turn advances to the next round", async () => {
    const repo = fakeRepo({
      async overdueRounds() {
        return [round({ id: "r1", roundNo: 1 })];
      },
      async debateById() {
        return debate;
      },
      async roundsOf() {
        return [
          round({ id: "r1", roundNo: 1, status: "missed" }),
          round({ id: "r2", roundNo: 2, turnUserId: "u-against", sideId: "side-against", status: "pending" }),
        ];
      },
    });
    const result = await expireDebateTurns(repo, new Date());
    expect(result.expired).toBe(1);
    expect(repo.activated).toEqual(["r2"]);
    expect(repo.closedDebates).toHaveLength(0);
  });

  it("missing the final turn forfeits the debate with Elo applied", async () => {
    const repo = fakeRepo({
      async overdueRounds() {
        return [round({ id: "r2", roundNo: 2, turnUserId: "u-against", sideId: "side-against" })];
      },
      async debateById() {
        return debate;
      },
      async roundsOf() {
        return [
          round({ id: "r1", roundNo: 1, status: "submitted" }),
          round({ id: "r2", roundNo: 2, turnUserId: "u-against", sideId: "side-against", status: "missed" }),
        ];
      },
    });
    await expireDebateTurns(repo, new Date());
    expect(repo.closedDebates).toHaveLength(1);
    const closed = repo.closedDebates[0] as {
      winnerSideId: string;
      elo: Array<{ userId: string; delta: number; outcome: string }>;
    };
    expect(closed.winnerSideId).toBe("side-for");
    const winner = closed.elo.find((e) => e.userId === "u-for");
    const loser = closed.elo.find((e) => e.userId === "u-against");
    expect(winner?.outcome).toBe("win");
    expect(winner?.delta).toBe(16);
    expect(loser?.delta).toBe(-16);
  });

  it("two consecutive misses forfeit even mid-debate", async () => {
    const repo = fakeRepo({
      async overdueRounds() {
        return [round({ id: "r3", roundNo: 3 })];
      },
      async debateById() {
        return debate;
      },
      async roundsOf() {
        return [
          round({ id: "r1", roundNo: 1, status: "missed" }),
          round({ id: "r2", roundNo: 2, turnUserId: "u-against", sideId: "side-against", status: "submitted" }),
          round({ id: "r3", roundNo: 3, status: "missed" }),
          round({ id: "r4", roundNo: 4, turnUserId: "u-against", sideId: "side-against", status: "pending" }),
        ];
      },
    });
    await expireDebateTurns(repo, new Date());
    expect(repo.closedDebates).toHaveLength(1);
  });
});

describe("eloApplications / winnerComputation", () => {
  it("winnerComputation picks the side dominating all components", () => {
    const result = winnerComputation(
      [
        { id: "side-for", key: "for", position: 0 },
        { id: "side-against", key: "against", position: 1 },
      ],
      [
        { sideId: "side-for", score: 12, evidenceQuality: 0.9 },
        { sideId: "side-against", score: 1, evidenceQuality: 0.1 },
      ],
      new Map([["for", 4], ["against", 0]]),
    );
    expect(result.winnerKey).toBe("for");
  });

  it("eloApplications is empty for non-1v1 participant shapes", () => {
    const result = eloApplications(
      [{ userId: "solo", sideId: "side-for", role: "debater" }],
      [{ id: "side-for", key: "for", position: 0 }],
      new Map(),
      "for",
      false,
    );
    expect(result.elo).toEqual([]);
  });
});
