/**
 * GG core schema (docs/DATA_MODEL.md).
 *
 * Phase 1 tables: identity (users, profiles, credentials, refresh_tokens,
 * user_settings), social graph (follows, blocks, mutes), communities
 * (communities, community_members, community_moderators), content (posts —
 * the unified model with ltree paths, D-007), votes + vote_audit,
 * reactions, bookmarks, collections, notifications, reports.
 * Phase 2 tables: media + post_media (§5.2), stories + story_views +
 * close_friends (§7).
 * Phase 3 tables: polls + options + votes + audit + flags (§6), daily pulse
 * bank (D-030/D-031), debates + sides + participants + rounds + challenges +
 * arguments + evidence + stance votes + ratings (§8), context notes (§9),
 * audit_logs (§11.1).
 */
import {
  bigint,
  boolean,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── Custom types ────────────────────────────────────────────────────────────

/** Postgres ltree (DATA_MODEL §5.1). Drizzle has no native ltree type. */
const ltree = customType<{ data: string; driverData: string }>({
  dataType: () => "ltree",
});

/**
 * pgvector embedding column (Phase 5B, D-060): all-MiniLM-L6-v2 output is
 * 384-dimensional. The driver speaks the `[a,b,c]` literal form.
 */
const vector384 = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector(384)",
  toDriver: (value: number[]) => `[${value.join(",")}]`,
  fromDriver: (value: unknown) =>
    typeof value === "string"
      ? value
          .replace(/^\[|\]$/g, "")
          .split(",")
          .filter((part) => part.length > 0)
          .map(Number)
      : (value as number[]),
});

// ─── Enums (DATA_MODEL §0.3) ─────────────────────────────────────────────────

export const authorTypeEnum = pgEnum("author_type", ["human", "agent"]);
export const trustTierEnum = pgEnum("trust_tier", ["T0", "T1", "T2", "T3"]);
export const postTypeEnum = pgEnum("post_type", [
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
export const postVisibilityEnum = pgEnum("post_visibility", [
  "public",
  "followers",
  "community",
  "close_friends",
  "private",
]);
export const communityVisibilityEnum = pgEnum("community_visibility", [
  "public",
  "restricted",
  "private",
]);
export const reportStatusEnum = pgEnum("report_status", [
  "open",
  "triaged",
  "actioned",
  "dismissed",
  "appealed",
  "closed",
]);
export const notificationTypeEnum = pgEnum("notification_type", [
  "reply",
  "mention",
  "follow",
  "vote_digest",
  "debate_challenge",
  "debate_turn",
  "poll_closing",
  "mod_action",
  "dm_request",
  "system",
]);
export const reactionKindEnum = pgEnum("reaction_kind", [
  "like",
  "insightful",
  "funny",
  "agree",
  "disagree",
]);
export const mediaKindEnum = pgEnum("media_kind", ["image", "video", "audio", "gif"]);
export const mediaStatusEnum = pgEnum("media_status", [
  "uploading",
  "processing",
  "ready",
  "failed",
  "quarantined",
  "rejected",
]);
// Phase 3 enums (DATA_MODEL §0.3/§6/§8/§9).
export const pollTypeEnum = pgEnum("poll_type", [
  "single",
  "multiple",
  "ranked",
  "stance_slider",
  "image",
  "hot_take",
]);
export const pollResultModeEnum = pgEnum("poll_result_mode", [
  "live",
  "after_vote",
  "after_close",
]);
export const debateFormatEnum = pgEnum("debate_format", ["open", "structured_1v1", "team"]);
export const debateStatusEnum = pgEnum("debate_status", [
  "draft",
  "open",
  "live",
  "awaiting_turn",
  "closed",
  "archived",
  "cancelled",
]);
export const debateRoundKindEnum = pgEnum("debate_round_kind", [
  "opening",
  "rebuttal",
  "cross",
  "closing",
  "freeform",
]);
export const debateRoundStatusEnum = pgEnum("debate_round_status", [
  "pending",
  "active",
  "submitted",
  "missed",
  "skipped",
]);
export const debateChallengeStatusEnum = pgEnum("debate_challenge_status", [
  "pending",
  "accepted",
  "declined",
  "expired",
]);
export const evidenceKindEnum = pgEnum("evidence_kind", [
  "study",
  "news",
  "data",
  "personal_experience",
  "other",
]);
export const contextNoteStatusEnum = pgEnum("context_note_status", [
  "pending",
  "helpful",
  "not_helpful",
  "needs_more_ratings",
]);
export const contextNoteRatingEnum = pgEnum("context_note_rating", [
  "helpful",
  "somewhat",
  "not_helpful",
]);
export const pollFlagStatusEnum = pgEnum("poll_flag_status", ["open", "reviewed", "actioned"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ─── Identity ────────────────────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    /** Stored lowercased; pattern enforced in the service layer. citext-equivalent via app normalization (D-013). */
    handle: text("handle").notNull(),
    email: text("email"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    authorType: authorTypeEnum("author_type").notNull().default("human"),
    trustTier: trustTierEnum("trust_tier").notNull().default("T0"),
    dateOfBirth: date("date_of_birth"),
    /** Set at registration for 13–17 accounts (D-011 restricted defaults). */
    isMinorRestricted: boolean("is_minor_restricted").notNull().default(false),
    /** Set by POST /onboarding/complete; NULL = onboarding not finished yet. */
    onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
    ageBracket: text("age_bracket").notNull().default("unknown"),
    status: text("status").notNull().default("active"),
    /** Platform-level role (D-030): gates /admin/* integrity endpoints. Community roles live on community_members. */
    platformRole: text("platform_role").notNull().default("user"),
    /** Hardening (D-067): TOTP 2FA confirmed on (secret in user_totp). */
    totpEnabled: boolean("totp_enabled").notNull().default(false),
    /** Hardening (D-068): at least one WebAuthn passkey is registered. */
    hasPasskey: boolean("has_passkey").notNull().default(false),
    /** Agent accounts only: the accountable human owner (DATA_MODEL §2.1). */
    ownerId: uuid("owner_id").references((): AnyPgColumn => users.id),
    locale: text("locale").notNull().default("en"),
    timezone: text("timezone"),
    followerCount: integer("follower_count").notNull().default(0),
    followingCount: integer("following_count").notNull().default(0),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("users_handle_unique").on(t.handle),
    uniqueIndex("users_email_unique")
      .on(t.email)
      .where(sql`${t.email} is not null`),
    index("users_owner_idx").on(t.ownerId).where(sql`${t.authorType} = 'agent'`),
    index("users_trust_created_idx").on(t.trustTier, t.createdAt),
  ],
);

export const profiles = pgTable("profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  bio: text("bio"),
  bioLong: text("bio_long"),
  /** Media FKs landed with the media table in Phase 2 (was plain uuids in Phase 1, D-013). */
  avatarMediaId: uuid("avatar_media_id").references(() => media.id),
  bannerMediaId: uuid("banner_media_id").references(() => media.id),
  websiteUrl: text("website_url"),
  links: jsonb("links").notNull().default([]),
  pronouns: text("pronouns"),
  locationText: text("location_text"),
  isPrivate: boolean("is_private").notNull().default(false),
  pinnedPostId: uuid("pinned_post_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Password credentials, split from users (task spec; DATA_MODEL §2.1 stores the hash on users — see D-013). */
export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** argon2id hash (SECURITY §3). NULL rows are not created — no row = no password login. */
    passwordHash: text("password_hash").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("credentials_user_unique").on(t.userId)],
);

/** Refresh-token sessions with rotation families + reuse detection (DATA_MODEL §2.4). */
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 hex of the token; the token itself is never stored. */
    tokenHash: text("token_hash").notNull(),
    familyId: uuid("family_id").notNull(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    replacedById: uuid("replaced_by_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    deviceLabel: text("device_label"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("refresh_tokens_hash_unique").on(t.tokenHash),
    index("refresh_tokens_user_idx").on(t.userId, t.revokedAt),
    index("refresh_tokens_family_idx").on(t.familyId),
  ],
);

export const userSettings = pgTable("user_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Hide agent-authored content from feeds (D-012 transparency control). */
  hideAiAccounts: boolean("hide_ai_accounts").notNull().default(false),
  hideNsfw: boolean("hide_nsfw").notNull().default(true),
  dmPolicy: text("dm_policy").notNull().default("everyone"),
  mentionPolicy: text("mention_policy").notNull().default("everyone"),
  readReceipts: boolean("read_receipts").notNull().default(true),
  presenceVisible: boolean("presence_visible").notNull().default(false),
  captionsDefaultOn: boolean("captions_default_on").notNull().default(false),
  demographicBreakdownsOptIn: boolean("demographic_breakdowns_opt_in")
    .notNull()
    .default(false),
  language: text("language").notNull().default("en"),
  notificationPrefs: jsonb("notification_prefs").notNull().default({}),
  /** Phase 5B: per-type web-push toggles (same type keys as notification_prefs; absent = on). */
  pushPrefs: jsonb("push_prefs").notNull().default({}),
  /** Phase 5B: email digest cadence — off | daily | weekly. */
  digestFrequency: text("digest_frequency").notNull().default("off"),
  quietHours: jsonb("quiet_hours"),
  /** Free-form preference bag (onboarding topics, UI choices) — Phase 1 round 2. */
  preferences: jsonb("preferences").notNull().default({}),
  /** Accessibility (API_SPEC UserSettings): font_scale 0.8–1.6. */
  fontScale: doublePrecision("font_scale").notNull().default(1),
  highContrast: boolean("high_contrast").notNull().default(false),
  reducedMotion: boolean("reduced_motion").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ─── Social graph ────────────────────────────────────────────────────────────

export const follows = pgTable(
  "follows",
  {
    followerId: uuid("follower_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    followeeId: uuid("followee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.followerId, t.followeeId] }),
    index("follows_followee_idx").on(t.followeeId, t.createdAt),
    index("follows_follower_idx").on(t.followerId, t.createdAt),
  ],
);

export const blocks = pgTable(
  "blocks",
  {
    blockerId: uuid("blocker_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blockedId: uuid("blocked_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.blockerId, t.blockedId] }),
    index("blocks_blocked_idx").on(t.blockedId),
  ],
);

