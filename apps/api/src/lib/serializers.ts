/**
 * Wire serializers — API_SPEC.yaml shapes exactly (snake_case fields,
 * `{ data, page }` envelopes). DECISIONS D-018: the spec is the wire
 * contract; @gg/shared DTOs remain the web-side model, bridged by the SDK.
 */
import type {
  agentProfiles,
  apiKeys,
  auditLogs,
  automodHolds,
  communities,
  communityMembers,
  media,
  notifications,
  oauthClients,
  posts,
  profiles,
  reports,
  stories,
  userSettings,
  users,
  webhookDeliveries,
  webhooks,
} from "../db/schema";

export type UserRow = typeof users.$inferSelect;
export type ProfileRow = typeof profiles.$inferSelect;
export type PostRow = typeof posts.$inferSelect;
export type CommunityRow = typeof communities.$inferSelect;
export type MembershipRow = typeof communityMembers.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type UserSettingsRow = typeof userSettings.$inferSelect;
export type ReportRow = typeof reports.$inferSelect;
export type MediaRow = typeof media.$inferSelect;
export type StoryRow = typeof stories.$inferSelect;

// ─── Envelope (API_SPEC PageMeta) ────────────────────────────────────────────

export interface PageEnvelope<T> {
  data: T[];
  page: { next_cursor: string | null; has_more: boolean };
}

export function pageEnvelope<T>(data: T[], nextCursor: string | null): PageEnvelope<T> {
  return { data, page: { next_cursor: nextCursor, has_more: nextCursor !== null } };
}

// ─── Author / user shapes ────────────────────────────────────────────────────

export interface AuthorRef {
  id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
  author_type: UserRow["authorType"];
  trust_tier: UserRow["trustTier"];
  /** The permanent AI badge: true for agent accounts. */
  is_verified_agent: boolean;
}

export function authorRef(
  user: UserRow,
  profile: ProfileRow | null,
  avatarUrl: string | null = null,
): AuthorRef {
  return {
    id: user.id,
    handle: user.handle,
    display_name: profile?.displayName ?? user.handle,
    avatar_url: avatarUrl,
    author_type: user.authorType,
    trust_tier: user.trustTier,
    is_verified_agent: user.authorType === "agent",
  };
}

export interface ProfileWire {
  user_id: string;
  handle: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
  banner_url: string | null;
  website_url: string | null;
  /** Free-text location (profiles.location_text) — round 2 settings form. */
  location: string | null;
  links: unknown;
  author_type: UserRow["authorType"];
  trust_tier: UserRow["trustTier"];
  is_private: boolean;
  follower_count: number;
  following_count: number;
  pinned_post_id: string | null;
  debate_rating: number | null;
  debate_record: { wins: number; losses: number; draws: number } | null;
  badges: Array<{ slug: string; name: string }>;
}

export interface DebateRecordSummary {
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  debatesCount: number;
}

export function profileWire(
  user: UserRow,
  profile: ProfileRow | null,
  mediaUrls: { avatarUrl?: string | null; bannerUrl?: string | null } = {},
  debate?: DebateRecordSummary | null,
): ProfileWire {
  return {
    user_id: user.id,
    handle: user.handle,
    display_name: profile?.displayName ?? user.handle,
    bio: profile?.bio ?? null,
    avatar_url: mediaUrls.avatarUrl ?? null,
    banner_url: mediaUrls.bannerUrl ?? null,
    website_url: profile?.websiteUrl ?? null,
    location: profile?.locationText ?? null,
    links: profile?.links ?? [],
    author_type: user.authorType,
    trust_tier: user.trustTier,
    is_private: profile?.isPrivate ?? false,
    follower_count: user.followerCount,
    following_count: user.followingCount,
    pinned_post_id: profile?.pinnedPostId ?? null,
    debate_rating: debate?.debatesCount ? debate.rating : null,
    debate_record: debate?.debatesCount
      ? { wins: debate.wins, losses: debate.losses, draws: debate.draws }
      : null,
    badges: [],
  };
}

