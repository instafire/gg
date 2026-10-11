import { describe, expect, it } from "vitest";
import {
  COMMUNITY_POST_CHAR_LIMIT,
  DEFAULT_AGENT_VOTE_WEIGHT,
  MIN_AGE,
  POST_CHAR_LIMIT,
  TAKE_CHAR_LIMIT,
  pollVoteCreateSchema,
  postCreateSchema,
  userPublicDTOSchema,
} from "../src/index";

const author = {
  id: "0192f8b4-7c1e-7abc-9def-0123456789ab",
  handle: "aman",
  displayName: "Aman",
  avatarUrl: null,
  bio: null,
  authorType: "human" as const,
  trustTier: "T1" as const,
  isVerified: false,
  followerCount: 0,
  followingCount: 0,
  createdAt: "2026-10-10T12:00:00.000Z",
};

describe("constants", () => {
  it("match the spec and recorded decisions", () => {
    expect(POST_CHAR_LIMIT).toBe(500);
    expect(TAKE_CHAR_LIMIT).toBe(5_000);
    expect(COMMUNITY_POST_CHAR_LIMIT).toBe(40_000);
    expect(MIN_AGE).toBe(13); // D-011
    expect(DEFAULT_AGENT_VOTE_WEIGHT).toBe(1.0); // D-012
  });
});

describe("userPublicDTOSchema", () => {
  it("accepts a valid public user", () => {
    expect(userPublicDTOSchema.parse(author)).toMatchObject({ handle: "aman" });
  });

  it("rejects an unknown trust tier", () => {
    const result = userPublicDTOSchema.safeParse({ ...author, trustTier: "T9" });
    expect(result.success).toBe(false);
  });
});

describe("postCreateSchema", () => {
  it("applies defaults for a minimal text post", () => {
    const post = postCreateSchema.parse({ type: "TEXT", body: "hello gg" });
    expect(post.visibility).toBe("public");
    expect(post.mediaIds).toEqual([]);
    expect(post.isNsfw).toBe(false);
  });

  it("rejects a body beyond the community ceiling", () => {
    const result = postCreateSchema.safeParse({
      type: "TEXT",
      body: "x".repeat(COMMUNITY_POST_CHAR_LIMIT + 1),
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than 10 media attachments", () => {
    const result = postCreateSchema.safeParse({
      type: "CAROUSEL",
      mediaIds: Array.from({ length: 11 }, () => author.id),
    });
    expect(result.success).toBe(false);
  });
});

describe("pollVoteCreateSchema", () => {
  it("accepts a stance within -2..2", () => {
    const vote = pollVoteCreateSchema.parse({
      pollId: author.id,
      optionIds: [author.id],
      stance: 2,
    });
    expect(vote.stance).toBe(2);
  });

  it("rejects an out-of-range stance and an empty selection", () => {
    expect(
      pollVoteCreateSchema.safeParse({ pollId: author.id, optionIds: [author.id], stance: 3 })
        .success,
    ).toBe(false);
    expect(pollVoteCreateSchema.safeParse({ pollId: author.id, optionIds: [] }).success).toBe(
      false,
    );
  });
});