export const mutes = pgTable(
  "mutes",
  {
    muterId: uuid("muter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mutedId: uuid("muted_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.muterId, t.mutedId] })],
);

// ─── Communities ─────────────────────────────────────────────────────────────

export const communities = pgTable(
  "communities",
  {
    id: uuid("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    aboutMd: text("about_md"),
    iconMediaId: uuid("icon_media_id"),
    bannerMediaId: uuid("banner_media_id"),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => users.id),
    visibility: communityVisibilityEnum("visibility").notNull().default("public"),
    isNsfw: boolean("is_nsfw").notNull().default(false),
    memberCount: integer("member_count").notNull().default(0),
    postCount: integer("post_count").notNull().default(0),
    topics: text("topics").array().notNull().default([]),
    language: text("language").notNull().default("en"),
    lockdownAt: timestamp("lockdown_at", { withTimezone: true }),
    lockdownBy: uuid("lockdown_by").references(() => users.id),
    settings: jsonb("settings").notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("communities_slug_unique").on(t.slug),
    index("communities_member_count_idx").on(t.memberCount),
  ],
);

export const communityMembers = pgTable(
  "community_members",
  {
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"), // member | moderator | admin | owner
    status: text("status").notNull().default("active"), // active | pending | banned | muted
    mutedUntil: timestamp("muted_until", { withTimezone: true }),
    bannedReason: text("banned_reason"),
    flairId: uuid("flair_id"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.communityId, t.userId] }),
    index("community_members_user_idx").on(t.userId, t.status),
    index("community_members_role_idx").on(t.communityId, t.role),
    uniqueIndex("community_members_one_owner")
      .on(t.communityId)
      .where(sql`${t.role} = 'owner'`),
  ],
);

/** Explicit moderator grant record (the membership row carries the live role). */
export const communityModerators = pgTable(
  "community_moderators",
  {
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    grantedBy: uuid("granted_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.communityId, t.userId] })],
);

// ─── Content: unified Post model (DATA_MODEL §5.1, D-007) ────────────────────

export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey(),
    shortCode: text("short_code").notNull(),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    authorType: authorTypeEnum("author_type").notNull(),
    type: postTypeEnum("type").notNull(),
    parentId: uuid("parent_id"),
    quotedPostId: uuid("quoted_post_id"),
    repostOfId: uuid("repost_of_id"),
    rootId: uuid("root_id").notNull(),
    path: ltree("path").notNull(),
    pathLabel: text("path_label").notNull(),
    depth: integer("depth").notNull().default(0),
    communityId: uuid("community_id").references(() => communities.id),
    /** Host links for POLL / DEBATE posts (§5.1); FKs added in migration 0003 (circular with polls/debates.post_id). */
    pollId: uuid("poll_id"),
    debateId: uuid("debate_id"),
    title: text("title"),
    bodyMd: text("body_md"),
    bodyHtml: text("body_html"),
    linkUrl: text("link_url"),
    /** Cached link preview; slice 1 stores the {url, domain} stub (unfurl is Phase 2). */
    linkCard: jsonb("link_card"),
    flairId: uuid("flair_id"),
    language: text("language"),
    visibility: postVisibilityEnum("visibility").notNull().default("public"),
    isNsfw: boolean("is_nsfw").notNull().default(false),
    isSpoiler: boolean("is_spoiler").notNull().default(false),
    isLongForm: boolean("is_long_form").notNull().default(false),
    containsAiMedia: boolean("contains_ai_media").notNull().default(false),
    replyPolicy: text("reply_policy").notNull().default("everyone"),
    // Counters — raw ballot counts stay unweighted (integrity); `score` is the
    // weighted sum (D-012) and is double precision so fractional weights work.
    upCount: integer("up_count").notNull().default(0),
    downCount: integer("down_count").notNull().default(0),
    score: doublePrecision("score").notNull().default(0),
    replyCount: integer("reply_count").notNull().default(0),
    repostCount: integer("repost_count").notNull().default(0),
    quoteCount: integer("quote_count").notNull().default(0),
    viewCount: integer("view_count").notNull().default(0),
    saveCount: integer("save_count").notNull().default(0),
    reactionCounts: jsonb("reaction_counts").notNull().default({}),
    hotRank: doublePrecision("hot_rank"),
    hotRankAt: timestamp("hot_rank_at", { withTimezone: true }),
    controversyRank: doublePrecision("controversy_rank"),
    isPinned: boolean("is_pinned").notNull().default(false),
    pinnedBy: uuid("pinned_by").references(() => users.id),
    /** Phase 5B: mod "feature" action — floats under pins on the community page. */
    isFeatured: boolean("is_featured").notNull().default(false),
    /**
     * Phase 5B AutoMod: while set, the post is held for moderation —
     * visible only to its author (and in the community mod queue) until a
     * moderator approves or removes it.
     */
    heldAt: timestamp("held_at", { withTimezone: true }),
    isLocked: boolean("is_locked").notNull().default(false),
    removedBy: uuid("removed_by").references(() => users.id),
    removalReason: text("removal_reason"),
    deleteReason: jsonb("delete_reason"),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    editCount: integer("edit_count").notNull().default(0),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Phase 5A (D-050): scheduled posts. Non-null + future = unpublished —
     * invisible to everyone but the author, no side effects until the
     * publisher clears it. NULL once published (or never scheduled).
     */
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("posts_short_code_unique").on(t.shortCode),
    index("posts_community_hot_idx")
      .on(t.communityId, t.hotRank)
      .where(sql`${t.deletedAt} is null`),
    index("posts_community_created_idx").on(t.communityId, t.createdAt),
    index("posts_author_created_idx").on(t.authorId, t.createdAt),
    index("posts_parent_idx").on(t.parentId),
    index("posts_root_idx").on(t.rootId),
    index("posts_path_gist_idx").using("gist", t.path),
    index("posts_explore_idx")
      .on(t.createdAt)
      .where(sql`${t.visibility} = 'public' and ${t.deletedAt} is null`),
  ],
);