export interface UserPrivateWire {
  id: string;
  handle: string;
  email: string | null;
  email_verified: boolean;
  author_type: UserRow["authorType"];
  trust_tier: UserRow["trustTier"];
  age_bracket: string;
  is_minor_restricted: boolean;
  status: string;
  has_passkey: boolean;
  totp_enabled: boolean;
  profile: ProfileWire;
  created_at: string;
  /** Phase 1 round 2: drives the web onboarding guard (null = not finished). */
  onboarding_completed_at: string | null;
  /** Phase 5B: 'user' | 'admin' — drives the admin analytics nav entry. */
  platform_role: string;
}

export function userPrivateWire(user: UserRow, profile: ProfileRow | null): UserPrivateWire {
  return {
    id: user.id,
    handle: user.handle,
    email: user.email,
    email_verified: user.emailVerifiedAt !== null,
    author_type: user.authorType,
    trust_tier: user.trustTier,
    age_bracket: user.ageBracket,
    is_minor_restricted: user.isMinorRestricted,
    status: user.status,
    has_passkey: false,
    totp_enabled: false,
    profile: profileWire(user, profile),
    created_at: user.createdAt.toISOString(),
    onboarding_completed_at: user.onboardingCompletedAt?.toISOString() ?? null,
    platform_role: user.platformRole,
  };
}

// ─── Vote breakdown (D-012: split tallies are always displayable) ────────────

export interface VoteBreakdown {
  human: { up: number; down: number };
  agent: { up: number; down: number };
}

export const emptyBreakdown = (): VoteBreakdown => ({
  human: { up: 0, down: 0 },
  agent: { up: 0, down: 0 },
});

// ─── Media (API_SPEC MediaObject, Phase 2) ──────────────────────────────────

/** Internal rendition entry as stored in media.variants.sizes. */
export interface StoredRendition {
  key: string;
  width: number;
  height: number;
  format: string;
}

export interface MediaVariantsStored {
  sizes?: Record<string, StoredRendition>;
  hls_playlist_key?: string;
  thumbnail_key?: string;
  captions?: Array<{ lang: string; key: string; source: "auto" | "user" }>;
}

export interface MediaVariantWire {
  url: string;
  width: number;
  height: number;
  format: string;
}

export interface MediaObjectWire {
  id: string;
  kind: MediaRow["kind"];
  status: MediaRow["status"];
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  blurhash: string | null;
  alt_text: string | null;
  /** Primary rendition URL (ready media only; null while processing). */
  url: string | null;
  variants: Record<string, unknown>;
  captions: Array<{ lang: string; url: string; source: string }>;
}

/**
 * Public URL for one named media variant. Variant names are stable aliases
 * (`original`, size names, `poster`); storage keys never leave the server —
 * the file route resolves name → key from the media row.
 */
export function mediaVariantUrl(mediaId: string, variant: string): string {
  return `/media/${mediaId}/${variant}`;
}

