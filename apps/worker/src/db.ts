/**
 * Worker-side database access. The worker keeps its own minimal table
 * definitions (same tables/columns the API owns) instead of importing the
 * API package — the two deployables share the database, not code. Enum
 * columns are mapped as text here; Postgres enforces the real enums.
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  bigint,
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import postgres from "postgres";

export const mediaTable = pgTable("media", {
  id: uuid("id").primaryKey(),
  uploaderId: uuid("uploader_id").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  storageKey: text("storage_key").notNull(),
  mimeType: text("mime_type").notNull(),
  width: integer("width"),
  height: integer("height"),
  durationMs: integer("duration_ms"),
  blurhash: text("blurhash"),
  variants: jsonb("variants"),
  exifStripped: boolean("exif_stripped"),
  contentLabels: jsonb("content_labels"),
  scanVerdict: text("scan_verdict"),
  processingError: text("processing_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

export const storiesTable = pgTable("stories", {
  postId: uuid("post_id").primaryKey(),
  mediaId: uuid("media_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const postsTable = pgTable("posts", {
  id: uuid("id").primaryKey(),
  shortCode: text("short_code"),
  authorId: uuid("author_id"),
  authorType: text("author_type"),
  type: text("type"),
  parentId: uuid("parent_id"),
  rootId: uuid("root_id"),
  path: text("path"),
  pathLabel: text("path_label"),
  communityId: uuid("community_id"),
  title: text("title"),
  bodyMd: text("body_md"),
  bodyHtml: text("body_html"),
  visibility: text("visibility"),
  pollId: uuid("poll_id"),
  // Phase 5A (migration 0006): scheduled publishing + trending inputs.
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  // Phase 5B: digest ranking + held filtering.
  score: doublePrecision("score"),
  heldAt: timestamp("held_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

/** Phase 5A: tables for the scheduled publisher + trending job. */
export const postMentionsTable = pgTable("post_mentions", {
  postId: uuid("post_id").notNull(),
  mentionedUserId: uuid("mentioned_user_id").notNull(),
  position: integer("position").notNull(),
});