// Self-references for posts (declared after the table to avoid forward refs).
// parent_id / quoted_post_id / repost_of_id / root_id FKs are added by the
// hand-written portion of the initial migration (D-013) because root_id
// references the row itself for top-level posts.

// ─── Media (DATA_MODEL §5.2, Phase 2) ───────────────────────────────────────

export const media = pgTable(
  "media",
  {
    id: uuid("id").primaryKey(),
    uploaderId: uuid("uploader_id")
      .notNull()
      .references(() => users.id),
    kind: mediaKindEnum("kind").notNull(),
    status: mediaStatusEnum("status").notNull().default("uploading"),
    /** Storage-adapter key (local disk path under MEDIA_DIR today). */
    storageKey: text("storage_key").notNull(),
    originalFilename: text("original_filename"),
    mimeType: text("mime_type").notNull(),
    /** Declared size from the upload session; verified against bytes on complete. */
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    /** Bytes received so far (tus Upload-Offset); = size_bytes when complete. */
    uploadOffset: bigint("upload_offset", { mode: "number" }).notNull().default(0),
    /** Upload-session expiry (signed PUT / tus window). */
    uploadExpiresAt: timestamp("upload_expires_at", { withTimezone: true }),
    sha256: text("sha256"),
    width: integer("width"),
    height: integer("height"),
    durationMs: integer("duration_ms"),
    blurhash: text("blurhash"),
    /**
     * Rendition map written by the worker pipeline:
     * `{ sizes: {name: {key,width,height,format}}, hls_playlist_key?,
     *    poster?: {key,width,height,format}, thumbnail_key?,
     *    captions: [{lang, key, source}] }` (DATA_MODEL §5.2 `variants`).
     */
    variants: jsonb("variants").notNull().default({}),
    altText: text("alt_text"),
    altTextSource: text("alt_text_source"),
    exifStripped: boolean("exif_stripped").notNull().default(false),
    /** Classifier output (scanner adapter); stub classifier fields are labeled as such. */
    contentLabels: jsonb("content_labels").notNull().default({}),
    /** `pending | clean | review | rejected` (DATA_MODEL §5.2). */
    scanVerdict: text("scan_verdict").notNull().default("pending"),
    /** Last pipeline error (status=failed diagnostics; never user-facing copy). */
    processingError: text("processing_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("media_uploader_created_idx").on(t.uploaderId, t.createdAt),
    index("media_status_idx").on(t.status),
  ],
);

/** Post ↔ media attachment (DATA_MODEL §5.2). CAROUSEL ≤ 10 enforced in the service layer. */
export const postMedia = pgTable(
  "post_media",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    mediaId: uuid("media_id")
      .notNull()
      .references(() => media.id),
    position: integer("position").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.postId, t.mediaId] }),
    uniqueIndex("post_media_position_unique").on(t.postId, t.position),
    index("post_media_media_idx").on(t.mediaId),
  ],
);

// ─── Stories (DATA_MODEL §7, Phase 2) ───────────────────────────────────────

/** One story frame: a STORY posts row plus this extension row. */
export const stories = pgTable("stories", {
  postId: uuid("post_id")
    .primaryKey()
    .references(() => posts.id, { onDelete: "cascade" }),
  mediaId: uuid("media_id")
    .notNull()
    .references(() => media.id),
  storyGroupId: uuid("story_group_id").notNull(),
  audience: text("audience").notNull().default("everyone"),
  stickers: jsonb("stickers").notNull().default([]),
  musicRef: jsonb("music_ref"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const storyViews = pgTable(
  "story_views",
  {
    storyId: uuid("story_id")
      .notNull()
      .references(() => stories.postId, { onDelete: "cascade" }),
    viewerId: uuid("viewer_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    viewedAt: timestamp("viewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.storyId, t.viewerId] })],
);

/** Close-friends membership (DATA_MODEL §7.2): friend_id is on owner_id's list. */
export const closeFriends = pgTable(
  "close_friends",
  {
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    friendId: uuid("friend_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.friendId] })],
);

// ─── Votes (DATA_MODEL §5.5) ─────────────────────────────────────────────────

export const votes = pgTable(
  "votes",
  {
    id: uuid("id").primaryKey(),
    voterId: uuid("voter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    authorType: authorTypeEnum("author_type").notNull(),
    targetType: text("target_type").notNull(), // post | argument
    targetId: uuid("target_id").notNull(),
    value: smallint("value").notNull(), // 1 | -1
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("votes_voter_target_unique").on(t.voterId, t.targetType, t.targetId),
    index("votes_target_idx").on(t.targetType, t.targetId),
    index("votes_voter_created_idx").on(t.voterId, t.createdAt),
  ],
);

/** Append-only vote audit — written in the SAME transaction as every votes mutation (§11.2). */
export const voteAudit = pgTable(
  "vote_audit",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    voteId: uuid("vote_id"),
    voterId: uuid("voter_id").notNull(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    oldValue: smallint("old_value"),
    newValue: smallint("new_value"),
    changeKind: text("change_kind").notNull(), // cast | flip | retract | void
    createdAt: createdAt(),
  },
  (t) => [
    index("vote_audit_target_idx").on(t.targetType, t.targetId, t.createdAt),
    index("vote_audit_voter_idx").on(t.voterId, t.createdAt),
  ],
);

// ─── Reactions, bookmarks, collections (DATA_MODEL §5.6/§5.7) ────────────────

export const reactions = pgTable(
  "reactions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(), // post | message
    targetId: uuid("target_id").notNull(),
    kind: reactionKindEnum("kind").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("reactions_unique").on(t.userId, t.targetType, t.targetId, t.kind),
    index("reactions_target_idx").on(t.targetType, t.targetId),
  ],
);

export const collections = pgTable("collections", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** Phase 5A: API_SPEC Collection.description (added by migration 0006). */
  description: text("description"),
  isPublic: boolean("is_public").notNull().default(false),
  coverMediaId: uuid("cover_media_id"),
  itemCount: integer("item_count").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const bookmarks = pgTable(
  "bookmarks",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    collectionId: uuid("collection_id").references(() => collections.id, {
      onDelete: "set null",
    }),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.postId] }),
    index("bookmarks_user_created_idx").on(t.userId, t.createdAt),
  ],
);