export function mediaWire(row: MediaRow): MediaObjectWire {
  const stored = (row.variants ?? {}) as MediaVariantsStored;
  const sizes = stored.sizes ?? {};
  const variants: Record<string, unknown> = {};
  for (const [name, rendition] of Object.entries(sizes)) {
    const wire: MediaVariantWire = {
      url: mediaVariantUrl(row.id, name),
      width: rendition.width,
      height: rendition.height,
      format: rendition.format,
    };
    variants[name] = wire;
  }
  let url: string | null = null;
  if (row.status === "ready") {
    if (row.kind === "video") {
      variants.hls_url = mediaVariantUrl(row.id, "hls/master.m3u8");
      variants.thumbnail_url = mediaVariantUrl(row.id, "thumb");
      url = variants.hls_url as string;
    } else {
      const primary = sizes.medium ?? sizes.small ?? sizes.thumb;
      url = primary
        ? mediaVariantUrl(row.id, sizes.medium ? "medium" : sizes.small ? "small" : "thumb")
        : mediaVariantUrl(row.id, "original");
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    width: row.width,
    height: row.height,
    duration_ms: row.durationMs,
    blurhash: row.blurhash,
    alt_text: row.altText,
    url,
    variants,
    captions: (stored.captions ?? []).map((track) => ({
      lang: track.lang,
      url: mediaVariantUrl(row.id, `captions/${track.lang}`),
      source: track.source,
    })),
  };
}

/** Resolve a public variant name to its storage key (null = no such variant). */
export function mediaVariantKey(row: MediaRow, variant: string): string | null {
  const stored = (row.variants ?? {}) as MediaVariantsStored;
  if (variant === "original") return row.storageKey;
  if (variant.startsWith("captions/")) {
    const lang = variant.slice("captions/".length);
    return stored.captions?.find((t) => t.lang === lang)?.key ?? null;
  }
  if (variant === "thumb" && row.kind === "video") {
    return stored.thumbnail_key ?? stored.sizes?.poster?.key ?? null;
  }
  return stored.sizes?.[variant]?.key ?? null;
}

// ─── Post (API_SPEC Post) ────────────────────────────────────────────────────

export interface CommunityRef {
  id: string;
  slug: string;
  name: string;
  icon_url: string | null;
}

export function communityRef(row: CommunityRow): CommunityRef {
  return { id: row.id, slug: row.slug, name: row.name, icon_url: null };
}

export interface ViewerPostState {
  vote: "up" | "down" | null;
  bookmarked: boolean;
  reactions: string[];
}

export const defaultViewerState = (): ViewerPostState => ({
  vote: null,
  bookmarked: false,
  reactions: [],
});

export interface PostWire {
  id: string;
  short_code: string;
  type: PostRow["type"];
  author: AuthorRef;
  author_type: UserRow["authorType"];
  parent_id: string | null;
  root_id: string;
  depth: number;
  community: CommunityRef | null;
  title: string | null;
  body_md: string | null;
  body_html: string | null;
  is_long_form: boolean;
  link_card: unknown;
  media: MediaObjectWire[];
  flair: string | null;
  visibility: PostRow["visibility"];
  reply_policy: string;
  is_nsfw: boolean;
  is_spoiler: boolean;
  contains_ai_media: boolean;
  is_pinned: boolean;
  /** Phase 5B (spec delta): mod-featured in its community. */
  is_featured: boolean;
  /** Phase 5B (spec delta): held by AutoMod, awaiting moderation. */
  is_held: boolean;
  is_locked: boolean;
  up_count: number;
  /** Null when the display rule withholds it (personal timeline, non-author). */
  down_count: number | null;
  score: number;
  reply_count: number;
  repost_count: number;
  quote_count: number;
  view_count: number;
  save_count: number;
  reaction_counts: Record<string, number>;
  vote_breakdown: VoteBreakdown;
  /** Phase 3: embedded poll/debate for POLL / DEBATE host posts (API_SPEC Post). */
  poll: PollWire | null;
  debate: DebateWire | null;
  /** Phase 5A (D-050, spec delta): set while the post awaits its publish time. */
  scheduled_for: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  removed: boolean;
  created_at: string;
  viewer_state: ViewerPostState;
}

export function postWire(
  post: PostRow,
  author: AuthorRef,
  opts: {
    viewerId?: string | null;
    viewerState?: ViewerPostState;
    breakdown?: VoteBreakdown;
    community?: CommunityRef | null;
    media?: MediaObjectWire[];
    poll?: PollWire | null;
    debate?: DebateWire | null;
  } = {},
): PostWire {
  const tombstoned = post.deletedAt !== null;
  const withheldDown =
    post.communityId === null &&
    opts.viewerId != null &&
    opts.viewerId !== post.authorId;
  return {
    id: post.id,
    short_code: post.shortCode,
    type: post.type,
    author,
    author_type: post.authorType,
    parent_id: post.parentId,
    root_id: post.rootId,
    depth: post.depth,
    community: opts.community ?? null,
    title: tombstoned ? null : post.title,
    body_md: tombstoned ? null : post.bodyMd,
    body_html: tombstoned ? null : post.bodyHtml,
    is_long_form: post.isLongForm,
    link_card: tombstoned ? null : post.linkCard,
    media: tombstoned ? [] : (opts.media ?? []),
    flair: null,
    visibility: post.visibility,
    reply_policy: post.replyPolicy,
    is_nsfw: post.isNsfw,
    is_spoiler: post.isSpoiler,
    contains_ai_media: post.containsAiMedia,
    is_pinned: post.isPinned,
    is_featured: post.isFeatured,
    is_held: post.heldAt !== null,
    is_locked: post.isLocked,
    up_count: post.upCount,
    down_count: withheldDown ? null : post.downCount,
    score: Math.round(post.score),
    reply_count: post.replyCount,
    repost_count: post.repostCount,
    quote_count: post.quoteCount,
    view_count: post.viewCount,
    save_count: post.saveCount,
    reaction_counts: (post.reactionCounts ?? {}) as Record<string, number>,
    vote_breakdown: opts.breakdown ?? emptyBreakdown(),
    poll: tombstoned ? null : (opts.poll ?? null),
    debate: tombstoned ? null : (opts.debate ?? null),
    scheduled_for: post.scheduledFor?.toISOString() ?? null,
    edited_at: post.editedAt?.toISOString() ?? null,
    deleted_at: post.deletedAt?.toISOString() ?? null,
    removed: post.removedBy !== null,
    created_at: post.createdAt.toISOString(),
    viewer_state: opts.viewerState ?? defaultViewerState(),
  };
}

// ─── Community / membership (API_SPEC Community / Membership) ────────────────

export interface CommunityWire {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  about_md: string | null;
  icon_url: string | null;
  banner_url: string | null;
  visibility: CommunityRow["visibility"];
  is_nsfw: boolean;
  member_count: number;
  post_count: number;
  topics: string[];
  language: string;
  lockdown_active: boolean;
  rules: unknown[];
  flairs: unknown[];
  created_at: string;
}

export function communityWire(row: CommunityRow): CommunityWire {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    about_md: row.aboutMd,
    icon_url: null,
    banner_url: null,
    visibility: row.visibility,
    is_nsfw: row.isNsfw,
    member_count: row.memberCount,
    post_count: row.postCount,
    topics: row.topics,
    language: row.language,
    lockdown_active: row.lockdownAt !== null,
    rules: [],
    flairs: [],
    created_at: row.createdAt.toISOString(),
  };
}

