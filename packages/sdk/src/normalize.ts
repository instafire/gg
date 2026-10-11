/**
 * Wire → view normalization.
 *
 * The API wire format is docs/API_SPEC.yaml: snake_case fields and
 * `{ data, page: { next_cursor, has_more } }` list envelopes. These helpers
 * convert wire payloads into the SDK's camelCase view types. Reads are
 * deliberately tolerant (snake_case first, camelCase fallback) so the client
 * keeps working if a route emits @gg/shared DTO naming directly.
 */
import type { AuthorType, CursorPage, TrustTier } from "@gg/shared";
import type {
  AgentProfileView,
  AnalyticsDayPoint,
  AnalyticsOverviewView,
  ApiKeyCreatedView,
  ApiScope,
  ArgumentView,
  AuditLogEntryView,
  AutomodRuleView,
  AuthorView,
  CommunityView,
  ContextNoteView,
  CurrentUserView,
  DebateStateView,
  DebateView,
  LinkCardView,
  MediaView,
  MembershipRequestView,
  MembershipView,
  ModActionView,
  ModQueueItemView,
  NotificationPreferencesView,
  NotificationType,
  NotificationView,
  OAuthClientCreatedView,
  OAuthTokenView,
  OnboardingSuggestedView,
  PollResultsView,
  PollView,
  PostView,
  ProfileView,
  PushSubscriptionView,
  QuietHours,
  ReportReason,
  ReportStatus,
  CollectionView,
  ConversationView,
  ListView,
  MessageView,
  ReportView,
  SearchResultsView,
  SearchSuggestion,
  StoryGroupView,
  StoryView,
  TokenPairView,
  TrendingView,
  UploadSessionView,
  UserSettingsView,
  VoteBreakdown,
  VoteSummaryView,
  WebhookCreatedView,
  WebhookDeliveryView,
  WebhookEventType,
} from "./types";

export type Wire = Record<string, unknown>;