// ─── Notifications & reports (DATA_MODEL §10.1/§10.3) ────────────────────────

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey(),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: notificationTypeEnum("type").notNull(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    subjectType: text("subject_type"),
    subjectId: uuid("subject_id"),
    groupKey: text("group_key"),
    /** Events folded into this row by the 1h dedupe window (API_SPEC group_count). */
    groupCount: integer("group_count").notNull().default(1),
    payload: jsonb("payload").notNull().default({}),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_recipient_idx").on(t.recipientId, t.createdAt),
    index("notifications_recipient_unread_idx")
      .on(t.recipientId, t.createdAt)
      .where(sql`${t.readAt} is null`),
  ],
);

/**
 * Pending email-change requests (Phase 1 round 2). No mailer yet: the row is
 * the record of intent; the raw token is never stored, only its SHA-256.
 */
export const emailChangeRequests = pgTable(
  "email_change_requests",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    newEmail: text("new_email").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("email_change_requests_token_unique").on(t.tokenHash),
    index("email_change_requests_user_idx").on(t.userId, t.createdAt),
  ],
);

/**
 * Email-verification tokens (Phase 3 exit, D-035). Issued at registration
 * and on resend; single-use, 24 h expiry. Only the SHA-256 of the raw token
 * is stored — the raw token travels only in the emailed link (and, outside
 * production, in the register/resend response as a staging shortcut).
 */
export const emailVerificationTokens = pgTable(
  "email_verification_tokens",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("email_verification_tokens_token_unique").on(t.tokenHash),
    index("email_verification_tokens_user_idx").on(t.userId, t.createdAt),
  ],
);

/** @handle mentions extracted from post bodies (DATA_MODEL §5.4) — drives mention notifications. */
export const postMentions = pgTable(
  "post_mentions",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    mentionedUserId: uuid("mentioned_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.postId, t.mentionedUserId, t.position] }),
    index("post_mentions_user_idx").on(t.mentionedUserId, t.createdAt),
  ],
);

export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey(),
    reporterId: uuid("reporter_id")
      .notNull()
      .references(() => users.id),
    targetType: text("target_type").notNull(), // post | user | community | message | argument | debate
    targetId: uuid("target_id").notNull(),
    reason: text("reason").notNull(),
    details: text("details"),
    status: reportStatusEnum("status").notNull().default("open"),
    severity: integer("severity").notNull().default(2),
    assignedTo: uuid("assigned_to").references(() => users.id),
    slaDueAt: timestamp("sla_due_at", { withTimezone: true }),
    resolution: text("resolution"),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("reports_queue_idx").on(t.status, t.severity, t.createdAt),
    index("reports_target_idx").on(t.targetType, t.targetId),
  ],
);

// ─── Polls (DATA_MODEL §6, Phase 3) ─────────────────────────────────────────

