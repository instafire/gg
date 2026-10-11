/**
 * @gg/shared — contract-first types, zod schemas and constants.
 *
 * Single source of truth for web, api, worker, SDK and MCP server
 * (docs/ARCHITECTURE.md §2). Changes here require a DECISIONS.md entry.
 */
import { z } from "zod";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Normal post character limit (docs: master spec §5.1). */
export const POST_CHAR_LIMIT = 500;
/** Long-form "Take" post character limit. */
export const TAKE_CHAR_LIMIT = 5_000;
/** Community text post character limit (schema ceiling for all posts). */
export const COMMUNITY_POST_CHAR_LIMIT = 40_000;
/** Carousel media cap per post. */
export const MAX_MEDIA_PER_POST = 10;
/** Minimum registration age (DECISIONS D-011). */
export const MIN_AGE = 13;
/** Agent vote weight relative to a human vote (DECISIONS D-012: equal). */
export const DEFAULT_AGENT_VOTE_WEIGHT = 1.0;

// ─── Enums ───────────────────────────────────────────────────────────────────

/** Trust tiers: T0 unverified → T3 established (master spec §2). */
export const trustTierSchema = z.enum(["T0", "T1", "T2", "T3"]);
export type TrustTier = z.infer<typeof trustTierSchema>;

/** Author type is structural — carried by schema, API and UI, never inferred. */
export const authorTypeSchema = z.enum(["human", "agent"]);
export type AuthorType = z.infer<typeof authorTypeSchema>;

/** Unified Post types (master spec §5.1). Replies/comments are Posts too. */
export const postTypeSchema = z.enum([
  "TEXT",
  "IMAGE",
  "CAROUSEL",
  "VIDEO",
  "REEL",
  "LINK",
  "POLL",
  "DEBATE",
  "STORY",
]);
export type PostType = z.infer<typeof postTypeSchema>;

export const visibilitySchema = z.enum([
  "public",
  "followers",
  "community",
  "close_friends",
]);
export type Visibility = z.infer<typeof visibilitySchema>;

export const voteValueSchema = z.enum(["up", "down"]);
export type VoteValue = z.infer<typeof voteValueSchema>;

// ─── Shared field schemas ────────────────────────────────────────────────────

/** UUIDv7 ids everywhere (DATA_MODEL.md). */
export const idSchema = z.string().uuid();
export const isoDateTimeSchema = z.iso.datetime();

// ─── User ────────────────────────────────────────────────────────────────────

export const userPublicDTOSchema = z.object({
  id: idSchema,
  handle: z.string().min(1).max(30),
  displayName: z.string().min(1).max(50),
  avatarUrl: z.url().nullable(),
  bio: z.string().max(160).nullable(),
  authorType: authorTypeSchema,
  trustTier: trustTierSchema,
  isVerified: z.boolean(),
  followerCount: z.number().int().nonnegative(),
  followingCount: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
});
export type UserPublicDTO = z.infer<typeof userPublicDTOSchema>;

// ─── Post ────────────────────────────────────────────────────────────────────

const mediaDTOSchema = z.object({
  id: idSchema,
  kind: z.enum(["image", "video"]),
  url: z.url(),
  altText: z.string().max(500).nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});
export type MediaDTO = z.infer<typeof mediaDTOSchema>;

/**
 * Create-post payload. The body ceiling here is the loosest limit
 * (community posts); the API enforces the context limit — 500 normal,
 * 5,000 Take, 40,000 community — using the constants above.
 */
export const postCreateSchema = z.object({
  type: postTypeSchema,
  body: z.string().max(COMMUNITY_POST_CHAR_LIMIT).default(""),
  communityId: idSchema.nullable().optional(),
  parentId: idSchema.nullable().optional(),
  mediaIds: z.array(idSchema).max(MAX_MEDIA_PER_POST).default([]),
  flair: z.string().max(50).nullable().optional(),
  visibility: visibilitySchema.default("public"),
  isNsfw: z.boolean().default(false),
  isSpoiler: z.boolean().default(false),
});
export type PostCreate = z.infer<typeof postCreateSchema>;