export const communitiesTable = pgTable("communities", {
  id: uuid("id").primaryKey(),
  slug: text("slug"),
  name: text("name"),
  postCount: integer("post_count").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const voteAuditTable = pgTable("vote_audit", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  voterId: uuid("voter_id").notNull(),
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  oldValue: smallint("old_value"),
  newValue: smallint("new_value"),
  changeKind: text("change_kind").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const trendingSnapshotsTable = pgTable("trending_snapshots", {
  id: uuid("id").primaryKey(),
  /** hashtag | post | community | debate (D-054: one row per item). */
  kind: text("kind").notNull(),
  key: text("key").notNull(),
  score: doublePrecision("score").notNull().default(0),
  payload: jsonb("payload").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
});

// ─── Phase 3 (opinion & debate sweeps; minimal defs, enums as text) ─────────

export const usersTable = pgTable("users", {
  id: uuid("id").primaryKey(),
  handle: text("handle").notNull(),
  authorType: text("author_type").notNull(),
  status: text("status").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const pollsTable = pgTable("polls", {
  id: uuid("id").primaryKey(),
  postId: uuid("post_id").notNull(),
  type: text("type").notNull(),
  question: text("question").notNull(),
  resultMode: text("result_mode").notNull(),
  closesAt: timestamp("closes_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  isDailyPulse: boolean("is_daily_pulse").notNull(),
  pulseDate: text("pulse_date"),
  rankingCache: jsonb("ranking_cache"),
});

export const pollOptionsTable = pgTable("poll_options", {
  id: uuid("id").primaryKey(),
  pollId: uuid("poll_id").notNull(),
  position: integer("position").notNull(),
  text: text("text").notNull(),
});

export const pollVotesTable = pgTable("poll_votes", {
  id: uuid("id").primaryKey(),
  pollId: uuid("poll_id").notNull(),
  optionId: uuid("option_id"),
  ranking: uuid("ranking").array(),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
});

export const dailyPulseQuestionsTable = pgTable("daily_pulse_questions", {
  id: uuid("id").primaryKey(),
  question: text("question").notNull(),
  type: text("type").notNull(),
  options: jsonb("options").notNull(),
  scheduledDate: text("scheduled_date"),
  usedDate: text("used_date"),
  isActive: boolean("is_active").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const debatesTable = pgTable("debates", {
  id: uuid("id").primaryKey(),
  proposition: text("proposition"),
  postId: uuid("post_id"),
  status: text("status").notNull(),
  format: text("format").notNull(),
  hostId: uuid("host_id").notNull(),
  judgeId: uuid("judge_id"),
  liveTurnSeconds: integer("live_turn_seconds"),
  turnDeadlineHours: integer("turn_deadline_hours").notNull(),
  winnerSideId: uuid("winner_side_id"),
  isDraw: boolean("is_draw").notNull(),
  winnerFormula: jsonb("winner_formula"),
  winnerDetails: jsonb("winner_details"),
  mindChangedCount: integer("mind_changed_count").notNull(),
  mindChangeRate: doublePrecision("mind_change_rate"),
  audiencePreCount: integer("audience_pre_count").notNull(),
  audiencePostCount: integer("audience_post_count").notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const debateSidesTable = pgTable("debate_sides", {
  id: uuid("id").primaryKey(),
  debateId: uuid("debate_id").notNull(),
  key: text("key").notNull(),
  position: integer("position").notNull(),
});

export const debateParticipantsTable = pgTable("debate_participants", {
  debateId: uuid("debate_id").notNull(),
  userId: uuid("user_id").notNull(),
  sideId: uuid("side_id").notNull(),
  role: text("role").notNull(),
});

export const debateRoundsTable = pgTable("debate_rounds", {
  id: uuid("id").primaryKey(),
  debateId: uuid("debate_id").notNull(),
  roundNo: integer("round_no").notNull(),
  sideId: uuid("side_id"),
  turnUserId: uuid("turn_user_id"),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }),
  status: text("status").notNull(),
  argumentId: uuid("argument_id"),
});

export const debateArgumentsTable = pgTable("arguments", {
  id: uuid("id").primaryKey(),
  debateId: uuid("debate_id").notNull(),
  sideId: uuid("side_id").notNull(),
  score: doublePrecision("score"),
  evidenceQuality: doublePrecision("evidence_quality"),
  createdAt: timestamp("created_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const stanceVotesTable = pgTable("stance_votes", {
  id: uuid("id").primaryKey(),
  debateId: uuid("debate_id").notNull(),
  voterId: uuid("voter_id").notNull(),
  phase: text("phase").notNull(),
  stanceValue: integer("stance_value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }),
});

export const debateRatingsTable = pgTable("debate_ratings", {
  userId: uuid("user_id").primaryKey(),
  rating: integer("rating").notNull(),
  wins: integer("wins").notNull(),
  losses: integer("losses").notNull(),
  draws: integer("draws").notNull(),
  debatesCount: integer("debates_count").notNull(),
  peakRating: integer("peak_rating").notNull(),
});

export const debateRatingEventsTable = pgTable("debate_rating_events", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  debateId: uuid("debate_id").notNull(),
  delta: integer("delta").notNull(),
  ratingAfter: integer("rating_after").notNull(),
});

export const notificationsTable = pgTable("notifications", {
  id: uuid("id").primaryKey(),
  recipientId: uuid("recipient_id").notNull(),
  type: text("type").notNull(),
  actorId: uuid("actor_id"),
  subjectType: text("subject_type"),
  subjectId: uuid("subject_id"),
  groupKey: text("group_key"),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const postMediaTable = pgTable("post_media", {
  postId: uuid("post_id").notNull(),
  mediaId: uuid("media_id").notNull(),
});

/** Phase 4 (migration 0005) — webhook subscriptions + delivery rows. */
export const webhooksTable = pgTable("webhooks", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  url: text("url").notNull(),
  events: jsonb("events").notNull(),
  secret: text("secret").notNull(),
  isActive: boolean("is_active").notNull(),
  failureStreak: integer("failure_streak").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const webhookDeliveriesTable = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey(),
  webhookId: uuid("webhook_id").notNull(),
  event: text("event").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull(),
  responseStatus: integer("response_status"),
  lastError: text("last_error"),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

// ─── Phase 5B (embeddings, push, digests) ───────────────────────────────────

/**
 * Embedding column is written via raw SQL with an explicit ::vector cast
 * (see embeddings.ts) — the mirror maps it as text and never reads it.
 */
export const postEmbeddingsTable = pgTable("post_embeddings", {
  postId: uuid("post_id").primaryKey(),
  model: text("model").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

export const userSettingsTable = pgTable("user_settings", {
  userId: uuid("user_id").primaryKey(),
  notificationPrefs: jsonb("notification_prefs").notNull(),
  pushPrefs: jsonb("push_prefs").notNull(),
  quietHours: jsonb("quiet_hours"),
  digestFrequency: text("digest_frequency").notNull(),
});

export const pushSubscriptionsTable = pgTable("push_subscriptions", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  endpoint: text("endpoint").notNull(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
});

export const pushDeliveriesTable = pgTable("push_deliveries", {
  id: uuid("id").primaryKey(),
  notificationId: uuid("notification_id"),
  subscriptionId: uuid("subscription_id"),
  userId: uuid("user_id").notNull(),
  status: text("status").notNull(),
  responseStatus: integer("response_status"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }),
});

export const digestLogsTable = pgTable("digest_logs", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  frequency: text("frequency").notNull(),
  periodKey: text("period_key").notNull(),
  itemCount: integer("item_count").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
});

export const communityMembersTable = pgTable("community_members", {
  communityId: uuid("community_id").notNull(),
  userId: uuid("user_id").notNull(),
  status: text("status").notNull(),
});

/** users mirror extension for digests (email + verification state). */
export const usersContactTable = pgTable("users", {
  id: uuid("id").primaryKey(),
  handle: text("handle").notNull(),
  email: text("email"),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
});

/** Hardening (D-071): audit-log pruning reads/writes audit_logs only. */
export const auditLogsTable = pgTable("audit_logs", {
  id: uuid("id").primaryKey(),
  actorId: uuid("actor_id"),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  authMethod: text("auth_method"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export type WorkerDb = PostgresJsDatabase;

export function createWorkerDb(databaseUrl: string): {
  client: postgres.Sql;
  db: WorkerDb;
} {
  const client = postgres(databaseUrl, { max: 5 });
  return { client, db: drizzle(client) };
}