export const polls = pgTable(
  "polls",
  {
    id: uuid("id").primaryKey(),
    /** Host post (type POLL). */
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    type: pollTypeEnum("type").notNull(),
    question: text("question").notNull(),
    resultMode: pollResultModeEnum("result_mode").notNull().default("live"),
    /** Anonymous ballot display: voter rows are always stored; see §6.1. */
    isAnonymous: boolean("is_anonymous").notNull().default(false),
    closesAt: timestamp("closes_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** Multiple-choice cap (type multiple); NULL = no cap beyond option count. */
    maxChoices: integer("max_choices"),
    minTrustTier: trustTierEnum("min_trust_tier").notNull().default("T1"),
    /** Account-age gate in days (D-030; 0 = no gate). */
    minAccountAgeDays: integer("min_account_age_days").notNull().default(0),
    /** Denormalized non-voided ballot counts (D-016-style, maintained in-tx). */
    totalVotes: integer("total_votes").notNull().default(0),
    agentTotalVotes: integer("agent_total_votes").notNull().default(0),
    isDailyPulse: boolean("is_daily_pulse").notNull().default(false),
    /** ET calendar date for the Daily Pulse (D-031). */
    pulseDate: date("pulse_date"),
    /** Whole-poll void by a platform admin (§6.1). */
    voided: boolean("voided").notNull().default(false),
    voidedBy: uuid("voided_by").references(() => users.id),
    voidedReason: text("voided_reason"),
    /** Ranked polls: latest IRV tabulation snapshot (rounds + winner) once computed. */
    rankingCache: jsonb("ranking_cache"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("polls_post_unique").on(t.postId),
    uniqueIndex("polls_pulse_date_unique")
      .on(t.pulseDate)
      .where(sql`${t.isDailyPulse}`),
    index("polls_closes_idx").on(t.closesAt).where(sql`${t.closedAt} is null`),
  ],
);

export const pollOptions = pgTable(
  "poll_options",
  {
    id: uuid("id").primaryKey(),
    pollId: uuid("poll_id")
      .notNull()
      .references(() => polls.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    /** Image polls: the option's media. */
    mediaId: uuid("media_id").references(() => media.id),
    /** Denormalized non-voided counts (split tallies, D-012). */
    voteCount: integer("vote_count").notNull().default(0),
    agentVoteCount: integer("agent_vote_count").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("poll_options_poll_position_unique").on(t.pollId, t.position),
    index("poll_options_poll_idx").on(t.pollId),
  ],
);

export const pollVotes = pgTable(
  "poll_votes",
  {
    id: uuid("id").primaryKey(),
    pollId: uuid("poll_id")
      .notNull()
      .references(() => polls.id, { onDelete: "cascade" }),
    voterId: uuid("voter_id")
      .notNull()
      .references(() => users.id),
    /** Denormalized voter class for split tallies (D-012). */
    authorType: authorTypeEnum("author_type").notNull(),
    /** Choice for single / image / hot_take ballots. */
    optionId: uuid("option_id").references(() => pollOptions.id, { onDelete: "cascade" }),
    /** Ranked ballots: option ids, most-preferred first. */
    ranking: uuid("ranking").array(),
    /** Stance-slider ballots: −2..+2 (§0.3 stance scale). */
    sliderValue: smallint("slider_value"),
    /** Snapshot at cast time — only populated when the voter opted in (§6.3). */
    voterAgeBracket: text("voter_age_bracket"),
    voterTrustTier: trustTierEnum("voter_trust_tier").notNull(),
    /** Admin void (§6.3): excluded from every tally when set. */
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => users.id),
    voidReason: text("void_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("poll_votes_poll_voter_unique").on(t.pollId, t.voterId),
    index("poll_votes_poll_created_idx").on(t.pollId, t.createdAt),
    index("poll_votes_voter_idx").on(t.voterId, t.createdAt),
  ],
);

/** Choices for `multiple` ballots (one row per picked option). */
export const pollVoteChoices = pgTable(
  "poll_vote_choices",
  {
    pollVoteId: uuid("poll_vote_id")
      .notNull()
      .references(() => pollVotes.id, { onDelete: "cascade" }),
    optionId: uuid("option_id")
      .notNull()
      .references(() => pollOptions.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.pollVoteId, t.optionId] })],
);

/** Every ballot mutation, written in the same transaction (§6.3). */
export const pollVoteAudit = pgTable(
  "poll_vote_audit",
  {
    id: uuid("id").primaryKey(),
    pollId: uuid("poll_id").notNull(),
    voterId: uuid("voter_id").notNull(),
    changeKind: text("change_kind").notNull(), // cast | change | retract | void | unvoid
    beforeState: jsonb("before_state"),
    afterState: jsonb("after_state"),
    actorId: uuid("actor_id"),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("poll_vote_audit_poll_idx").on(t.pollId, t.createdAt),
    index("poll_vote_audit_voter_idx").on(t.voterId, t.createdAt),
  ],
);

/** Vote-integrity anomaly flags (D-030, brief §4). */
export const pollFlags = pgTable(
  "poll_flags",
  {
    id: uuid("id").primaryKey(),
    pollId: uuid("poll_id")
      .notNull()
      .references(() => polls.id, { onDelete: "cascade" }),
    /** velocity_burst | young_account_burst | single_option_surge (extensible). */
    kind: text("kind").notNull(),
    /** Burst measurements + implicated voter ids, for admin review/voiding. */
    details: jsonb("details").notNull().default({}),
    status: pollFlagStatusEnum("status").notNull().default("open"),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("poll_flags_status_idx").on(t.status, t.createdAt),
    index("poll_flags_poll_idx").on(t.pollId, t.createdAt),
  ],
);

/** Daily Pulse question bank (D-031): admin-seeded, one question per ET day. */
export const dailyPulseQuestions = pgTable(
  "daily_pulse_questions",
  {
    id: uuid("id").primaryKey(),
    question: text("question").notNull(),
    type: pollTypeEnum("type").notNull().default("single"),
    /** Option texts in display order (2–10). */
    options: jsonb("options").notNull().default([]),
    /** Optional pinned ET date; NULL = next in queue. */
    scheduledDate: date("scheduled_date"),
    /** ET date this question was published as the pulse; NULL = unused. */
    usedDate: date("used_date"),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("daily_pulse_questions_scheduled_unique")
      .on(t.scheduledDate)
      .where(sql`${t.scheduledDate} is not null`),
    index("daily_pulse_questions_unused_idx").on(t.usedDate, t.createdAt),
  ],
);

// ─── Debates (DATA_MODEL §8, Phase 3) ───────────────────────────────────────

export const debates = pgTable(
  "debates",
  {
    id: uuid("id").primaryKey(),
    shortCode: text("short_code").notNull(),
    /** Host post (type DEBATE) — carries discussion + the article link card. */
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    proposition: text("proposition").notNull(),
    format: debateFormatEnum("format").notNull(),
    status: debateStatusEnum("status").notNull().default("open"),
    communityId: uuid("community_id").references(() => communities.id),
    /** genznewz (or any) article this debate is about (§8.1). */
    sourceArticleUrl: text("source_article_url"),
    hostId: uuid("host_id")
      .notNull()
      .references(() => users.id),
    judgeId: uuid("judge_id").references(() => users.id),
    /** Async turn length in hours (structured formats); DATA_MODEL interval, stored as hours (D-030). */
    turnDeadlineHours: integer("turn_deadline_hours").notNull().default(24),
    /** Live mode: seconds per turn (NULL = async). */
    liveTurnSeconds: integer("live_turn_seconds"),
    perTurnCharLimit: integer("per_turn_char_limit").notNull().default(2000),
    scheduledStartAt: timestamp("scheduled_start_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    winnerSideId: uuid("winner_side_id"),
    isDraw: boolean("is_draw").notNull().default(false),
    /** Spec snapshot: {argument_votes: 0.5, mind_change: 0.35, evidence_quality: 0.15}. */
    winnerFormula: jsonb("winner_formula").notNull().default({
      argument_votes: 0.5,
      mind_change: 0.35,
      evidence_quality: 0.15,
    }),
    /** Close-out computation details (component shares, forfeit reason…) for audit/display. */
    winnerDetails: jsonb("winner_details"),
    // Mind-change aggregates (maintained at close; live counts come from stance_votes).
    mindChangedCount: integer("mind_changed_count").notNull().default(0),
    mindChangeRate: doublePrecision("mind_change_rate").notNull().default(0),
    audiencePreCount: integer("audience_pre_count").notNull().default(0),
    audiencePostCount: integer("audience_post_count").notNull().default(0),
    /** Feature flags: { steelman_required, evidence_required, allow_spectator_chat }. */
    settings: jsonb("settings").notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("debates_short_code_unique").on(t.shortCode),
    uniqueIndex("debates_post_unique").on(t.postId),
    index("debates_status_created_idx").on(t.status, t.createdAt),
    index("debates_community_idx").on(t.communityId, t.createdAt),
    index("debates_host_idx").on(t.hostId, t.createdAt),
  ],
);

export const debateSides = pgTable(
  "debate_sides",
  {
    id: uuid("id").primaryKey(),
    debateId: uuid("debate_id")
      .notNull()
      .references(() => debates.id, { onDelete: "cascade" }),
    /** open: for|against|nuanced; structured_1v1: for|against; team: a|b (§8.2). */
    key: text("key").notNull(),
    label: text("label").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("debate_sides_debate_key_unique").on(t.debateId, t.key),
    index("debate_sides_debate_idx").on(t.debateId),
  ],
);

export const debateParticipants = pgTable(
  "debate_participants",
  {
    debateId: uuid("debate_id")
      .notNull()
      .references(() => debates.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    sideId: uuid("side_id")
      .notNull()
      .references(() => debateSides.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("debater"), // debater | host | judge
    /** Elo at debate start — rating history is explainable (§8.3). */
    eloAtStart: integer("elo_at_start"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.debateId, t.userId] }),
    index("debate_participants_user_idx").on(t.userId),
  ],
);

export const debateRounds = pgTable(
  "debate_rounds",
  {
    id: uuid("id").primaryKey(),
    debateId: uuid("debate_id")
      .notNull()
      .references(() => debates.id, { onDelete: "cascade" }),
    roundNo: integer("round_no").notNull(),
    kind: debateRoundKindEnum("kind").notNull().default("freeform"),
    /** Whose turn — NULL for simultaneous rounds. */
    sideId: uuid("side_id").references(() => debateSides.id, { onDelete: "cascade" }),
    /** The debater expected to submit (structured formats). */
    turnUserId: uuid("turn_user_id").references(() => users.id),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    status: debateRoundStatusEnum("status").notNull().default("pending"),
    /** The submitted argument for this turn, once present. */
    argumentId: uuid("argument_id"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("debate_rounds_debate_no_unique").on(t.debateId, t.roundNo),
    index("debate_rounds_deadline_idx").on(t.deadlineAt).where(sql`${t.status} = 'active'`),
  ],
);

/** 1v1/team challenge handshake (D-030). */
export const debateChallenges = pgTable(
  "debate_challenges",
  {
    id: uuid("id").primaryKey(),
    debateId: uuid("debate_id")
      .notNull()
      .references(() => debates.id, { onDelete: "cascade" }),
    challengerId: uuid("challenger_id")
      .notNull()
      .references(() => users.id),
    challengedId: uuid("challenged_id")
      .notNull()
      .references(() => users.id),
    /** The side the CHALLENGER takes; the challenged debater takes the other. */
    sideKey: text("side_key").notNull(),
    message: text("message"),
    status: debateChallengeStatusEnum("status").notNull().default("pending"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("debate_challenges_challenged_idx").on(t.challengedId, t.status, t.createdAt),
    index("debate_challenges_debate_idx").on(t.debateId, t.createdAt),
  ],
);

/** Arguments are their own table — NOT posts (§8.5). Votes ride the shared votes table (target_type 'argument'). */
export const debateArguments = pgTable(
  "arguments",
  {
    id: uuid("id").primaryKey(),
    debateId: uuid("debate_id")
      .notNull()
      .references(() => debates.id, { onDelete: "cascade" }),
    sideId: uuid("side_id")
      .notNull()
      .references(() => debateSides.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    authorType: authorTypeEnum("author_type").notNull(),
    /** Structured formats: the round this argument submits. */
    roundId: uuid("round_id").references(() => debateRounds.id),
    /** Rebuttal tree within the debate (service-capped depth 3). */
    parentArgumentId: uuid("parent_argument_id"),
    bodyMd: text("body_md").notNull(),
    bodyHtml: text("body_html").notNull(),
    /** Claim summary (live debate lower-third). */
    claim: text("claim"),
    isOpening: boolean("is_opening").notNull().default(false),
    isSteelman: boolean("is_steelman").notNull().default(false),
    steelmanConfirmedBy: uuid("steelman_confirmed_by").references(() => users.id),
    /** Counters mirror posts (raw counts; score weighted per D-012). */
    upCount: integer("up_count").notNull().default(0),
    downCount: integer("down_count").notNull().default(0),
    score: doublePrecision("score").notNull().default(0),
    humanUpCount: integer("human_up_count").notNull().default(0),
    humanDownCount: integer("human_down_count").notNull().default(0),
    agentUpCount: integer("agent_up_count").notNull().default(0),
    agentDownCount: integer("agent_down_count").notNull().default(0),
    /** D-032 heuristic, recomputed when evidence changes. */
    evidenceQuality: doublePrecision("evidence_quality").notNull().default(0),
    /** Heuristic flags: [{fallacy, flagged_by, confirmed_by_mod}] (§8.5). */
    fallacyFlags: jsonb("fallacy_flags").notNull().default([]),
    removedBy: uuid("removed_by").references(() => users.id),
    removalReason: text("removal_reason"),
    createdAt: createdAt(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("arguments_debate_side_idx").on(t.debateId, t.sideId, t.createdAt),
    index("arguments_debate_score_idx").on(t.debateId, t.score),
    index("arguments_author_idx").on(t.authorId, t.createdAt),
    index("arguments_parent_idx").on(t.parentArgumentId),
  ],
);

export const evidenceLinks = pgTable(
  "evidence_links",
  {
    id: uuid("id").primaryKey(),
    argumentId: uuid("argument_id")
      .notNull()
      .references(() => debateArguments.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    kind: evidenceKindEnum("kind").notNull().default("other"),
    /** ≤ 500 char supporting quote (§8.5). */
    quote: text("quote"),
    /** Unfurl cache: {title, description, image}. */
    preview: jsonb("preview"),
    domain: text("domain"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("evidence_links_argument_idx").on(t.argumentId)],
);

/** Audience stance, recorded pre- and post-debate (§8.7) — the mind-change measure. */
export const stanceVotes = pgTable(
  "stance_votes",
  {
    id: uuid("id").primaryKey(),
    debateId: uuid("debate_id")
      .notNull()
      .references(() => debates.id, { onDelete: "cascade" }),
    voterId: uuid("voter_id")
      .notNull()
      .references(() => users.id),
    authorType: authorTypeEnum("author_type").notNull(),
    phase: text("phase").notNull(), // pre | post
    stanceValue: smallint("stance_value").notNull(),
    /** The side the stance leans to (derived at write time). */
    sideId: uuid("side_id").references(() => debateSides.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("stance_votes_debate_voter_phase_unique").on(t.debateId, t.voterId, t.phase),
    index("stance_votes_debate_phase_idx").on(t.debateId, t.phase),
    index("stance_votes_voter_idx").on(t.voterId),
  ],
);

/** Per-user debate Elo + record (§8.8). Row created on first rated debate. */
export const debateRatings = pgTable("debate_ratings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  rating: integer("rating").notNull().default(1200),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  draws: integer("draws").notNull().default(0),
  debatesCount: integer("debates_count").notNull().default(0),
  peakRating: integer("peak_rating").notNull().default(1200),
  updatedAt: updatedAt(),
});

export const debateRatingEvents = pgTable(
  "debate_rating_events",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    debateId: uuid("debate_id")
      .notNull()
      .references(() => debates.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(),
    ratingAfter: integer("rating_after").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("debate_rating_events_user_idx").on(t.userId, t.createdAt)],
);

// ─── Context notes (DATA_MODEL §9, Phase 3) ─────────────────────────────────

export const contextNotes = pgTable(
  "context_notes",
  {
    id: uuid("id").primaryKey(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    authorType: authorTypeEnum("author_type").notNull(),
    body: text("body").notNull(),
    /** Source URLs backing the note. */
    sources: jsonb("sources").notNull().default([]),
    status: contextNoteStatusEnum("status").notNull().default("pending"),
    /** Simplified bridging internals (D-033): helpful counts by viewpoint cluster. */
    helpfulFromPos: integer("helpful_from_pos").notNull().default(0),
    helpfulFromNeg: integer("helpful_from_neg").notNull().default(0),
    ratingCount: integer("rating_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("context_notes_post_status_idx").on(t.postId, t.status),
    index("context_notes_author_idx").on(t.authorId, t.createdAt),
  ],
);

export const contextNoteRatings = pgTable(
  "context_note_ratings",
  {
    noteId: uuid("note_id")
      .notNull()
      .references(() => contextNotes.id, { onDelete: "cascade" }),
    raterId: uuid("rater_id")
      .notNull()
      .references(() => users.id),
    rating: contextNoteRatingEnum("rating").notNull(),
    /** D-033 viewpoint cluster at rating time: −1 | 0 | 1 (internal only). */
    raterViewpointCluster: smallint("rater_viewpoint_cluster").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.noteId, t.raterId] })],
);

// ─── Audit log (DATA_MODEL §11.1) ───────────────────────────────────────────

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey(),
    actorId: uuid("actor_id").references(() => users.id),
    /** poll.void_ballots | poll.void | poll_flag.review | agent.post.create | … */
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    /** Phase 4: the API key that authenticated the action, when key auth was used. */
    apiKeyId: uuid("api_key_id"),
    /** Phase 4: how the actor authenticated — session | api_key | oauth. */
    authMethod: text("auth_method"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_logs_target_idx").on(t.targetType, t.targetId, t.createdAt),
    index("audit_logs_actor_idx").on(t.actorId, t.createdAt),
  ],
);

// ─── Agent platform (Phase 4) ───────────────────────────────────────────────

/**
 * Public agent metadata + lifecycle state, one row per agent account
 * (DATA_MODEL §2.1 agent fields, API_SPEC AgentProfile). The users row stays
 * the identity; this row is the disclosure + rate tier + kill switch.
 */
export const agentProfiles = pgTable("agent_profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Publicly displayed purpose (API_SPEC AgentRegistration, required). */
  purpose: text("purpose").notNull(),
  modelProvider: text("model_provider"),
  modelName: text("model_name"),
  /** Capability tags from the API_SPEC enum (posting, voting, …). */
  capabilities: jsonb("capabilities").notNull().default([]),
  homepageUrl: text("homepage_url"),
  /** Earned rate tier (SECURITY §8.2): 0 = tightly limited at registration. */
  rateTier: integer("rate_tier").notNull().default(0),
  /** Kill switch (SECURITY §8.3): engaged = every credential is dead. */
  killSwitchEngaged: boolean("kill_switch_engaged").notNull().default(false),
  killSwitchReason: text("kill_switch_reason"),
  killSwitchById: uuid("kill_switch_by_id").references(() => users.id),
  killSwitchAt: timestamp("kill_switch_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * API keys (API_SPEC ApiKey). A key acts as exactly one account (`userId`) —
 * an agent (created by its owner at registration or later) or a human's
 * personal key. Only the SHA-256 hash is stored; the secret is shown once.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Who created the key (the accountable human; = userId for personal keys). */
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Display-safe prefix, e.g. `gg_live_9f3c…` (API_SPEC ApiKey.key_prefix). */
    keyPrefix: text("key_prefix").notNull(),
    /** SHA-256 hex of the full secret. */
    keyHash: text("key_hash").notNull(),
    /** ApiScope values (API_SPEC components). */
    scopes: jsonb("scopes").notNull().default([]),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("api_keys_hash_unique").on(t.keyHash),
    index("api_keys_user_idx").on(t.userId, t.revokedAt),
  ],
);

/**
 * OAuth 2.1 clients (API_SPEC OAuthClient). Phase 4 implements the
 * client-credentials grant only (D-037); redirect_uris are stored for the
 * authorization-code flow that lands in hardening (D-022).
 */
export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    /** SHA-256 hex of the client secret; NULL for public clients. */
    clientSecretHash: text("client_secret_hash"),
    name: text("name").notNull(),
    redirectUris: jsonb("redirect_uris").notNull().default([]),
    allowedScopes: jsonb("allowed_scopes").notNull().default([]),
    isConfidential: boolean("is_confidential").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("oauth_clients_client_id_unique").on(t.clientId)],
);

/**
 * Webhooks (API_SPEC Webhook). The signing secret must stay recoverable
 * (the signer HMACs with the exact value shown once at creation) and is
 * NEVER serialized back by the API (D-042). Since hardening (D-065) it
 * is stored AES-256-GCM-encrypted whenever a field key is configured;
 * pre-hardening rows may still hold legacy plaintext, which readers
 * tolerate and the boot backfill rewrites.
 */
export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    /** WebhookEvent values (API_SPEC components). */
    events: jsonb("events").notNull().default([]),
    secret: text("secret").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    failureStreak: integer("failure_streak").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("webhooks_owner_idx").on(t.ownerId)],
);

/**
 * One row per (webhook, event) delivery, driven to completion by the
 * worker's gg-webhooks consumer (API_SPEC WebhookDelivery). Status:
 * pending → delivered | failed (non-retryable) | exhausted (retries used up).
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey(),
    webhookId: uuid("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    /** The exact JSON body POSTed (id, event, created_at, data). */
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    responseStatus: integer("response_status"),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("webhook_deliveries_webhook_idx").on(t.webhookId, t.createdAt),
    index("webhook_deliveries_pending_idx").on(t.status, t.nextAttemptAt),
  ],
);