export function isWire(value: unknown): value is Wire {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(wire: Wire, ...keys: string[]): unknown {
  for (const key of keys) {
    if (wire[key] !== undefined) return wire[key];
  }
  return undefined;
}

function str(wire: Wire, ...keys: string[]): string | null {
  const value = pick(wire, ...keys);
  return typeof value === "string" ? value : null;
}

function reqStr(wire: Wire, fallback: string, ...keys: string[]): string {
  return str(wire, ...keys) ?? fallback;
}

function num(wire: Wire, ...keys: string[]): number | null {
  const value = pick(wire, ...keys);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function reqNum(wire: Wire, fallback: number, ...keys: string[]): number {
  return num(wire, ...keys) ?? fallback;
}

function bool(wire: Wire, ...keys: string[]): boolean {
  return pick(wire, ...keys) === true;
}

function strArray(wire: Wire, ...keys: string[]): string[] {
  const value = pick(wire, ...keys);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Normalize a `{ data, page }` envelope (or a legacy `{ items, nextCursor }`) into a CursorPage. */
export function normalizePage<T>(raw: unknown, mapItem: (item: Wire) => T): CursorPage<T> {
  if (!isWire(raw)) return { items: [], nextCursor: null };
  const data = raw["data"];
  if (Array.isArray(data)) {
    const page = isWire(raw["page"]) ? raw["page"] : {};
    const nextCursor = page["next_cursor"] ?? page["nextCursor"] ?? null;
    return {
      items: data.filter(isWire).map(mapItem),
      nextCursor: typeof nextCursor === "string" ? nextCursor : null,
    };
  }
  const items = raw["items"];
  if (Array.isArray(items)) {
    const nextCursor = raw["nextCursor"] ?? raw["next_cursor"] ?? null;
    return {
      items: items.filter(isWire).map(mapItem),
      nextCursor: typeof nextCursor === "string" ? nextCursor : null,
    };
  }
  return { items: [], nextCursor: null };
}

export function normalizeAuthor(raw: unknown): AuthorView {
  const wire = isWire(raw) ? raw : {};
  const authorType = str(wire, "author_type", "authorType");
  return {
    id: reqStr(wire, "", "id"),
    handle: reqStr(wire, "", "handle"),
    displayName: reqStr(wire, "", "display_name", "displayName"),
    avatarUrl: str(wire, "avatar_url", "avatarUrl"),
    authorType: (authorType === "agent" ? "agent" : "human") as AuthorType,
    trustTier: (str(wire, "trust_tier", "trustTier") ?? "T0") as TrustTier,
    isAgentBadge:
      bool(wire, "is_verified_agent", "isVerifiedAgent") || authorType === "agent",
  };
}

function normalizeLinkCard(raw: unknown): LinkCardView | null {
  if (!isWire(raw)) return null;
  const url = str(raw, "url");
  if (!url) return null;
  return {
    url,
    title: str(raw, "title"),
    description: str(raw, "description"),
    imageUrl: str(raw, "image_url", "imageUrl"),
  };
}

function normalizeMediaItem(item: Wire): MediaView {
  const variantsRaw = item["variants"];
  let variants: MediaView["variants"] = null;
  if (isWire(variantsRaw)) {
    variants = {};
    for (const [name, entry] of Object.entries(variantsRaw)) {
      if (!isWire(entry)) continue;
      variants[name] = {
        url: reqStr(entry, "", "url"),
        width: num(entry, "width"),
        height: num(entry, "height"),
        format: reqStr(entry, "", "format"),
      };
    }
  }
  const captionsRaw = item["captions"];
  const captions = Array.isArray(captionsRaw)
    ? captionsRaw.filter(isWire).map((track) => ({
        lang: reqStr(track, "", "lang"),
        label: str(track, "label") ?? reqStr(track, "", "lang"),
        url: reqStr(track, "", "url"),
      }))
    : [];
  // The API nests hls_url / thumbnail_url inside `variants` for video.
  const variantsWire = isWire(item["variants"]) ? item["variants"] : null;
  return {
    id: reqStr(item, "", "id"),
    kind: reqStr(item, "image", "kind"),
    url: str(item, "url"),
    altText: str(item, "alt_text", "altText"),
    width: num(item, "width"),
    height: num(item, "height"),
    status: reqStr(item, "ready", "status"),
    durationMs: num(item, "duration_ms", "durationMs"),
    blurhash: str(item, "blurhash"),
    variants,
    hlsUrl:
      str(item, "hls_url", "hlsUrl") ??
      (variantsWire ? str(variantsWire, "hls_url") : null),
    thumbnailUrl:
      str(item, "thumbnail_url", "thumbnailUrl") ??
      (variantsWire ? str(variantsWire, "thumbnail_url") : null),
    captions,
  };
}

export function normalizeMediaObject(raw: unknown): MediaView {
  return normalizeMediaItem(isWire(raw) ? raw : {});
}

function normalizeMedia(raw: unknown): MediaView[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isWire).map(normalizeMediaItem);
}

export function normalizeUploadSession(raw: unknown): UploadSessionView {
  const wire = isWire(raw) ? raw : {};
  return {
    mediaId: reqStr(wire, "", "media_id", "mediaId"),
    status: reqStr(wire, "uploading", "status"),
    tusUrl: reqStr(wire, "", "tus_url", "tusUrl"),
    signedPutUrl: str(wire, "signed_put_url", "signedPutUrl"),
    offset: reqNum(wire, 0, "offset"),
    length: reqNum(wire, 0, "length"),
    expiresAt: str(wire, "expires_at", "expiresAt"),
  };
}

export function normalizeStory(raw: unknown): StoryView {
  const wire = isWire(raw) ? raw : {};
  const stickersRaw = wire["stickers"];
  const stickers = Array.isArray(stickersRaw)
    ? stickersRaw.filter(isWire).map((sticker) => ({
        kind: reqStr(sticker, "text", "kind"),
        pollId: str(sticker, "poll_id", "pollId") ?? undefined,
        text: str(sticker, "text") ?? undefined,
        x: num(sticker, "x") ?? undefined,
        y: num(sticker, "y") ?? undefined,
      }))
    : [];
  return {
    id: reqStr(wire, "", "id"),
    author: normalizeAuthor(wire["author"]),
    media: normalizeMediaObject(wire["media"]),
    audience: reqStr(wire, "everyone", "audience"),
    stickers,
    musicRef: str(wire, "music_ref", "musicRef"),
    expiresAt: reqStr(wire, "", "expires_at", "expiresAt"),
    createdAt: reqStr(wire, "", "created_at", "createdAt"),
    viewCount: reqNum(wire, 0, "view_count", "viewCount"),
    viewerHasSeen: bool(wire, "viewer_has_seen", "viewerHasSeen"),
  };
}

export function normalizeStoryGroup(raw: unknown): StoryGroupView {
  const wire = isWire(raw) ? raw : {};
  const storiesRaw = wire["stories"];
  return {
    author: normalizeAuthor(wire["author"]),
    stories: Array.isArray(storiesRaw) ? storiesRaw.map(normalizeStory) : [],
    hasUnseen: bool(wire, "has_unseen", "hasUnseen"),
  };
}

export function normalizeVoteBreakdown(raw: unknown): VoteBreakdown | null {
  if (!isWire(raw)) return null;
  // Nested shape: { human: { up, down }, agent: { up, down } }
  const human = raw["human"];
  const agent = raw["agent"];
  if (isWire(human) && isWire(agent)) {
    return {
      humanUp: reqNum(human, 0, "up", "up_count", "upCount"),
      humanDown: reqNum(human, 0, "down", "down_count", "downCount"),
      agentUp: reqNum(agent, 0, "up", "up_count", "upCount"),
      agentDown: reqNum(agent, 0, "down", "down_count", "downCount"),
    };
  }
  // Flat shape: { human_up, human_down, agent_up, agent_down }
  const flat = {
    humanUp: num(raw, "human_up", "humanUp"),
    humanDown: num(raw, "human_down", "humanDown"),
    agentUp: num(raw, "agent_up", "agentUp"),
    agentDown: num(raw, "agent_down", "agentDown"),
  };
  if (
    flat.humanUp === null &&
    flat.humanDown === null &&
    flat.agentUp === null &&
    flat.agentDown === null
  ) {
    return null;
  }
  return {
    humanUp: flat.humanUp ?? 0,
    humanDown: flat.humanDown ?? 0,
    agentUp: flat.agentUp ?? 0,
    agentDown: flat.agentDown ?? 0,
  };
}

export function normalizePost(raw: unknown): PostView {
  const wire = isWire(raw) ? raw : {};
  const author = normalizeAuthor(wire["author"]);
  const communityRaw = wire["community"];
  const community = isWire(communityRaw)
    ? {
        id: reqStr(communityRaw, "", "id"),
        slug: reqStr(communityRaw, "", "slug"),
        name: reqStr(communityRaw, "", "name"),
      }
    : null;
  const flairRaw = wire["flair"];
  const viewerState = isWire(wire["viewer_state"])
    ? wire["viewer_state"]
    : isWire(wire["viewerState"])
      ? wire["viewerState"]
      : {};
  const viewerVote = str(viewerState, "vote") ?? str(wire, "viewer_vote", "viewerVote");
  return {
    id: reqStr(wire, "", "id"),
    shortCode: str(wire, "short_code", "shortCode"),
    author,
    authorType: author.authorType,
    type: (str(wire, "type") ?? "TEXT") as PostView["type"],
    body: reqStr(wire, "", "body_md", "body"),
    title: str(wire, "title"),
    community,
    communityId: community?.id ?? str(wire, "community_id", "communityId"),
    parentId: str(wire, "parent_id", "parentId"),
    rootId: str(wire, "root_id", "rootId"),
    depth: reqNum(wire, 0, "depth"),
    media: normalizeMedia(wire["media"]),
    linkCard: normalizeLinkCard(wire["link_card"] ?? wire["linkCard"]),
    flair:
      typeof flairRaw === "string"
        ? flairRaw
        : isWire(flairRaw)
          ? str(flairRaw, "name", "label")
          : null,
    visibility: reqStr(wire, "public", "visibility"),
    isNsfw: bool(wire, "is_nsfw", "isNsfw"),
    isSpoiler: bool(wire, "is_spoiler", "isSpoiler"),
    isPinned: bool(wire, "is_pinned", "isPinned"),
    isFeatured: bool(wire, "is_featured", "isFeatured"),
    isHeld: bool(wire, "is_held", "isHeld"),
    score: reqNum(wire, 0, "score"),
    upCount: reqNum(wire, 0, "up_count", "upCount", "upvotes"),
    downCount: num(wire, "down_count", "downCount", "downvotes"),
    replyCount: reqNum(wire, 0, "reply_count", "replyCount"),
    repostCount: reqNum(wire, 0, "repost_count", "repostCount"),
    quoteCount: reqNum(wire, 0, "quote_count", "quoteCount"),
    viewCount: reqNum(wire, 0, "view_count", "viewCount"),
    viewerVote: viewerVote === "up" || viewerVote === "down" ? viewerVote : null,
    viewerBookmarked:
      bool(viewerState, "bookmarked") || bool(wire, "viewer_bookmarked", "viewerBookmarked"),
    reactionCounts: (() => {
      const counts = wire["reaction_counts"] ?? wire["reactionCounts"];
      if (!isWire(counts)) return {};
      const out: Record<string, number> = {};
      for (const [key, value] of Object.entries(counts)) {
        if (typeof value === "number") out[key] = value;
      }
      return out;
    })(),
    viewerReactions: Array.isArray(viewerState["reactions"])
      ? (viewerState["reactions"] as unknown[]).filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    voteBreakdown: normalizeVoteBreakdown(
      wire["vote_breakdown"] ?? wire["voteBreakdown"] ?? wire["tally_breakdown"],
    ),
    whyReasons: null,
    poll: isWire(wire["poll"]) ? normalizePoll(wire["poll"]) : null,
    debate: isWire(wire["debate"]) ? normalizeDebate(wire["debate"]) : null,
    scheduledFor: str(wire, "scheduled_for", "scheduledFor"),
    createdAt: reqStr(wire, "", "created_at", "createdAt"),
    editedAt: str(wire, "edited_at", "editedAt"),
    deletedAt: str(wire, "deleted_at", "deletedAt"),
    removed: bool(wire, "removed"),
  };
}

/** Normalize a feed item envelope `{ post, why }`; plain posts pass through. */
export function normalizeFeedItem(raw: unknown): PostView {
  if (isWire(raw) && isWire(raw["post"])) {
    const post = normalizePost(raw["post"]);
    const why = isWire(raw["why"]) ? raw["why"] : null;
    if (why) {
      const reasons = why["reasons"];
      if (Array.isArray(reasons)) {
        post.whyReasons = reasons.filter(
          (item): item is string => typeof item === "string",
        );
      }
    }
    return post;
  }
  return normalizePost(raw);
}

export function normalizeVoteSummary(raw: unknown): VoteSummaryView {
  const wire = isWire(raw) ? raw : {};
  const viewerVote = str(wire, "viewer_vote", "viewerVote");
  return {
    upCount: reqNum(wire, 0, "up_count", "upCount"),
    downCount: num(wire, "down_count", "downCount"),
    score: reqNum(wire, 0, "score"),
    viewerVote: viewerVote === "up" || viewerVote === "down" ? viewerVote : null,
    breakdown: normalizeVoteBreakdown(
      wire["vote_breakdown"] ?? wire["breakdown"] ?? wire["voteBreakdown"],
    ),
  };
}

export function normalizeProfile(raw: unknown): ProfileView {
  const wire = isWire(raw) ? raw : {};
  const viewerRaw = isWire(wire["viewer_state"])
    ? wire["viewer_state"]
    : isWire(wire["viewerState"])
      ? wire["viewerState"]
      : null;
  return {
    userId: reqStr(wire, "", "user_id", "userId", "id"),
    handle: reqStr(wire, "", "handle"),
    displayName: reqStr(wire, "", "display_name", "displayName"),
    bio: str(wire, "bio"),
    avatarUrl: str(wire, "avatar_url", "avatarUrl"),
    bannerUrl: str(wire, "banner_url", "bannerUrl"),
    websiteUrl: str(wire, "website_url", "websiteUrl"),
    location: str(wire, "location"),
    authorType: (str(wire, "author_type", "authorType") === "agent"
      ? "agent"
      : "human") as AuthorType,
    trustTier: (str(wire, "trust_tier", "trustTier") ?? "T0") as TrustTier,
    isPrivate: bool(wire, "is_private", "isPrivate"),
    followerCount: reqNum(wire, 0, "follower_count", "followerCount"),
    followingCount: reqNum(wire, 0, "following_count", "followingCount"),
    debateRating: num(wire, "debate_rating", "debateRating"),
    debateRecord: (() => {
      const record = wire["debate_record"] ?? wire["debateRecord"];
      if (!isWire(record)) return null;
      return {
        wins: reqNum(record, 0, "wins"),
        losses: reqNum(record, 0, "losses"),
        draws: reqNum(record, 0, "draws"),
      };
    })(),
    viewerState: viewerRaw
      ? {
          isSelf: bool(viewerRaw, "is_self", "isSelf"),
          isFollowing: bool(viewerRaw, "is_following", "isFollowing"),
          isFollowedBy: bool(viewerRaw, "is_followed_by", "isFollowedBy"),
          isBlocked: bool(viewerRaw, "is_blocked", "isBlocked"),
          isMuted: bool(viewerRaw, "is_muted", "isMuted"),
        }
      : null,
  };
}

export function normalizeCurrentUser(raw: unknown): CurrentUserView {
  const wire = isWire(raw) ? raw : {};
  return {
    id: reqStr(wire, "", "id"),
    handle: reqStr(wire, "", "handle"),
    email: str(wire, "email"),
    emailVerified: bool(wire, "email_verified", "emailVerified"),
    authorType: (str(wire, "author_type", "authorType") === "agent"
      ? "agent"
      : "human") as AuthorType,
    trustTier: (str(wire, "trust_tier", "trustTier") ?? "T0") as TrustTier,
    ageBracket: str(wire, "age_bracket", "ageBracket"),
    status: str(wire, "status"),
    profile: normalizeProfile(wire["profile"]),
    onboardingCompletedAt: str(
      wire,
      "onboarding_completed_at",
      "onboardingCompletedAt",
    ),
    platformRole: reqStr(wire, "user", "platform_role", "platformRole"),
  };
}

export function normalizeTokenPair(raw: unknown): TokenPairView | null {
  if (!isWire(raw)) return null;
  const accessToken = str(raw, "access_token", "accessToken");
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: reqStr(raw, "", "refresh_token", "refreshToken"),
    tokenType: reqStr(raw, "Bearer", "token_type", "tokenType"),
    expiresIn: reqNum(raw, 0, "expires_in", "expiresIn"),
  };
}

export function normalizeCommunity(raw: unknown): CommunityView {
  const wire = isWire(raw) ? raw : {};
  const membership = isWire(wire["viewer_membership"])
    ? wire["viewer_membership"]
    : isWire(wire["viewerMembership"])
      ? wire["viewerMembership"]
      : null;
  return {
    id: reqStr(wire, "", "id"),
    slug: reqStr(wire, "", "slug"),
    name: reqStr(wire, "", "name"),
    description: str(wire, "description"),
    iconUrl: str(wire, "icon_url", "iconUrl"),
    bannerUrl: str(wire, "banner_url", "bannerUrl"),
    visibility: reqStr(wire, "public", "visibility"),
    isNsfw: bool(wire, "is_nsfw", "isNsfw"),
    memberCount: reqNum(wire, 0, "member_count", "memberCount"),
    postCount: reqNum(wire, 0, "post_count", "postCount"),
    topics: strArray(wire, "topics"),
    viewerMembership: membership
      ? {
          role: reqStr(membership, "member", "role"),
          status: reqStr(membership, "active", "status"),
        }
      : null,
    lockdownActive: bool(wire, "lockdown_active", "lockdownActive"),
    createdAt: str(wire, "created_at", "createdAt"),
  };
}

export function normalizeMembership(raw: unknown): MembershipView {
  const wire = isWire(raw) ? raw : {};
  return {
    communityId: reqStr(wire, "", "community_id", "communityId"),
    role: reqStr(wire, "member", "role"),
    status: reqStr(wire, "active", "status"),
  };
}

// ─── Round 2: notifications, search, onboarding, settings ───────────────────

function boolRecord(raw: unknown): Record<string, boolean> {
  if (!isWire(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

function normalizeQuietHours(raw: unknown): QuietHours | null {
  if (!isWire(raw)) return null;
  const start = str(raw, "start");
  const end = str(raw, "end");
  return start && end ? { start, end } : null;
}

export function normalizeNotification(raw: unknown): NotificationView {
  const wire = isWire(raw) ? raw : {};
  const actorRaw = wire["actor"];
  return {
    id: reqStr(wire, "", "id"),
    type: (str(wire, "type") ?? "system") as NotificationType,
    actor: isWire(actorRaw) ? normalizeAuthor(actorRaw) : null,
    subjectType: str(wire, "subject_type", "subjectType"),
    subjectId: str(wire, "subject_id", "subjectId"),
    payload: isWire(wire["payload"]) ? (wire["payload"] as Record<string, unknown>) : {},
    groupCount: reqNum(wire, 1, "group_count", "groupCount"),
    readAt: str(wire, "read_at", "readAt"),
    createdAt: reqStr(wire, "", "created_at", "createdAt"),
  };
}

export function normalizeNotificationPreferences(
  raw: unknown,
): NotificationPreferencesView {
  const wire = isWire(raw) ? raw : {};
  return {
    prefs: boolRecord(wire["notification_prefs"] ?? wire["prefs"]),
    quietHours: normalizeQuietHours(wire["quiet_hours"] ?? wire["quietHours"]),
    types: strArray(wire, "types"),
  };
}

export function normalizeSearchResults(raw: unknown): SearchResultsView {
  const wire = isWire(raw) ? raw : {};
  const hashtagsRaw = wire["hashtags"];
  return {
    posts: normalizePage(wire["posts"], normalizePost),
    people: normalizePage(wire["people"], normalizeProfile),
    communities: normalizePage(wire["communities"], normalizeCommunity),
    hashtags: Array.isArray(hashtagsRaw)
      ? hashtagsRaw.filter(isWire).map((tag) => ({
          tag: reqStr(tag, "", "tag"),
          postCount: reqNum(tag, 0, "post_count", "postCount"),
        }))
      : [],
    semanticApplied: bool(wire, "semantic_applied", "semanticApplied"),
  };
}

export function normalizeSearchSuggestions(raw: unknown): SearchSuggestion[] {
  const wire = isWire(raw) ? raw : {};
  const data = wire["data"];
  if (!Array.isArray(data)) return [];
  return data.filter(isWire).map((item) => ({
    kind: str(item, "kind") === "community" ? ("community" as const) : ("user" as const),
    label: reqStr(item, "", "label"),
    id: reqStr(item, "", "id"),
  }));
}

export function normalizeOnboardingSuggested(raw: unknown): OnboardingSuggestedView {
  const wire = isWire(raw) ? raw : {};
  const communities = wire["communities"];
  const accounts = wire["accounts"];
  return {
    communities: Array.isArray(communities)
      ? communities.filter(isWire).map(normalizeCommunity)
      : [],
    accounts: Array.isArray(accounts)
      ? accounts.filter(isWire).map(normalizeProfile)
      : [],
    topics: strArray(wire, "topics"),
  };
}

export function normalizeSettings(raw: unknown): UserSettingsView {
  const wire = isWire(raw) ? raw : {};
  const preferences = wire["preferences"];
  return {
    hideAiAccounts: bool(wire, "hide_ai_accounts", "hideAiAccounts"),
    hideNsfw: bool(wire, "hide_nsfw", "hideNsfw"),
    dmPolicy: reqStr(wire, "everyone", "dm_policy", "dmPolicy"),
    mentionPolicy: reqStr(wire, "everyone", "mention_policy", "mentionPolicy"),
    readReceipts: bool(wire, "read_receipts", "readReceipts"),
    presenceVisible: bool(wire, "presence_visible", "presenceVisible"),
    captionsDefaultOn: bool(wire, "captions_default_on", "captionsDefaultOn"),
    fontScale: reqNum(wire, 1, "font_scale", "fontScale"),
    highContrast: bool(wire, "high_contrast", "highContrast"),
    reducedMotion: bool(wire, "reduced_motion", "reducedMotion"),
    demographicBreakdownsOptIn: bool(
      wire,
      "demographic_breakdowns_opt_in",
      "demographicBreakdownsOptIn",
    ),
    language: reqStr(wire, "en", "language"),
    notificationPrefs: boolRecord(
      wire["notification_prefs"] ?? wire["notificationPrefs"],
    ),
    pushPrefs: boolRecord(wire["push_prefs"] ?? wire["pushPrefs"]),
    digestFrequency: reqStr(wire, "off", "digest_frequency", "digestFrequency"),
    quietHours: normalizeQuietHours(wire["quiet_hours"] ?? wire["quietHours"]),
    preferences: isWire(preferences) ? preferences : {},
    isPrivate: bool(wire, "is_private", "isPrivate"),
  };
}

export function normalizeReport(raw: unknown): ReportView {
  const wire = isWire(raw) ? raw : {};
  return {
    id: reqStr(wire, "", "id"),
    targetType: reqStr(wire, "", "target_type", "targetType"),
    targetId: reqStr(wire, "", "target_id", "targetId"),
    reason: (str(wire, "reason") ?? "other") as ReportReason,
    status: (str(wire, "status") ?? "open") as ReportStatus,
    resolution: str(wire, "resolution"),
    createdAt: reqStr(wire, "", "created_at", "createdAt"),
  };
}

export function normalizeModQueueItem(raw: unknown): ModQueueItemView {
  const wire = isWire(raw) ? raw : {};
  const postRaw = wire["post"];
  const ruleRaw = wire["automod_rule"] ?? wire["automodRule"];
  return {
    id: reqStr(wire, "", "id"),
    kind: str(wire, "kind") === "held" ? "held" : "report",
    severity: reqNum(wire, 2, "severity"),
    report: normalizeReport(wire["report"]),
    post: isWire(postRaw) ? normalizePost(postRaw) : null,
    automodRule: isWire(ruleRaw)
      ? {
          id: str(ruleRaw, "id"),
          kind: reqStr(ruleRaw, "", "kind"),
          action: reqStr(ruleRaw, "", "action"),
          detail: str(ruleRaw, "detail"),
        }
      : null,
    createdAt: reqStr(wire, "", "created_at", "createdAt"),
  };
}

// ─── Phase 5B normalizers ────────────────────────────────────────────────────

export function normalizeAutomodRule(raw: unknown): AutomodRuleView {
  const wire = isWire(raw) ? raw : {};
  const config = wire["config"];
  return {
    id: reqStr(wire, "", "id"),
    communityId: reqStr(wire, "", "community_id", "communityId"),
    kind: reqStr(wire, "keyword", "kind") as AutomodRuleView["kind"],
    config: isWire(config) ? config : {},
    action: reqStr(wire, "flag", "action") as AutomodRuleView["action"],
    isEnabled: bool(wire, "is_enabled", "isEnabled"),
    createdBy: reqStr(wire, "", "created_by", "createdBy"),
    createdAt: reqStr(wire, "", "created_at", "createdAt"),
    updatedAt: reqStr(wire, "", "updated_at", "updatedAt"),
  };
}

export function normalizeModAction(raw: unknown): ModActionView {
  const wire = isWire(raw) ? raw : {};
  return {
    id: reqStr(wire, "", "id"),
    communityId: reqStr(wire, "", "community_id", "communityId"),
    actorId: reqStr(wire, "", "actor_id", "actorId"),
    action: reqStr(wire, "", "action"),
    targetType: str(wire, "target_type", "targetType"),
    targetId: str(wire, "target_id", "targetId"),
    note: str(wire, "note"),
    createdAt: reqStr(wire, "", "created_at", "createdAt"),
  };
}

export function normalizeMembershipRequest(raw: unknown): MembershipRequestView {
  const wire = isWire(raw) ? raw : {};
  return {
    id: reqStr(wire, "", "id"),
    communityId: reqStr(wire, "", "community_id", "communityId"),
    user: normalizeAuthor(wire["user"]),
    role: reqStr(wire, "member", "role"),
    status: reqStr(wire, "pending", "status"),
    mutedUntil: str(wire, "muted_until", "mutedUntil"),
    joinedAt: reqStr(wire, "", "joined_at", "joinedAt"),
  };
}

export function normalizePushSubscription(raw: unknown): PushSubscriptionView {
  const wire = isWire(raw) ? raw : {};
  return {
    id: reqStr(wire, "", "id"),
    endpoint: reqStr(wire, "", "endpoint"),
    createdAt: reqStr(wire, "", "created_at", "createdAt"),
  };
}

export function normalizeAnalyticsOverview(raw: unknown): AnalyticsOverviewView {
  const wire = isWire(raw) ? raw : {};
  const num = (obj: unknown, ...keys: string[]): number => {
    if (!isWire(obj)) return 0;
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === "number") return value;
    }
    return 0;
  };
  const nullableNum = (obj: unknown, key: string): number | null => {
    if (!isWire(obj)) return null;
    const value = obj[key];
    return typeof value === "number" ? value : null;
  };
  const series = (value: unknown): AnalyticsDayPoint[] =>
    Array.isArray(value)
      ? value.filter(isWire).map((point) => ({
          date: reqStr(point, "", "date"),
          ...(typeof point["posts"] === "number" ? { posts: point["posts"] } : {}),
          ...(typeof point["events"] === "number" ? { events: point["events"] } : {}),
          ...(typeof point["dau"] === "number" ? { dau: point["dau"] } : {}),
        }))
      : [];
  const newUsers = wire["new_users"];
  const debates = wire["debates"];
  const moderation = wire["moderation"];
  const split = wire["activity_split"];
  return {
    windowDays: num(wire, "window_days", "windowDays") || 30,
    generatedAt: reqStr(wire, "", "generated_at", "generatedAt"),
    dauToday: num(wire, "dau_today", "dauToday"),
    mau: num(wire, "mau"),
    newUsers: {
      today: num(newUsers, "today"),
      last7d: num(newUsers, "last_7d", "last7d"),
      last30d: num(newUsers, "last_30d", "last30d"),
    },
    postsPerDay: num(wire, "posts_per_day", "postsPerDay"),
    postsSeries: series(wire["posts_series"]),
    dauSeries: series(wire["dau_series"]),
    debates: {
      started: num(debates, "started"),
      completed: num(debates, "completed"),
      completionRate: nullableNum(debates, "completion_rate"),
      mindChangeRate: nullableNum(debates, "mind_change_rate"),
    },
    moderation: {
      reportsTotal: num(moderation, "reports_total"),
      resolvedCount: num(moderation, "resolved_count"),
      pendingCount: num(moderation, "pending_count"),
      reportRatePer100Posts: nullableNum(moderation, "report_rate_per_100_posts"),
      avgTimeToModerationHours: nullableNum(moderation, "avg_time_to_moderation_hours"),
    },
    activitySplit: {
      humanEvents: num(split, "human_events"),
      agentEvents: num(split, "agent_events"),
      humanUsers: num(split, "human_users"),
      agentUsers: num(split, "agent_users"),
    },
  };
}

// ─── Phase 3: polls / debates / notes ────────────────────────────────────────

function numberRecord(raw: unknown): Record<string, number> {
  if (!isWire(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number") out[key] = value;
  }
  return out;
}

function normalizePollOption(raw: unknown): PollView["options"][number] {
  const wire = isWire(raw) ? raw : {};
  return {
    id: reqStr(wire, "", "id"),
    position: reqNum(wire, 0, "position"),
    text: str(wire, "text"),
    media: isWire(wire["media"]) ? normalizeMediaObject(wire["media"]) : null,
    humanVotes: reqNum(wire, 0, "human_votes", "humanVotes"),
    agentVotes: reqNum(wire, 0, "agent_votes", "agentVotes"),
    share: reqNum(wire, 0, "share"),
  };
}

function normalizeBallot(raw: unknown): PollView["viewerBallot"] {
  if (!isWire(raw)) return null;
  const ranking = raw["ranking"];
  const optionIds = raw["option_ids"] ?? raw["optionIds"];
  return {
    optionId: str(raw, "option_id", "optionId"),
    optionIds: Array.isArray(optionIds)
      ? optionIds.filter((item): item is string => typeof item === "string")
      : [],
    ranking: Array.isArray(ranking)
      ? ranking.filter((item): item is string => typeof item === "string")
      : null,
    sliderValue: num(raw, "slider_value", "sliderValue"),
  };
}

export function normalizePoll(raw: unknown): PollView {
  const wire = isWire(raw) ? raw : {};
  const options = Array.isArray(wire["options"]) ? wire["options"] : [];
  return {
    id: reqStr(wire, "", "id"),
    postId: reqStr(wire, "", "post_id", "postId"),
    type: (str(wire, "type") ?? "single") as PollView["type"],
    question: reqStr(wire, "", "question"),
    options: options.map(normalizePollOption),
    resultMode: (str(wire, "result_mode", "resultMode") ?? "live") as PollView["resultMode"],
    resultsVisible: bool(wire, "results_visible", "resultsVisible"),
    isAnonymous: bool(wire, "is_anonymous", "isAnonymous"),
    isDailyPulse: bool(wire, "is_daily_pulse", "isDailyPulse"),
    minTrustTier: (str(wire, "min_trust_tier", "minTrustTier") ?? "T1") as PollView["minTrustTier"],
    totalVotes: reqNum(wire, 0, "total_votes", "totalVotes"),
    agentTotalVotes: reqNum(wire, 0, "agent_total_votes", "agentTotalVotes"),
    closesAt: str(wire, "closes_at", "closesAt"),
    isClosed: bool(wire, "is_closed", "isClosed"),
    voided: bool(wire, "voided"),
    viewerBallot: normalizeBallot(wire["viewer_ballot"] ?? wire["viewerBallot"]),
  };
}

export function normalizePollResults(raw: unknown): PollResultsView {
  const wire = isWire(raw) ? raw : {};
  const options = Array.isArray(wire["options"]) ? wire["options"] : [];
  const breakdowns = isWire(wire["breakdowns"]) ? wire["breakdowns"] : {};
  const rounds = Array.isArray(wire["irv_rounds"]) ? wire["irv_rounds"] : [];
  return {
    pollId: reqStr(wire, "", "poll_id", "pollId"),
    options: options.map(normalizePollOption),
    totalVotes: reqNum(wire, 0, "total_votes", "totalVotes"),
    agentTotalVotes: reqNum(wire, 0, "agent_total_votes", "agentTotalVotes"),
    winnerOptionId: str(wire, "winner_option_id", "winnerOptionId"),
    irvRounds: rounds.filter(isWire).map((round) => ({
      round: reqNum(round, 0, "round"),
      tallies: numberRecord(round["tallies"]),
      eliminatedOptionId: str(round, "eliminated_option_id", "eliminatedOptionId"),
    })),
    breakdowns: {
      byTrustTier: numberRecord(breakdowns["by_trust_tier"] ?? breakdowns["byTrustTier"]),
      byAgeBracket: numberRecord(breakdowns["by_age_bracket"] ?? breakdowns["byAgeBracket"]),
    },
    viewerBallot: normalizeBallot(wire["viewer_ballot"] ?? wire["viewerBallot"]),
    stanceDistribution:
      wire["stance_distribution"] != null || wire["stanceDistribution"] != null
        ? numberRecord(wire["stance_distribution"] ?? wire["stanceDistribution"])
        : null,
  };
}

function normalizeDebateSide(raw: unknown): DebateView["sides"][number] {
  const wire = isWire(raw) ? raw : {};
  return {
    id: reqStr(wire, "", "id"),
    key: reqStr(wire, "", "key"),
    label: reqStr(wire, "", "label"),
    argumentCount: reqNum(wire, 0, "argument_count", "argumentCount"),
    humanArgumentVotes: reqNum(wire, 0, "human_argument_votes", "humanArgumentVotes"),
    agentArgumentVotes: reqNum(wire, 0, "agent_argument_votes", "agentArgumentVotes"),
  };
}

export function normalizeDebate(raw: unknown): DebateView {
  const wire = isWire(raw) ? raw : {};
  const sides = Array.isArray(wire["sides"]) ? wire["sides"] : [];
  const participants = Array.isArray(wire["participants"]) ? wire["participants"] : [];
  const rounds = Array.isArray(wire["rounds"]) ? wire["rounds"] : [];
  const formula = isWire(wire["winner_formula"]) ? wire["winner_formula"] : null;
  const mindChange = isWire(wire["mind_change"]) ? wire["mind_change"] : {};
  const communityRaw = wire["community"];
  return {
    id: reqStr(wire, "", "id"),
    shortCode: reqStr(wire, "", "short_code", "shortCode"),
    postId: reqStr(wire, "", "post_id", "postId"),
    proposition: reqStr(wire, "", "proposition"),
    format: (str(wire, "format") ?? "open") as DebateView["format"],
    status: (str(wire, "status") ?? "open") as DebateView["status"],
    host: normalizeAuthor(wire["host"]),
    judge: isWire(wire["judge"]) ? normalizeAuthor(wire["judge"]) : null,
    community: isWire(communityRaw)
      ? {
          id: reqStr(communityRaw, "", "id"),
          slug: reqStr(communityRaw, "", "slug"),
          name: reqStr(communityRaw, "", "name"),
        }
      : null,
    sourceArticleUrl: str(wire, "source_article_url", "sourceArticleUrl"),
    sides: sides.map(normalizeDebateSide),
    participants: participants.filter(isWire).map((p) => ({
      user: normalizeAuthor(p["user"]),
      sideKey: reqStr(p, "", "side_key", "sideKey"),
      role: reqStr(p, "debater", "role"),
      eloAtStart: num(p, "elo_at_start", "eloAtStart"),
    })),
    rounds: rounds.filter(isWire).map((r) => ({
      roundNo: reqNum(r, 0, "round_no", "roundNo"),
      kind: reqStr(r, "freeform", "kind"),
      sideKey: str(r, "side_key", "sideKey"),
      deadlineAt: str(r, "deadline_at", "deadlineAt"),
      status: reqStr(r, "pending", "status"),
      argumentId: str(r, "argument_id", "argumentId"),
    })),
    currentRound: num(wire, "current_round", "currentRound"),
    perTurnCharLimit: reqNum(wire, 2000, "per_turn_char_limit", "perTurnCharLimit"),
    turnDeadlineHours: num(wire, "turn_deadline_hours", "turnDeadlineHours"),
    winnerSideKey: str(wire, "winner_side_key", "winnerSideKey"),
    isDraw: bool(wire, "is_draw", "isDraw"),
    winnerFormula: formula
      ? {
          argumentVotes: reqNum(formula, 0, "argument_votes", "argumentVotes"),
          mindChange: reqNum(formula, 0, "mind_change", "mindChange"),
          evidenceQuality: reqNum(formula, 0, "evidence_quality", "evidenceQuality"),
        }
      : null,
    mindChange: {
      audiencePreCount: reqNum(mindChange, 0, "audience_pre_count", "audiencePreCount"),
      audiencePostCount: reqNum(mindChange, 0, "audience_post_count", "audiencePostCount"),
      mindChangedCount: reqNum(mindChange, 0, "mind_changed_count", "mindChangedCount"),
      mindChangeRate: reqNum(mindChange, 0, "mind_change_rate", "mindChangeRate"),
    },
    scheduledStartAt: str(wire, "scheduled_start_at", "scheduledStartAt"),
    closedAt: str(wire, "closed_at", "closedAt"),
    createdAt: reqStr(wire, "", "created_at", "createdAt"),
    viewerChallenge: isWire(wire["viewer_challenge"])
      ? { id: reqStr(wire["viewer_challenge"], "", "id") }
      : null,
    pendingJudge: wire["pending_judge"] === true || wire["pendingJudge"] === true,
  };
}

export function normalizeArgument(raw: unknown): ArgumentView {
  const wire = isWire(raw) ? raw : {};
  const evidence = Array.isArray(wire["evidence"]) ? wire["evidence"] : [];
  const flags = Array.isArray(wire["fallacy_flags"]) ? wire["fallacy_flags"] : [];
  const viewerState = isWire(wire["viewer_state"]) ? wire["viewer_state"] : {};
  const vote = str(viewerState, "vote") ?? str(wire, "viewer_vote", "viewerVote");
  return {
    id: reqStr(wire, "", "id"),
    debateId: reqStr(wire, "", "debate_id", "debateId"),
    sideKey: reqStr(wire, "", "side_key", "sideKey"),
    author: normalizeAuthor(wire["author"]),
    authorType: (str(wire, "author_type", "authorType") === "agent"
      ? "agent"
      : "human") as ArgumentView["authorType"],
    roundNo: num(wire, "round_no", "roundNo"),
    parentArgumentId: str(wire, "parent_argument_id", "parentArgumentId"),
    bodyMd: reqStr(wire, "", "body_md", "bodyMd"),
    bodyHtml: reqStr(wire, "", "body_html", "bodyHtml"),
    isSteelman: bool(wire, "is_steelman", "isSteelman"),
    steelmanConfirmed: bool(wire, "steelman_confirmed", "steelmanConfirmed"),
    evidence: evidence.filter(isWire).map((item) => ({
      id: reqStr(item, "", "id"),
      url: reqStr(item, "", "url"),
      kind: reqStr(item, "other", "kind"),
      quote: str(item, "quote"),
      domain: str(item, "domain"),
    })),
    fallacyFlags: flags.filter(isWire).map((flag) => ({
      fallacy: reqStr(flag, "", "fallacy"),
      confirmedByMod: bool(flag, "confirmed_by_mod", "confirmedByMod"),
    })),
    upCount: reqNum(wire, 0, "up_count", "upCount"),
    downCount: reqNum(wire, 0, "down_count", "downCount"),
    score: reqNum(wire, 0, "score"),
    voteBreakdown: normalizeVoteBreakdown(wire["vote_breakdown"] ?? wire["voteBreakdown"]),
    evidenceQuality: reqNum(wire, 0, "evidence_quality", "evidenceQuality"),
    createdAt: reqStr(wire, "", "created_at", "createdAt"),
    viewerVote: vote === "up" || vote === "down" ? vote : null,
  };
}

export function normalizeDebateState(raw: unknown): DebateStateView {
  const wire = isWire(raw) ? raw : {};
  const distribution = isWire(wire["stance_distribution"]) ? wire["stance_distribution"] : {};
  const viewerStance = isWire(wire["viewer_stance"]) ? wire["viewer_stance"] : null;
  const sides = Array.isArray(wire["sides"]) ? wire["sides"] : [];
  return {
    debateId: reqStr(wire, "", "debate_id", "debateId"),
    status: (str(wire, "status") ?? "open") as DebateStateView["status"],
    sides: sides.map(normalizeDebateSide),
    stanceDistribution: {
      pre: numberRecord(distribution["pre"]),
      post: numberRecord(distribution["post"]),
    },
    mindChangedCount: reqNum(wire, 0, "mind_changed_count", "mindChangedCount"),
    mindChangeRate: reqNum(wire, 0, "mind_change_rate", "mindChangeRate"),
    currentRound: num(wire, "current_round", "currentRound"),
    turnDeadlineAt: str(wire, "turn_deadline_at", "turnDeadlineAt"),
    viewerStance: viewerStance
      ? { pre: num(viewerStance, "pre"), post: num(viewerStance, "post") }
      : null,
  };
}

export function normalizeContextNote(raw: unknown): ContextNoteView {
  const wire = isWire(raw) ? raw : {};
  const sources = Array.isArray(wire["sources"]) ? wire["sources"] : [];
  return {
    id: reqStr(wire, "", "id"),
    postId: reqStr(wire, "", "post_id", "postId"),
    author: normalizeAuthor(wire["author"]),
    body: reqStr(wire, "", "body"),
    sources: sources.filter((item): item is string => typeof item === "string"),
    status: (str(wire, "status") ?? "pending") as ContextNoteView["status"],
    createdAt: reqStr(wire, "", "created_at", "createdAt"),
  };
}

// ─── Phase 4: agent platform ────────────────────────────────────────────────

export function normalizeAgentProfile(raw: unknown): AgentProfileView {
  const wire = isWire(raw) ? raw : {};
  return {
    userId: reqStr(wire, "", "user_id", "userId"),
    handle: reqStr(wire, "", "handle"),
    displayName: reqStr(wire, "", "display_name", "displayName"),
    avatarUrl: str(wire, "avatar_url", "avatarUrl"),
    purpose: reqStr(wire, "", "purpose"),
    owner: normalizeAuthor(wire["owner"]),
    modelProvider: str(wire, "model_provider", "modelProvider"),
    modelName: str(wire, "model_name", "modelName"),
    capabilities: strArray(wire, "capabilities"),
    homepageUrl: str(wire, "homepage_url", "homepageUrl"),
    rateTier: num(wire, "rate_tier", "rateTier") ?? 0,
    killSwitchEngaged: bool(wire, "kill_switch_engaged", "killSwitchEngaged"),
    autoDisclosure: reqStr(wire, "", "auto_disclosure", "autoDisclosure"),
    createdAt: reqStr(wire, "", "created_at", "createdAt"),
  };
}

export function normalizeApiKey(raw: unknown): ApiKeyCreatedView {
  const wire = isWire(raw) ? raw : {};
  return {
    id: reqStr(wire, "", "id"),
    name: reqStr(wire, "", "name"),
    keyPrefix: reqStr(wire, "", "key_prefix", "keyPrefix"),
    scopes: strArray(wire, "scopes") as ApiScope[],
    agentHandle: str(wire, "agent_handle", "agentHandle"),
    createdAt: reqStr(wire, "", "created_at", "createdAt"),
    lastUsedAt: str(wire, "last_used_at", "lastUsedAt"),
    expiresAt: str(wire, "expires_at", "expiresAt"),
    revokedAt: str(wire, "revoked_at", "revokedAt"),
    secret: reqStr(wire, "", "secret"),
  };
}

export function normalizeOAuthClient(raw: unknown): OAuthClientCreatedView {
  const wire = isWire(raw) ? raw : {};
  return {
    id: reqStr(wire, "", "id"),
    clientId: reqStr(wire, "", "client_id", "clientId"),
    name: reqStr(wire, "", "name"),
    redirectUris: strArray(wire, "redirect_uris", "redirectUris"),
    allowedScopes: strArray(wire, "allowed_scopes", "allowedScopes") as ApiScope[],
    isConfidential: bool(wire, "is_confidential", "isConfidential"),
    createdAt: reqStr(wire, "", "created_at", "createdAt"),
    clientSecret: str(wire, "client_secret", "clientSecret"),
  };
}

export function normalizeOAuthToken(raw: unknown): OAuthTokenView {
  const wire = isWire(raw) ? raw : {};
  return {
    accessToken: reqStr(wire, "", "access_token", "accessToken"),
    tokenType: reqStr(wire, "Bearer", "token_type", "tokenType"),
    expiresIn: num(wire, "expires_in", "expiresIn") ?? 0,
    scope: reqStr(wire, "", "scope"),
  };
}

export function normalizeWebhook(raw: unknown): WebhookCreatedView {
  const wire = isWire(raw) ? raw : {};
  return {
    id: reqStr(wire, "", "id"),
    url: reqStr(wire, "", "url"),
    events: strArray(wire, "events") as WebhookEventType[],
    isActive: bool(wire, "is_active", "isActive"),
    failureStreak: num(wire, "failure_streak", "failureStreak") ?? 0,
    createdAt: reqStr(wire, "", "created_at", "createdAt"),
    updatedAt: reqStr(wire, "", "updated_at", "updatedAt"),
    secret: reqStr(wire, "", "secret"),
  };
}

export function normalizeWebhookDelivery(raw: unknown): WebhookDeliveryView {
  const wire = isWire(raw) ? raw : {};
  return {
    id: reqStr(wire, "", "id"),
    event: reqStr(wire, "", "event"),
    status: reqStr(wire, "pending", "status"),
    attempts: num(wire, "attempts") ?? 0,
    responseStatus: num(wire, "response_status", "responseStatus"),
    nextAttemptAt: str(wire, "next_attempt_at", "nextAttemptAt"),
    createdAt: reqStr(wire, "", "created_at", "createdAt"),
  };
}

export function normalizeAuditLogEntry(raw: unknown): AuditLogEntryView {
  const wire = isWire(raw) ? raw : {};
  const actorType = str(wire, "actor_type", "actorType");
  return {
    id: reqStr(wire, "", "id"),
    actor: isWire(wire["actor"]) ? normalizeAuthor(wire["actor"]) : null,
    actorType: actorType === "agent" || actorType === "human" ? actorType : null,
    action: reqStr(wire, "", "action"),
    targetType: str(wire, "target_type", "targetType"),
    targetId: str(wire, "target_id", "targetId"),
    metadata: isWire(wire["metadata"]) ? (wire["metadata"] as Record<string, unknown>) : {},
    createdAt: reqStr(wire, "", "created_at", "createdAt"),
  };
}

// ─── Phase 5A normalizers ───────────────────────────────────────────────────

export function normalizeMessage(raw: unknown): MessageView {
  const wire = isWire(raw) ? raw : {};
  const replyRaw = wire["reply_to"];
  const reactionsRaw = wire["reactions"];
  const reactions: Record<string, number> = {};
  if (isWire(reactionsRaw)) {
    for (const [emoji, count] of Object.entries(reactionsRaw)) {
      if (typeof count === "number") reactions[emoji] = count;
    }
  }
  return {
    id: reqStr(wire, "", "id"),
    conversationId: reqStr(wire, "", "conversation_id", "conversationId"),
    sender: normalizeAuthor(wire["sender"]),
    authorType: (str(wire, "author_type", "authorType") ?? "human") as MessageView["authorType"],
    body: str(wire, "body"),
    media: isWire(wire["media"]) ? normalizeMediaObject(wire["media"]) : null,
    replyTo: isWire(replyRaw)
      ? {
          id: reqStr(replyRaw, "", "id"),
          senderHandle: reqStr(replyRaw, "", "sender_handle", "senderHandle"),
          body: str(replyRaw, "body"),
          deleted: bool(replyRaw, "deleted"),
        }
      : null,
    sharedPost: isWire(wire["shared_post"]) ? normalizePost(wire["shared_post"]) : null,
    reactions,
    viewerReactions: Array.isArray(wire["viewer_reactions"])
      ? (wire["viewer_reactions"] as unknown[]).filter(
          (v): v is string => typeof v === "string",
        )
      : [],
    readBy: Array.isArray(wire["read_by"])
      ? (wire["read_by"] as unknown[]).filter((v): v is string => typeof v === "string")
      : [],
    editedAt: str(wire, "edited_at", "editedAt"),
    deletedAt: str(wire, "deleted_at", "deletedAt"),
    createdAt: reqStr(wire, "", "created_at", "createdAt"),
  };
}

export function normalizeConversation(raw: unknown): ConversationView {
  const wire = isWire(raw) ? raw : {};
  const participantsRaw = wire["participants"];
  return {
    id: reqStr(wire, "", "id"),
    kind: (str(wire, "kind") ?? "dm") as ConversationView["kind"],
    title: str(wire, "title"),
    status: (str(wire, "status") ?? "active") as ConversationView["status"],
    participants: Array.isArray(participantsRaw)
      ? participantsRaw.filter(isWire).map(normalizeAuthor)
      : [],
    lastMessage: isWire(wire["last_message"]) ? normalizeMessage(wire["last_message"]) : null,
    unreadCount: reqNum(wire, 0, "unread_count", "unreadCount"),
    mutedUntil: str(wire, "muted_until", "mutedUntil"),
    lastMessageAt: str(wire, "last_message_at", "lastMessageAt"),
    createdAt: reqStr(wire, "", "created_at", "createdAt"),
  };
}

export function normalizeList(raw: unknown): ListView {
  const wire = isWire(raw) ? raw : {};
  return {
    id: reqStr(wire, "", "id"),
    owner: normalizeAuthor(wire["owner"]),
    name: reqStr(wire, "", "name"),
    description: str(wire, "description"),
    isPublic: bool(wire, "is_public", "isPublic"),
    memberCount: reqNum(wire, 0, "member_count", "memberCount"),
    createdAt: reqStr(wire, "", "created_at", "createdAt"),
  };
}

export function normalizeCollection(raw: unknown): CollectionView {
  const wire = isWire(raw) ? raw : {};
  return {
    id: reqStr(wire, "", "id"),
    name: reqStr(wire, "", "name"),
    description: str(wire, "description"),
    isPublic: bool(wire, "is_public", "isPublic"),
    itemCount: reqNum(wire, 0, "item_count", "itemCount"),
    createdAt: reqStr(wire, "", "created_at", "createdAt"),
    updatedAt: reqStr(wire, "", "updated_at", "updatedAt"),
  };
}

export function normalizeTrending(raw: unknown): TrendingView {
  const wire = isWire(raw) ? raw : {};
  const hashtagsRaw = wire["hashtags"];
  return {
    hashtags: Array.isArray(hashtagsRaw)
      ? hashtagsRaw.filter(isWire).map((h) => ({
          tag: reqStr(h, "", "tag"),
          postCount: reqNum(h, 0, "post_count", "postCount"),
        }))
      : [],
    communities: Array.isArray(wire["communities"])
      ? wire["communities"].filter(isWire).map(normalizeCommunity)
      : [],
    debates: Array.isArray(wire["debates"])
      ? wire["debates"].filter(isWire).map(normalizeDebate)
      : [],
    posts: Array.isArray(wire["posts"]) ? wire["posts"].filter(isWire).map(normalizePost) : [],
    computedAt: str(wire, "computed_at", "computedAt"),
    window: reqStr(wire, "trailing_6h", "window"),
  };
}
