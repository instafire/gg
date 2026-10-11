/**
 * Phase 5A worker jobs: the scheduled-post publisher and the trending
 * computation, exercised against in-memory repos (the same pure-logic +
 * repo split as the opinion jobs).
 */
import { describe, expect, it } from "vitest";
import {
  parseMentions,
  publishDueScheduledPosts,
  type DuePost,
  type MentionTarget,
  type ScheduledRepo,
} from "../src/scheduled";
import {
  computeTrending,
  hashtagsOf,
  TRENDING_WINDOW_MS,
  type TrendingPayload,
  type TrendingRepo,
} from "../src/trending";

class FakeScheduledRepo implements ScheduledRepo {
  due: DuePost[] = [];
  claimed = new Set<string>();
  published: string[] = [];
  communityBumps: string[] = [];
  mentions: Array<{ postId: string; userId: string; position: number }> = [];
  notifications: Array<{ recipientId: string; actorId: string; postId: string }> = [];
  users: MentionTarget[] = [];

  async duePosts(): Promise<DuePost[]> {
    return this.due;
  }
  async markPublished(postId: string): Promise<boolean> {
    if (this.claimed.has(postId)) return false;
    this.claimed.add(postId);
    this.published.push(postId);
    return true;
  }
  async bumpCommunityPostCount(communityId: string): Promise<void> {
    this.communityBumps.push(communityId);
  }
  async usersByHandles(handles: string[]): Promise<MentionTarget[]> {
    return this.users.filter((u) => handles.includes(u.handle));
  }
  async insertMention(postId: string, userId: string, position: number): Promise<void> {
    this.mentions.push({ postId, userId, position });
  }
  async notifyMention(recipientId: string, actorId: string, post: DuePost): Promise<void> {
    this.notifications.push({ recipientId, actorId, postId: post.id });
  }
}

const AUTHOR = "11111111-1111-7111-8111-111111111111";
const PRIYA = "22222222-2222-7222-8222-222222222222";
const COMMUNITY = "33333333-3333-7333-8333-333333333333";

describe("scheduled publisher", () => {
  it("publishes due posts, bumps the community counter, records mentions + notifies once", async () => {
    const repo = new FakeScheduledRepo();
    repo.users = [
      { id: PRIYA, handle: "priya", status: "active", deletedAt: null },
    ];
    repo.due = [
      {
        id: "post-1",
        authorId: AUTHOR,
        communityId: COMMUNITY,
        parentId: null,
        rootId: "post-1",
        bodyMd: "hi @priya and @priya again",
      },
    ];
    const hookMentions: Array<{ postId: string; handle: string }> = [];
    const result = await publishDueScheduledPosts(repo, new Date(), 50, {
      onMention: async (post, target) => {
        hookMentions.push({ postId: post.id, handle: target.handle });
      },
    });
    expect(result.published).toBe(1);
    expect(repo.communityBumps).toEqual([COMMUNITY]);
    // Mention rows are per occurrence (2), the notification only once.
    expect(repo.mentions).toHaveLength(2);
    expect(repo.notifications).toEqual([
      { recipientId: PRIYA, actorId: AUTHOR, postId: "post-1" },
    ]);
    // The webhook hook fires once per notified mention (D-050).
    expect(hookMentions).toEqual([{ postId: "post-1", handle: "priya" }]);
  });

  it("skips posts another publisher instance already claimed", async () => {
    const repo = new FakeScheduledRepo();
    repo.claimed.add("post-2");
    repo.due = [
      {
        id: "post-2",
        authorId: AUTHOR,
        communityId: null,
        parentId: null,
        rootId: "post-2",
        bodyMd: "no mentions",
      },
    ];
    const result = await publishDueScheduledPosts(repo, new Date());
    expect(result.published).toBe(0);
    expect(repo.communityBumps).toEqual([]);
  });

  it("does not bump the community counter for replies", async () => {
    const repo = new FakeScheduledRepo();
    repo.due = [
      {
        id: "post-3",
        authorId: AUTHOR,
        communityId: COMMUNITY,
        parentId: "post-0",
        rootId: "post-0",
        bodyMd: "a reply",
      },
    ];
    await publishDueScheduledPosts(repo, new Date());
    expect(repo.communityBumps).toEqual([]);
  });

  it("parseMentions matches the API extraction (lowercased, with offsets)", () => {
    expect(parseMentions("hey @Priya_K and @aman")).toEqual([
      { handle: "priya_k", position: 4 },
      { handle: "aman", position: 17 },
    ]);
  });
});

class FakeTrendingRepo implements TrendingRepo {
  posts: Array<{ bodyMd: string | null }> = [];
  postVel: Array<{ id: string; velocity: number }> = [];
  communityVel: Array<{ id: string; velocity: number }> = [];
  debateVel: Array<{ id: string; velocity: number }> = [];
  snapshots: Array<{ start: Date; end: Date; payload: TrendingPayload }> = [];

  async windowPosts(): Promise<Array<{ bodyMd: string | null }>> {
    return this.posts;
  }
  async postVelocity(): Promise<Array<{ id: string; velocity: number }>> {
    return this.postVel;
  }
  async communityVelocity(): Promise<Array<{ id: string; velocity: number }>> {
    return this.communityVel;
  }
  async debateVelocity(): Promise<Array<{ id: string; velocity: number }>> {
    return this.debateVel;
  }
  async insertSnapshot(
    windowStart: Date,
    windowEnd: Date,
    payload: TrendingPayload,
  ): Promise<void> {
    this.snapshots.push({ start: windowStart, end: windowEnd, payload });
  }
}

describe("trending computation", () => {
  it("counts each hashtag once per post and ranks by count", async () => {
    const repo = new FakeTrendingRepo();
    repo.posts = [
      { bodyMd: "#ai #ai everywhere #debate" },
      { bodyMd: "more #AI talk" },
      { bodyMd: "no tags here" },
      { bodyMd: null },
    ];
    const now = new Date("2026-10-11T12:00:00Z");
    const result = await computeTrending(repo, now);
    expect(result.hashtags).toBe(2);
    const snapshot = repo.snapshots[0]!;
    expect(snapshot.end).toEqual(now);
    expect(snapshot.start).toEqual(new Date(now.getTime() - TRENDING_WINDOW_MS));
    expect(snapshot.payload.hashtags).toEqual([
      { tag: "ai", post_count: 2 },
      { tag: "debate", post_count: 1 },
    ]);
  });

  it("ranks velocity descending and drops zero-velocity rows", async () => {
    const repo = new FakeTrendingRepo();
    repo.postVel = [
      { id: "slow", velocity: 1 },
      { id: "hot", velocity: 9 },
      { id: "dead", velocity: 0 },
    ];
    repo.communityVel = [{ id: "c1", velocity: 3 }];
    repo.debateVel = [{ id: "d1", velocity: 0.5 }];
    await computeTrending(repo, new Date());
    const payload = repo.snapshots[0]!.payload;
    expect(payload.posts).toEqual([
      { id: "hot", velocity: 9 },
      { id: "slow", velocity: 1 },
    ]);
    expect(payload.communities).toEqual([{ id: "c1", velocity: 3 }]);
    expect(payload.debates).toEqual([{ id: "d1", velocity: 0.5 }]);
  });

  it("hashtagsOf dedupes case-insensitively", () => {
    expect(hashtagsOf("Love #Punjabi and #punjabi music #GG")).toEqual([
      "punjabi",
      "gg",
    ]);
    expect(hashtagsOf(null)).toEqual([]);
    expect(hashtagsOf("a #x too-short tag")).toEqual([]);
  });
});