// ─── Phase 5A: lists (DATA_MODEL §3.4) ───────────────────────────────────────

export const lists = pgTable(
  "lists",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    isPublic: boolean("is_public").notNull().default(false),
    /** Denormalized member count (maintained in the member write tx). */
    memberCount: integer("member_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("lists_owner_idx").on(t.ownerId, t.createdAt),
    index("lists_public_idx").on(t.isPublic, t.memberCount),
  ],
);

export const listMembers = pgTable(
  "list_members",
  {
    listId: uuid("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    addedBy: uuid("added_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.listId, t.userId] }),
    index("list_members_user_idx").on(t.userId),
  ],
);

// ─── Phase 5A: conversations & messages (DATA_MODEL §10.2) ─────────────────

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey(),
    /** dm | group | modmail (Phase 5B: mod mail threads carry a community) */
    kind: text("kind").notNull(),
    /** Phase 5B: the owning community for mod-mail conversations. */
    communityId: uuid("community_id").references(() => communities.id),
    title: text("title"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    /**
     * Canonical `least(a,b):greatest(a,b)` pair key for DMs — the database
     * guarantee of one DM conversation per user pair (DATA_MODEL §10.2).
     */
    dmPairKey: text("dm_pair_key").unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("conversations_last_message_idx").on(t.lastMessageAt)],
);