export interface MembershipWire {
  /**
   * The membership's addressable id (Phase 5B delta): community_members
   * has a composite (community_id, user_id) primary key, so within a
   * community the membership IS the user id — the decide endpoint's
   * {membershipId} is this value.
   */
  id: string;
  community_id: string;
  user: AuthorRef;
  role: string;
  status: string;
  muted_until: string | null;
  joined_at: string;
}

export function membershipWire(row: MembershipRow, user: AuthorRef): MembershipWire {
  return {
    id: row.userId,
    community_id: row.communityId,
    user,
    role: row.role,
    status: row.status,
    muted_until: row.mutedUntil?.toISOString() ?? null,
    joined_at: row.joinedAt.toISOString(),
  };
}

// ─── Notification (API_SPEC Notification) ────────────────────────────────────

export interface NotificationWire {
  id: string;
  type: NotificationRow["type"];
  actor: AuthorRef | null;
  subject_type: string | null;
  subject_id: string | null;
  payload: Record<string, unknown>;
  group_count: number;
  read_at: string | null;
  created_at: string;
}

export function notificationWire(
  row: NotificationRow,
  actor: AuthorRef | null,
): NotificationWire {
  return {
    id: row.id,
    type: row.type,
    actor,
    subject_type: row.subjectType,
    subject_id: row.subjectId,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    group_count: row.groupCount,
    read_at: row.readAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

// ─── UserSettings (API_SPEC UserSettings) ────────────────────────────────────

export interface QuietHours {
  start: string;
  end: string;
}

export interface UserSettingsWire {
  hide_ai_accounts: boolean;
  hide_nsfw: boolean;
  dm_policy: string;
  mention_policy: string;
  read_receipts: boolean;
  presence_visible: boolean;
  captions_default_on: boolean;
  font_scale: number;
  high_contrast: boolean;
  reduced_motion: boolean;
  demographic_breakdowns_opt_in: boolean;
  language: string;
  notification_prefs: Record<string, boolean>;
  /** Phase 5B: per-type web-push toggles (absent key = on). */
  push_prefs: Record<string, boolean>;
  /** Phase 5B: email digest cadence — off | daily | weekly. */
  digest_frequency: string;
  quiet_hours: QuietHours | null;
  /** Onboarding topics + free-form preferences (user_settings.preferences). */
  preferences: Record<string, unknown>;
}

export function userSettingsWire(row: UserSettingsRow): UserSettingsWire {
  const quiet = row.quietHours as QuietHours | null;
  return {
    hide_ai_accounts: row.hideAiAccounts,
    hide_nsfw: row.hideNsfw,
    dm_policy: row.dmPolicy,
    mention_policy: row.mentionPolicy,
    read_receipts: row.readReceipts,
    presence_visible: row.presenceVisible,
    captions_default_on: row.captionsDefaultOn,
    font_scale: row.fontScale,
    high_contrast: row.highContrast,
    reduced_motion: row.reducedMotion,
    demographic_breakdowns_opt_in: row.demographicBreakdownsOptIn,
    language: row.language,
    notification_prefs: (row.notificationPrefs ?? {}) as Record<string, boolean>,
    push_prefs: (row.pushPrefs ?? {}) as Record<string, boolean>,
    digest_frequency: row.digestFrequency,
    quiet_hours:
      quiet && typeof quiet.start === "string" && typeof quiet.end === "string"
        ? { start: quiet.start, end: quiet.end }
        : null,
    preferences: (row.preferences ?? {}) as Record<string, unknown>,
  };
}

// ─── Story (API_SPEC Story / StoryGroup, Phase 2) ─────────────────────────────

export interface StoryWire {
  id: string;
  author: AuthorRef;
  media: MediaObjectWire;
  group_id: string;
  audience: string;
  stickers: unknown[];
  view_count: number;
  viewer_has_seen: boolean;
  created_at: string;
  expires_at: string;
}

export function storyWire(
  row: StoryRow,
  author: AuthorRef,
  media: MediaObjectWire,
  opts: { viewCount: number; viewerHasSeen: boolean },
): StoryWire {
  return {
    id: row.postId,
    author,
    media,
    group_id: row.storyGroupId,
    audience: row.audience,
    stickers: (row.stickers ?? []) as unknown[],
    view_count: opts.viewCount,
    viewer_has_seen: opts.viewerHasSeen,
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
  };
}

export interface StoryGroupWire {
  author: AuthorRef;
  stories: StoryWire[];
  has_unseen: boolean;
}

// ─── Report (API_SPEC Report / ModQueueItem) ─────────────────────────────────

export interface ReportWire {
  id: string;
  target_type: string;
  target_id: string;
  reason: string;
  status: ReportRow["status"];
  resolution: string | null;
  created_at: string;
}

export function reportWire(row: ReportRow): ReportWire {
  return {
    id: row.id,
    target_type: row.targetType,
    target_id: row.targetId,
    reason: row.reason,
    status: row.status,
    resolution: row.resolution,
    created_at: row.createdAt.toISOString(),
  };
}

export interface ModQueueItemWire {
  id: string;
  kind: "report" | "held";
  severity: number;
  report: ReportWire | null;
  post: PostWire | null;
  /** Phase 5B: for kind=held, the AutoMod rule that caught the post. */
  automod_rule: {
    id: string | null;
    kind: string;
    action: string;
    detail: string | null;
  } | null;
  created_at: string;
}

export function modQueueItemWire(row: ReportRow, post: PostWire | null): ModQueueItemWire {
  return {
    id: row.id,
    kind: "report",
    severity: row.severity,
    report: reportWire(row),
    post,
    automod_rule: null,
    created_at: row.createdAt.toISOString(),
  };
}

export type AutomodHoldRow = typeof automodHolds.$inferSelect;

/** Queue severity for a held item, by the action AutoMod took. */
export function heldSeverity(action: string): number {
  return action === "remove" ? 3 : action === "hold" ? 2 : 1;
}

export function heldQueueItemWire(
  row: AutomodHoldRow,
  post: PostWire | null,
): ModQueueItemWire {
  return {
    id: row.id,
    kind: "held",
    severity: heldSeverity(row.action),
    report: null,
    post,
    automod_rule: {
      id: row.ruleId,
      kind: row.ruleKind,
      action: row.action,
      detail: row.matchDetail,
    },
    created_at: row.createdAt.toISOString(),
  };
}

// ─── Phase 3: polls / debates / context notes ────────────────────────────────

import type {
  contextNotes,
  debateArguments,
  debateRatings,
  debateRounds,
  debateSides,
  debates,
  evidenceLinks,
  pollOptions,
  polls,
} from "../db/schema";

export type PollRow = typeof polls.$inferSelect;
export type PollOptionRow = typeof pollOptions.$inferSelect;
export type DebateRow = typeof debates.$inferSelect;
export type DebateSideRow = typeof debateSides.$inferSelect;
export type DebateRoundRow = typeof debateRounds.$inferSelect;
export type ArgumentRow = typeof debateArguments.$inferSelect;
export type EvidenceRow = typeof evidenceLinks.$inferSelect;
export type ContextNoteRow = typeof contextNotes.$inferSelect;
export type DebateRatingRow = typeof debateRatings.$inferSelect;

export interface PollViewerBallot {
  option_id: string | null;
  option_ids: string[];
  ranking: string[] | null;
  slider_value: number | null;
}

export interface PollOptionResultWire {
  id: string;
  position: number;
  text: string | null;
  media: MediaObjectWire | null;
  human_votes: number;
  agent_votes: number;
  /** Share of the human vote, 0..1 (API_SPEC PollOptionResult). */
  share: number;
}

export interface PollWire {
  id: string;
  post_id: string;
  type: PollRow["type"];
  question: string;
  options: PollOptionResultWire[];
  result_mode: PollRow["resultMode"];
  results_visible: boolean;
  is_anonymous: boolean;
  is_daily_pulse: boolean;
  min_trust_tier: PollRow["minTrustTier"];
  /** Human ballots. */
  total_votes: number;
  agent_total_votes: number;
  closes_at: string | null;
  is_closed: boolean;
  voided: boolean;
  viewer_ballot: PollViewerBallot | null;
}

export interface PollResultsWire {
  poll_id: string;
  options: PollOptionResultWire[];
  total_votes: number;
  agent_total_votes: number;
  winner_option_id: string | null;
  irv_rounds: Array<{
    round: number;
    tallies: Record<string, number>;
    eliminated_option_id: string | null;
  }>;
  breakdowns: {
    by_trust_tier: Record<string, number>;
    by_age_bracket: Record<string, number>;
  };
  viewer_ballot: PollViewerBallot | null;
  /** Stance-slider distribution buckets (−2..+2 → ballot counts); only for stance_slider polls. */
  stance_distribution: Record<string, number> | null;
}

export interface DebateSideWire {
  id: string;
  key: string;
  label: string;
  argument_count: number;
  human_argument_votes: number;
  agent_argument_votes: number;
}

export interface DebateParticipantWire {
  user: AuthorRef;
  side_key: string;
  role: string;
  elo_at_start: number | null;
}

export interface DebateRoundWire {
  round_no: number;
  kind: DebateRoundRow["kind"];
  side_key: string | null;
  deadline_at: string | null;
  status: DebateRoundRow["status"];
  argument_id: string | null;
}

export interface DebateWire {
  id: string;
  short_code: string;
  post_id: string;
  proposition: string;
  format: DebateRow["format"];
  status: DebateRow["status"];
  host: AuthorRef;
  judge: AuthorRef | null;
  community: CommunityRef | null;
  source_article_url: string | null;
  sides: DebateSideWire[];
  participants: DebateParticipantWire[];
  rounds: DebateRoundWire[];
  current_round: number | null;
  per_turn_char_limit: number;
  turn_deadline_hours: number | null;
  winner_side_key: string | null;
  is_draw: boolean;
  winner_formula: { argument_votes: number; mind_change: number; evidence_quality: number } | null;
  mind_change: {
    audience_pre_count: number;
    audience_post_count: number;
    mind_changed_count: number;
    mind_change_rate: number;
  };
  scheduled_start_at: string | null;
  closed_at: string | null;
  created_at: string;
  /** Phase 3 delta: pending challenge addressed to the viewer (draft 1v1). */
  viewer_challenge: { id: string } | null;
  /** Phase 3 delta: closed by double-forfeit; the judge must decide. */
  pending_judge: boolean;
}

export interface EvidenceWire {
  id: string;
  url: string;
  kind: EvidenceRow["kind"];
  quote: string | null;
  domain: string | null;
  preview: unknown;
}

export interface ArgumentWire {
  id: string;
  debate_id: string;
  side_key: string;
  author: AuthorRef;
  author_type: ArgumentRow["authorType"];
  round_no: number | null;
  parent_argument_id: string | null;
  body_md: string;
  body_html: string;
  is_steelman: boolean;
  steelman_confirmed: boolean;
  evidence: EvidenceWire[];
  fallacy_flags: Array<{ fallacy: string; confirmed_by_mod: boolean }>;
  up_count: number;
  down_count: number;
  score: number;
  vote_breakdown: VoteBreakdown;
  evidence_quality: number;
  created_at: string;
  viewer_state: { vote: "up" | "down" | null };
}

export interface ContextNoteWire {
  id: string;
  post_id: string;
  author: AuthorRef;
  body: string;
  sources: string[];
  status: ContextNoteRow["status"];
  created_at: string;
}

export function evidenceWire(row: EvidenceRow): EvidenceWire {
  return {
    id: row.id,
    url: row.url,
    kind: row.kind,
    quote: row.quote,
    domain: row.domain,
    preview: row.preview ?? null,
  };
}

export function contextNoteWire(row: ContextNoteRow, author: AuthorRef): ContextNoteWire {
  return {
    id: row.id,
    post_id: row.postId,
    author,
    body: row.body,
    sources: (row.sources ?? []) as string[],
    status: row.status,
    created_at: row.createdAt.toISOString(),
  };
}

// ─── Agent platform (Phase 4) ───────────────────────────────────────────────

export type AgentProfileRow = typeof agentProfiles.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type OAuthClientRow = typeof oauthClients.$inferSelect;
export type WebhookRow = typeof webhooks.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
export type AuditLogRow = typeof auditLogs.$inferSelect;

/** Standard AI disclosure line shown on every agent profile (API_SPEC). */
export function agentDisclosure(ownerHandle: string): string {
  return `AI agent account owned by @${ownerHandle}. Content from this account is machine-generated.`;
}

export interface AgentProfileWire {
  user_id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
  purpose: string;
  owner: AuthorRef;
  model_provider: string | null;
  model_name: string | null;
  capabilities: string[];
  homepage_url: string | null;
  rate_tier: number;
  kill_switch_engaged: boolean;
  auto_disclosure: string;
  created_at: string;
}

export function agentProfileWire(
  agent: UserRow,
  agentProfile: {
    purpose: string;
    modelProvider: string | null;
    modelName: string | null;
    capabilities: unknown;
    homepageUrl: string | null;
    rateTier: number;
    killSwitchEngaged: boolean;
  } | null,
  profile: ProfileRow | null,
  owner: AuthorRef,
  avatarUrl: string | null = null,
): AgentProfileWire {
  return {
    user_id: agent.id,
    handle: agent.handle,
    display_name: profile?.displayName ?? agent.handle,
    avatar_url: avatarUrl,
    purpose: agentProfile?.purpose ?? "",
    owner,
    model_provider: agentProfile?.modelProvider ?? null,
    model_name: agentProfile?.modelName ?? null,
    capabilities: Array.isArray(agentProfile?.capabilities)
      ? (agentProfile.capabilities as string[])
      : [],
    homepage_url: agentProfile?.homepageUrl ?? null,
    rate_tier: agentProfile?.rateTier ?? 0,
    kill_switch_engaged: agentProfile?.killSwitchEngaged ?? false,
    auto_disclosure: agentDisclosure(owner.handle),
    created_at: agent.createdAt.toISOString(),
  };
}

export interface ApiKeyWire {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export function apiKeyWire(row: ApiKeyRow): ApiKeyWire {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.keyPrefix,
    scopes: (row.scopes as string[] | null) ?? [],
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    expires_at: row.expiresAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

export interface OAuthClientWire {
  id: string;
  client_id: string;
  name: string;
  redirect_uris: string[];
  allowed_scopes: string[];
  is_confidential: boolean;
  created_at: string;
}

export function oauthClientWire(row: OAuthClientRow): OAuthClientWire {
  return {
    id: row.id,
    client_id: row.clientId,
    name: row.name,
    redirect_uris: (row.redirectUris as string[] | null) ?? [],
    allowed_scopes: (row.allowedScopes as string[] | null) ?? [],
    is_confidential: row.isConfidential,
    created_at: row.createdAt.toISOString(),
  };
}

export interface WebhookWire {
  id: string;
  url: string;
  events: string[];
  is_active: boolean;
  failure_streak: number;
  created_at: string;
}

export function webhookWire(row: WebhookRow): WebhookWire {
  return {
    id: row.id,
    url: row.url,
    events: (row.events as string[] | null) ?? [],
    is_active: row.isActive,
    failure_streak: row.failureStreak,
    created_at: row.createdAt.toISOString(),
  };
}

export interface WebhookDeliveryWire {
  id: string;
  event: string;
  status: string;
  attempts: number;
  response_status: number | null;
  next_attempt_at: string | null;
  created_at: string;
}

export function webhookDeliveryWire(row: WebhookDeliveryRow): WebhookDeliveryWire {
  return {
    id: row.id,
    event: row.event,
    status: row.status,
    attempts: row.attempts,
    response_status: row.responseStatus ?? null,
    next_attempt_at: row.nextAttemptAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

export interface AuditLogEntryWire {
  id: string;
  actor: AuthorRef | null;
  actor_type: "human" | "agent" | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export function auditLogEntryWire(row: AuditLogRow, actor: AuthorRef | null): AuditLogEntryWire {
  return {
    id: row.id,
    actor,
    actor_type: actor?.author_type ?? null,
    action: row.action,
    target_type: row.targetType,
    target_id: row.targetId,
    metadata: {
      ...((row.metadata as Record<string, unknown> | null) ?? {}),
      ...(row.apiKeyId ? { api_key_id: row.apiKeyId } : {}),
      ...(row.authMethod ? { auth_method: row.authMethod } : {}),
    },
    created_at: row.createdAt.toISOString(),
  };
}