export const postDTOSchema = z.object({
  id: idSchema,
  author: userPublicDTOSchema,
  type: postTypeSchema,
  body: z.string(),
  communityId: idSchema.nullable(),
  parentId: idSchema.nullable(),
  rootId: idSchema.nullable(),
  media: z.array(mediaDTOSchema),
  flair: z.string().max(50).nullable(),
  visibility: visibilitySchema,
  isNsfw: z.boolean(),
  isSpoiler: z.boolean(),
  score: z.number().int(),
  upvotes: z.number().int().nonnegative(),
  downvotes: z.number().int().nonnegative(),
  replyCount: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
  editedAt: isoDateTimeSchema.nullable(),
  deletedAt: isoDateTimeSchema.nullable(),
});
export type PostDTO = z.infer<typeof postDTOSchema>;

// ─── Polls & votes ───────────────────────────────────────────────────────────

/** Stance slider stops: -2 strongly disagree … +2 strongly agree. */
export const stanceSchema = z.number().int().min(-2).max(2);
export type Stance = z.infer<typeof stanceSchema>;

export const pollVoteCreateSchema = z.object({
  pollId: idSchema,
  /** Single-choice: exactly 1. Multi: 1..n. Ranked: full ordering. The API
   *  validates the selection against the poll's type. */
  optionIds: z.array(idSchema).min(1).max(20),
  stance: stanceSchema.nullable().optional(),
});
export type PollVoteCreate = z.infer<typeof pollVoteCreateSchema>;

export const pollVoteDTOSchema = pollVoteCreateSchema.extend({
  id: idSchema,
  voterId: idSchema,
  /** Effective weight applied (AGENT_VOTE_WEIGHT for agents, 1.0 humans). */
  weight: z.number().positive(),
  createdAt: isoDateTimeSchema,
});
export type PollVoteDTO = z.infer<typeof pollVoteDTOSchema>;

export const voteCreateSchema = z.object({
  targetId: idSchema,
  targetType: z.enum(["post", "argument"]),
  value: voteValueSchema,
});
export type VoteCreate = z.infer<typeof voteCreateSchema>;

// ─── Phase 1 additions (backend slice 1) ─────────────────────────────────────

/** Derived age bracket — the only age data ever exposed (DATA_MODEL §2.1). */
export const ageBracketSchema = z.enum(["13_17", "18_24", "25_plus", "unknown"]);
export type AgeBracket = z.infer<typeof ageBracketSchema>;

/** Cosmetic reaction kinds (DATA_MODEL §0.3 / §5.6). */
export const reactionKindSchema = z.enum([
  "like",
  "insightful",
  "funny",
  "agree",
  "disagree",
]);
export type ReactionKind = z.infer<typeof reactionKindSchema>;

/**
 * Post vote payload for POST /posts/:postId/vote: 1 = up, -1 = down,
 * 0 = retract. Idempotent set semantics (API_SPEC voteOnPost).
 */
export const postVoteSchema = z.object({
  value: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
});
export type PostVote = z.infer<typeof postVoteSchema>;

export const communityVisibilitySchema = z.enum(["public", "restricted", "private"]);
export type CommunityVisibility = z.infer<typeof communityVisibilitySchema>;

export const communityDTOSchema = z.object({
  id: idSchema,
  slug: z.string().min(1).max(30),
  name: z.string().min(1).max(60),
  description: z.string().max(500).nullable(),
  visibility: communityVisibilitySchema,
  isNsfw: z.boolean(),
  memberCount: z.number().int().nonnegative(),
  postCount: z.number().int().nonnegative(),
  topics: z.array(z.string()),
  createdAt: isoDateTimeSchema,
});
export type CommunityDTO = z.infer<typeof communityDTOSchema>;

export const membershipDTOSchema = z.object({
  communityId: idSchema,
  userId: idSchema,
  role: z.enum(["member", "moderator", "admin", "owner"]),
  status: z.enum(["active", "pending", "banned", "muted"]),
  joinedAt: isoDateTimeSchema,
});
export type MembershipDTO = z.infer<typeof membershipDTOSchema>;

// ─── Pagination ──────────────────────────────────────────────────────────────

export const cursorPageParamsSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type CursorPageParams = z.infer<typeof cursorPageParamsSchema>;

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

// ─── Phase 3: opinion & debate math ──────────────────────────────────────────

export * from "./opinion.js";
