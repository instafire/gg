import { describe, expect, it, vi } from "vitest";
import { GGClient } from "../src/index";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(fetchImpl: FetchFn): GGClient {
  return new GGClient({
    baseUrl: "http://localhost:4000",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

const pollWire = {
  id: "poll-1",
  post_id: "post-1",
  type: "single",
  question: "Best framework?",
  options: [
    { id: "o1", position: 0, text: "React", media: null, human_votes: 7, agent_votes: 1, share: 0.7 },
    { id: "o2", position: 1, text: "Vue", media: null, human_votes: 3, agent_votes: 0, share: 0.3 },
  ],
  result_mode: "live",
  results_visible: true,
  is_anonymous: false,
  is_daily_pulse: false,
  min_trust_tier: "T1",
  total_votes: 10,
  agent_total_votes: 1,
  closes_at: null,
  is_closed: false,
  voided: false,
  viewer_ballot: null,
};

const authorWire = {
  id: "u-1",
  handle: "aman",
  display_name: "Aman",
  avatar_url: null,
  author_type: "human",
  trust_tier: "T1",
  is_verified_agent: false,
};

const debateWire = {
  id: "deb-1",
  short_code: "abc123",
  post_id: "post-9",
  proposition: "Tabs beat spaces",
  format: "open",
  status: "open",
  host: authorWire,
  judge: null,
  community: null,
  source_article_url: null,
  sides: [
    { id: "s1", key: "for", label: "For", argument_count: 2, human_argument_votes: 5, agent_argument_votes: 1 },
    { id: "s2", key: "against", label: "Against", argument_count: 1, human_argument_votes: 2, agent_argument_votes: 0 },
    { id: "s3", key: "nuanced", label: "Nuanced", argument_count: 0, human_argument_votes: 0, agent_argument_votes: 0 },
  ],
  participants: [{ user: authorWire, side_key: "for", role: "host", elo_at_start: null }],
  rounds: [],
  current_round: null,
  per_turn_char_limit: 2000,
  turn_deadline_hours: 24,
  winner_side_key: null,
  is_draw: false,
  winner_formula: { argument_votes: 0.5, mind_change: 0.35, evidence_quality: 0.15 },
  mind_change: { audience_pre_count: 4, audience_post_count: 3, mind_changed_count: 1, mind_change_rate: 0.33 },
  scheduled_start_at: null,
  closed_at: null,
  created_at: "2026-10-11T00:00:00.000Z",
};

describe("GGClient polls (Phase 3)", () => {
  it("createPoll posts the snake_case body and normalizes the wire", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn<FetchFn>(async (url, init) => {
      seen.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return jsonResponse(pollWire, 201);
    });
    const client = makeClient(fetchImpl);
    const poll = await client.createPoll({
      question: "Best framework?",
      options: [{ text: "React" }, { text: "Vue" }],
      resultMode: "after_vote",
    });
    expect(seen[0]?.url).toContain("/api/v1/polls");
    expect(seen[0]?.body).toMatchObject({ result_mode: "after_vote", question: "Best framework?" });
    expect(poll.options[0]?.humanVotes).toBe(7);
    expect(poll.options[0]?.share).toBe(0.7);
    expect(poll.totalVotes).toBe(10);
    expect(poll.agentTotalVotes).toBe(1);
  });

  it("votePoll + getPollResults normalize IRV rounds and breakdowns", async () => {
    const resultsWire = {
      poll_id: "poll-1",
      options: pollWire.options,
      total_votes: 10,
      agent_total_votes: 1,
      winner_option_id: "o1",
      irv_rounds: [{ round: 1, tallies: { o1: 7, o2: 3 }, eliminated_option_id: null }],
      breakdowns: { by_trust_tier: { T1: 8, T2: 2 }, by_age_bracket: {} },
      viewer_ballot: { option_id: "o1", option_ids: [], ranking: null, slider_value: null },
      stance_distribution: null,
    };
    const fetchImpl = vi.fn<FetchFn>(async () => jsonResponse(resultsWire));
    const client = makeClient(fetchImpl);
    const results = await client.votePoll("poll-1", { optionId: "o1" });
    expect(results.winnerOptionId).toBe("o1");
    expect(results.irvRounds[0]?.tallies.o1).toBe(7);
    expect(results.breakdowns.byTrustTier.T1).toBe(8);
    expect(results.viewerBallot?.optionId).toBe("o1");
  });

  it("getDailyPulse hits the pulse endpoint", async () => {
    const fetchImpl = vi.fn<FetchFn>(async (url) => {
      expect(url).toContain("/api/v1/polls/daily-pulse");
      return jsonResponse({ ...pollWire, is_daily_pulse: true });
    });
    const poll = await makeClient(fetchImpl).getDailyPulse();
    expect(poll.isDailyPulse).toBe(true);
  });

  it("normalizePost embeds poll + debate", async () => {
    const postWire = {
      id: "post-1",
      short_code: "xyz",
      type: "POLL",
      author: authorWire,
      author_type: "human",
      parent_id: null,
      root_id: "post-1",
      depth: 0,
      community: null,
      title: "Best framework?",
      body_md: "",
      body_html: "",
      is_long_form: false,
      link_card: null,
      media: [],
      flair: null,
      visibility: "public",
      reply_policy: "everyone",
      is_nsfw: false,
      is_spoiler: false,
      contains_ai_media: false,
      is_pinned: false,
      is_locked: false,
      up_count: 0,
      down_count: 0,
      score: 0,
      reply_count: 0,
      repost_count: 0,
      quote_count: 0,
      view_count: 0,
      save_count: 0,
      reaction_counts: {},
      vote_breakdown: null,
      poll: pollWire,
      debate: debateWire,
      edited_at: null,
      deleted_at: null,
      removed: false,
      created_at: "2026-10-11T00:00:00.000Z",
      viewer_state: { vote: null, bookmarked: false, reactions: [] },
    };
    const fetchImpl = vi.fn<FetchFn>(async () => jsonResponse(postWire));
    const post = await makeClient(fetchImpl).getPost("post-1");
    expect(post.poll?.question).toBe("Best framework?");
    expect(post.debate?.proposition).toBe("Tabs beat spaces");
    expect(post.debate?.winnerFormula?.mindChange).toBe(0.35);
  });
});

describe("GGClient debates (Phase 3)", () => {
  it("createDebateFromArticle + stance vote + state normalize", async () => {
    const stateWire = {
      debate_id: "deb-1",
      status: "open",
      sides: debateWire.sides,
      stance_distribution: { pre: { "2": 3, "-1": 1 }, post: {} },
      mind_changed_count: 0,
      mind_change_rate: 0,
      current_round: null,
      turn_deadline_at: null,
      viewer_stance: { pre: 2, post: null },
    };
    const calls: string[] = [];
    const fetchImpl = vi.fn<FetchFn>(async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("from-article")) return jsonResponse(debateWire, 201);
      return jsonResponse(stateWire);
    });
    const client = makeClient(fetchImpl);
    const debate = await client.createDebateFromArticle({
      articleUrl: "https://genznewz.com/story/1",
      proposition: "This policy will work",
    });
    expect(debate.format).toBe("open");
    expect(debate.sides).toHaveLength(3);
    const state = await client.castStanceVote("deb-1", { phase: "pre", stanceValue: 2 });
    expect(state.stanceDistribution.pre["2"]).toBe(3);
    expect(state.viewerStance?.pre).toBe(2);
    expect(calls[1]).toContain("/stance-votes");
  });

  it("listArguments normalizes evidence + steelman flags", async () => {
    const argumentWire = {
      id: "arg-1",
      debate_id: "deb-1",
      side_key: "for",
      author: authorWire,
      author_type: "human",
      round_no: null,
      parent_argument_id: null,
      body_md: "Studies show…",
      body_html: "<p>Studies show…</p>",
      is_steelman: false,
      steelman_confirmed: false,
      evidence: [
        { id: "e1", url: "https://example.org/study", kind: "study", quote: null, domain: "example.org", preview: null },
      ],
      fallacy_flags: [{ fallacy: "Ad hominem", confirmed_by_mod: false }],
      up_count: 4,
      down_count: 1,
      score: 3,
      vote_breakdown: { human: { up: 3, down: 1 }, agent: { up: 1, down: 0 } },
      evidence_quality: 0.5,
      created_at: "2026-10-11T00:00:00.000Z",
      viewer_state: { vote: "up" },
    };
    const fetchImpl = vi.fn<FetchFn>(async () =>
      jsonResponse({ data: [argumentWire], page: { next_cursor: null } }),
    );
    const page = await makeClient(fetchImpl).listArguments("deb-1");
    const argument = page.items[0]!;
    expect(argument.evidence[0]?.kind).toBe("study");
    expect(argument.evidenceQuality).toBe(0.5);
    expect(argument.viewerVote).toBe("up");
    expect(argument.voteBreakdown?.humanUp).toBe(3);
  });

  it("createNote + rateNote round-trip", async () => {
    const noteWire = {
      id: "note-1",
      post_id: "post-1",
      author: authorWire,
      body: "This claim is missing context.",
      sources: ["https://example.org/fact"],
      status: "pending",
      created_at: "2026-10-11T00:00:00.000Z",
    };
    const calls: string[] = [];
    const fetchImpl = vi.fn<FetchFn>(async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/ratings")) return new Response(null, { status: 204 });
      return jsonResponse(noteWire, 201);
    });
    const client = makeClient(fetchImpl);
    const note = await client.createNote("post-1", { body: noteWire.body, sources: noteWire.sources });
    expect(note.status).toBe("pending");
    await client.rateNote("note-1", "helpful");
    expect(calls[1]).toContain("/api/v1/notes/note-1/ratings");
  });

  it("profile normalize carries debate rating + record", async () => {
    const profileWire = {
      user_id: "u-1",
      handle: "aman",
      display_name: "Aman",
      bio: null,
      avatar_url: null,
      banner_url: null,
      website_url: null,
      location: null,
      links: [],
      author_type: "human",
      trust_tier: "T1",
      is_private: false,
      follower_count: 3,
      following_count: 2,
      pinned_post_id: null,
      debate_rating: 1248,
      debate_record: { wins: 3, losses: 1, draws: 0 },
      badges: [],
    };
    const fetchImpl = vi.fn<FetchFn>(async () => jsonResponse(profileWire));
    const profile = await makeClient(fetchImpl).getUserByHandle("aman");
    expect(profile.debateRating).toBe(1248);
    expect(profile.debateRecord).toEqual({ wins: 3, losses: 1, draws: 0 });
  });
});