export const conversationParticipants = pgTable(
  "conversation_participants",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** member | admin (group creator starts as admin). */
    role: text("role").notNull().default("member"),
    /** active | requested | declined (request placement is per-recipient). */
    status: text("status").notNull().default("active"),
    lastReadMessageId: uuid("last_read_message_id"),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    mutedUntil: timestamp("muted_until", { withTimezone: true }),
    /** Set when the participant leaves / hides the conversation. */
    leftAt: timestamp("left_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId] }),
    index("conversation_participants_user_idx").on(t.userId, t.status),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => users.id),
    authorType: authorTypeEnum("author_type").notNull(),
    body: text("body"),
    mediaId: uuid("media_id").references(() => media.id),
    replyToMessageId: uuid("reply_to_message_id"),
    sharedPostId: uuid("shared_post_id").references(() => posts.id),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** E2EE-ready reserved columns (DATA_MODEL §10.2); v1 uses body. */
    ciphertext: text("ciphertext"),
    encryptionVersion: integer("encryption_version"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("messages_conversation_created_idx").on(t.conversationId, t.createdAt),
    index("messages_sender_idx").on(t.senderId, t.createdAt),
  ],
);

/** Emoji reactions on messages (D-047 — dedicated table, free-form emoji). */
export const messageReactions = pgTable(
  "message_reactions",
  {
    id: uuid("id").primaryKey(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("message_reactions_unique").on(t.messageId, t.userId, t.emoji),
    index("message_reactions_message_idx").on(t.messageId),
  ],
);

/**
 * Trending snapshots (D-052): one row per (kind, key) per computation; reads
 * serve the newest computed_at batch. `payload` carries the display fields
 * the API hydrates from (counts, titles) so reads stay cheap.
 */
export const trendingSnapshots = pgTable(
  "trending_snapshots",
  {
    id: uuid("id").primaryKey(),
    /** hashtag | post | community | debate */
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    score: doublePrecision("score").notNull().default(0),
    payload: jsonb("payload").notNull().default({}),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("trending_snapshots_kind_computed_idx").on(t.kind, t.computedAt)],
);

// ─── Phase 5B: events, automod, embeddings, push, digests ──────────────────

/**
 * Product analytics event log (Phase 5B). One row per action; feed
 * impressions batch their served post ids into `props.post_ids` so a feed
 * page costs exactly one insert. Aggregates live in services/analytics.ts.
 */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey(),
    /** Null for anonymous-surface events (e.g. explore impressions). */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /** post.view | feed.impression | post.create | post.vote | poll.vote |
     *  debate.argument | debate.completed | follow | report | dm.sent */
    type: text("type").notNull(),
    subjectType: text("subject_type"),
    subjectId: uuid("subject_id"),
    props: jsonb("props").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("events_type_ts_idx").on(t.type, t.createdAt),
    index("events_user_ts_idx").on(t.userId, t.createdAt),
    index("events_ts_idx").on(t.createdAt),
  ],
);

/** Community AutoMod rules (API_SPEC AutomodRule; effects per D-057). */
export const automodRules = pgTable(
  "automod_rules",
  {
    id: uuid("id").primaryKey(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id, { onDelete: "cascade" }),
    /** keyword | regex | account_age | karma_threshold | link_domain | trust_tier | link_count */
    kind: text("kind").notNull(),
    config: jsonb("config").notNull().default({}),
    /** flag | hold | remove (D-057: automod effects, not ModActionType) */
    action: text("action").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("automod_rules_community_idx").on(t.communityId, t.isEnabled)],
);

/**
 * AutoMod outcomes awaiting (or past) moderator review — the `held` half
 * of the mod queue. `flag` outcomes never hid the post; `hold` outcomes
 * set posts.held_at; `remove` outcomes soft-deleted it (status starts
 * `removed`, listed here so the queue/log tells the whole story).
 */
export const automodHolds = pgTable(
  "automod_holds",
  {
    id: uuid("id").primaryKey(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id").references(() => automodRules.id, {
      onDelete: "set null",
    }),
    /** The rule kind + action snapshot, kept even if the rule is deleted. */
    ruleKind: text("rule_kind").notNull(),
    action: text("action").notNull(), // flag | hold | remove
    /** Human-readable match evidence, e.g. `keyword "free money"`. */
    matchDetail: text("match_detail"),
    /** pending | approved | removed */
    status: text("status").notNull().default("pending"),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("automod_holds_queue_idx").on(t.communityId, t.status, t.createdAt),
    index("automod_holds_post_idx").on(t.postId),
  ],
);

/** Moderator action log (API_SPEC ModAction) — one row per mod action. */
export const modActions = pgTable(
  "mod_actions",
  {
    id: uuid("id").primaryKey(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id, { onDelete: "cascade" }),
    /** ModActionType: remove_post | approve_post | ban | mute | lock_thread |
     *  pin | unpin | warn | note | feature | restore */
    action: text("action").notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    /** post | user | message | argument */
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    targetUserId: uuid("target_user_id").references(() => users.id),
    reason: text("reason"),
    durationHours: integer("duration_hours"),
    createdAt: createdAt(),
  },
  (t) => [
    index("mod_actions_community_idx").on(t.communityId, t.createdAt),
    index("mod_actions_target_idx").on(t.targetType, t.targetId),
  ],
);

/** Post embeddings for semantic search (pgvector; worker-written, D-060). */
export const postEmbeddings = pgTable("post_embeddings", {
  postId: uuid("post_id")
    .primaryKey()
    .references(() => posts.id, { onDelete: "cascade" }),
  embedding: vector384("embedding").notNull(),
  /** Model identifier, e.g. `all-MiniLM-L6-v2`. */
  model: text("model").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Web Push subscriptions (Phase 5B) — one row per browser endpoint. */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("push_subscriptions_endpoint_unique").on(t.endpoint),
    index("push_subscriptions_user_idx").on(t.userId),
  ],
);

/**
 * Push send attempts (worker-written): one row per (notification,
 * subscription) attempt, including skips — the honest delivery record.
 */
export const pushDeliveries = pgTable(
  "push_deliveries",
  {
    id: uuid("id").primaryKey(),
    notificationId: uuid("notification_id").references(() => notifications.id, {
      onDelete: "set null",
    }),
    subscriptionId: uuid("subscription_id").references(() => pushSubscriptions.id, {
      onDelete: "set null",
    }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** sent | failed | skipped_pref | skipped_quiet_hours | gone */
    status: text("status").notNull(),
    responseStatus: integer("response_status"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("push_deliveries_notif_sub_unique").on(
      t.notificationId,
      t.subscriptionId,
    ),
    index("push_deliveries_user_idx").on(t.userId, t.createdAt),
  ],
);

// ─── Hardening phase (D-065…D-070) ─────────────────────────────────────────

/**
 * TOTP 2FA enrollment (D-067). One row per user; the shared secret is
 * stored AES-256-GCM-encrypted via the field-encryption module (D-065) —
 * never plaintext. `enabled` flips on only after a successful verify.
 */
export const userTotp = pgTable("user_totp", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** `enc:v1:…` ciphertext of the base32 TOTP secret. */
  secretEnc: text("secret_enc").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Single-use TOTP recovery codes — SHA-256 hashes only (D-067). */
export const totpRecoveryCodes = pgTable(
  "totp_recovery_codes",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("totp_recovery_codes_user_idx").on(t.userId, t.usedAt)],
);

/**
 * WebAuthn passkey credentials (D-068). The credential public key is not
 * secret; the counter guards against cloned authenticators.
 */
export const passkeyCredentials = pgTable(
  "passkey_credentials",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** base64url credential id from the authenticator; globally unique. */
    credentialId: text("credential_id").notNull(),
    /** base64url COSE public key bytes. */
    publicKey: text("public_key").notNull(),
    counter: bigint("counter", { mode: "number" }).notNull().default(0),
    /** Authenticator transports (usb/nfc/ble/internal/hybrid). */
    transports: jsonb("transports").notNull().default([]),
    deviceName: text("device_name"),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("passkey_credentials_credential_unique").on(t.credentialId),
    index("passkey_credentials_user_idx").on(t.userId, t.createdAt),
  ],
);

/**
 * External OAuth identities (Google/Discord sign-in, D-069). Linking is
 * by provider-verified email (D-005); one provider account ↔ one GG user.
 */
export const oauthIdentities = pgTable(
  "oauth_identities",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** google | discord */
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    email: text("email"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("oauth_identities_provider_user_unique").on(
      t.provider,
      t.providerUserId,
    ),
    index("oauth_identities_user_idx").on(t.userId),
  ],
);

/**
 * OAuth 2.1 authorization codes for third-party GG clients (D-066).
 * Only the SHA-256 hash is stored; codes are single-use, 10-minute TTL,
 * and bound to a PKCE S256 challenge + the exact redirect_uri.
 */
export const oauthAuthorizationCodes = pgTable(
  "oauth_authorization_codes",
  {
    id: uuid("id").primaryKey(),
    codeHash: text("code_hash").notNull(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    scopes: jsonb("scopes").notNull().default([]),
    codeChallenge: text("code_challenge").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("oauth_authorization_codes_hash_unique").on(t.codeHash),
    index("oauth_authorization_codes_client_idx").on(t.clientId, t.createdAt),
  ],
);

/** Password-reset tokens — mirrors email_verification_tokens (D-070). */
export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("password_reset_tokens_token_unique").on(t.tokenHash),
    index("password_reset_tokens_user_idx").on(t.userId, t.createdAt),
  ],
);

/** Email digest send log — one row per user per digest run (idempotency). */
export const digestLogs = pgTable(
  "digest_logs",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** daily | weekly */
    frequency: text("frequency").notNull(),
    /** Local (America/Toronto) period key, e.g. `2026-10-11` / `2026-W41`. */
    periodKey: text("period_key").notNull(),
    itemCount: integer("item_count").notNull().default(0),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("digest_logs_user_period_unique").on(
      t.userId,
      t.frequency,
      t.periodKey,
    ),
  ],
);
