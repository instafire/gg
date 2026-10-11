/**
 * @gg/sdk view types — the normalized, camelCase shapes the client returns.
 *
 * The wire contract is docs/API_SPEC.yaml (snake_case fields, `{ data, page }`
 * list envelopes). The SDK normalizes wire payloads into these views at its
 * boundary so app code never deals with wire naming. Enum types and shared
 * DTOs come from @gg/shared (the contract package); where the spec's wire
 * shape has no @gg/shared equivalent yet (e.g. the compact AuthorRef embedded
 * in posts vs. the full UserPublicDTO), the SDK defines the honest view type
 * here and the gap is reported to the contract owners.
 */
import type {
  AuthorType,
  CursorPage,
  PostType,
  TrustTier,
  Visibility,
  VoteValue,
} from "@gg/shared";

export type { CursorPage };

/** Compact author summary as embedded in posts/comments (spec AuthorRef). */
export interface AuthorView {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  authorType: AuthorType;
  trustTier: TrustTier;
  /**
   * True for agent accounts — the permanent AI badge signal (spec:
   * `is_verified_agent`). Agents are labeled, never styled to look human
   * (DESIGN_SYSTEM §2.7).
   */
  isAgentBadge: boolean;
}

export interface LinkCardView {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
}

/**
 * Vote tallies split by author type. D-012: agent votes count the same as
 * human votes (weight 1.0) — the combined score is the headline number, and
 * this split is shown alongside for transparency.
 *
 * NOTE: API_SPEC.yaml's VoteSummary/Post schemas do not yet carry the split;
 * the SDK surfaces it when the API provides it (`vote_breakdown`) and
 * returns null otherwise.
 */
export interface VoteBreakdown {
  humanUp: number;
  humanDown: number;
  agentUp: number;
  agentDown: number;
}

export interface MediaVariantView {
  url: string;
  width: number | null;
  height: number | null;
  format: string;
}

export interface CaptionTrackView {
  lang: string;
  label: string;
  url: string;
}

export interface MediaView {
  id: string;
  kind: string;
  url: string | null;
  altText: string | null;
  width: number | null;
  height: number | null;
  /** Pipeline status: uploading | processing | ready | failed | quarantined | rejected. */
  status: string;
  /** Video duration in milliseconds (null for images / unprobed media). */
  durationMs: number | null;
  /** BlurHash placeholder for images (and video posters). */
  blurhash: string | null;
  /** Image rendition map (thumb/small/medium/large + *_avif twins). */
  variants: Record<string, MediaVariantView> | null;
  /** HLS master playlist URL for video; null otherwise. */
  hlsUrl: string | null;
  /** Video poster/thumbnail URL. */
  thumbnailUrl: string | null;
  /** Caption tracks (WebVTT sidecars); empty until a transcriber runs. */
  captions: CaptionTrackView[];
}

/** An upload session created by POST /api/v1/media/uploads. */
export interface UploadSessionView {
  mediaId: string;
  status: string;
  tusUrl: string;
  signedPutUrl: string | null;
  offset: number;
  length: number;
  expiresAt: string | null;
}

export type MediaUploadKind = "image" | "video" | "gif" | "audio";

export interface CreateUploadInput {
  kind: MediaUploadKind;
  mimeType: string;
  sizeBytes: number;
  filename?: string;
  sha256?: string;
}

export interface StoryStickerView {
  kind: string;
  pollId?: string;
  text?: string;
  x?: number;
  y?: number;
}

/** A single story frame (normalized spec `Story`). */
export interface StoryView {
  id: string;
  author: AuthorView;
  media: MediaView;
  audience: string;
  stickers: StoryStickerView[];
  musicRef: string | null;
  expiresAt: string;
  createdAt: string;
  /** Real count for the author's own stories; 0 when withheld. */
  viewCount: number;
  viewerHasSeen: boolean;
}

/** Stories grouped by author (one ring in the stories feed). */
export interface StoryGroupView {
  author: AuthorView;
  stories: StoryView[];
  hasUnseen: boolean;
}

export interface CreateStoryInput {
  mediaId: string;
  audience?: "everyone" | "close_friends";
  stickers?: StoryStickerView[];
}

/** A post as the UI consumes it (normalized spec `Post`). */
export interface PostView {
  id: string;
  shortCode: string | null;
  author: AuthorView;
  authorType: AuthorType;
  type: PostType;
  body: string;
  title: string | null;
  community: { id: string; slug: string; name: string } | null;
  communityId: string | null;
  parentId: string | null;
  rootId: string | null;
  depth: number;
  media: MediaView[];
  linkCard: LinkCardView | null;
  flair: string | null;
  visibility: string;
  isNsfw: boolean;
  isSpoiler: boolean;
  /** Phase 5B: community sticky pin / mod feature / AutoMod hold flags. */
  isPinned: boolean;
  isFeatured: boolean;
  isHeld: boolean;
  /** Combined score — humans + agents at equal weight (D-012). */
  score: number;
  upCount: number;
  /** Null when the API withholds down counts (personal-timeline rule). */
  downCount: number | null;
  replyCount: number;
  repostCount: number;
  quoteCount: number;
  viewCount: number;
  viewerVote: VoteValue | null;
  viewerBookmarked: boolean;
  /** Reaction counts by kind (spec Post.reaction_counts). */
  reactionCounts: Record<string, number>;
  /** Reaction kinds the viewer has applied (spec viewer_state.reactions). */
  viewerReactions: string[];
  voteBreakdown: VoteBreakdown | null;
  /** Feed "why am I seeing this?" reasons, when the item came from a feed. */
  whyReasons: string[] | null;
  /** Phase 3: embedded poll for POLL host posts (null otherwise). */
  poll: PollView | null;
  /** Phase 3: embedded debate for DEBATE host posts (null otherwise). */
  debate: DebateView | null;
  /** Phase 5A: set while the post awaits its scheduled publish time. */
  scheduledFor: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  removed: boolean;
}

export interface VoteSummaryView {
  upCount: number;
  downCount: number | null;
  score: number;
  viewerVote: VoteValue | null;
  breakdown: VoteBreakdown | null;
}

export interface ThreadView {
  root: PostView;
  focus: PostView;
  ancestors: PostView[];
  replies: CursorPage<PostView>;
}

export interface ProfileViewerState {
  isSelf: boolean;
  isFollowing: boolean;
  isFollowedBy: boolean;
  isBlocked: boolean;
  isMuted: boolean;
}

/** Public profile (normalized spec `Profile`). */
export interface ProfileView {
  userId: string;
  handle: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  websiteUrl: string | null;
  /** Free-text location (wire `location`); null when unset. */
  location: string | null;
  authorType: AuthorType;
  trustTier: TrustTier;
  isPrivate: boolean;
  followerCount: number;
  followingCount: number;
  /** Phase 3: debate Elo (null until the user finishes a rated debate). */
  debateRating: number | null;
  debateRecord: { wins: number; losses: number; draws: number } | null;
  viewerState: ProfileViewerState | null;
}

/** The authenticated user's private view (normalized spec `UserPrivate`). */
export interface CurrentUserView {
  id: string;
  handle: string;
  email: string | null;
  emailVerified: boolean;
  authorType: AuthorType;
  trustTier: TrustTier;
  ageBracket: string | null;
  status: string | null;
  profile: ProfileView;
  /** ISO timestamp once onboarding completed; null while it is still pending. */
  onboardingCompletedAt: string | null;
  /** Phase 5B: platform role ('user' | 'admin'). */
  platformRole: string;
}

export interface UpdateProfileInput {
  displayName?: string;
  bio?: string | null;
  websiteUrl?: string | null;
  location?: string | null;
  avatarMediaId?: string | null;
  bannerMediaId?: string | null;
  isPrivate?: boolean;
}

export interface TokenPairView {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
}

export interface AuthResult {
  user: CurrentUserView | null;
  tokens: TokenPairView | null;
  totpRequired: boolean;
  challengeToken: string | null;
  /**
   * D-035 staging affordance: the email verification link, present on
   * register responses only when the API runs outside production.
   */
  devVerificationUrl: string | null;
}

/** POST /api/v1/auth/verify-email result. */
export interface VerifyEmailResult {
  emailVerified: boolean;
  user: CurrentUserView | null;
}

/** POST /api/v1/auth/password/forgot result (hardening, D-070). */
export interface ForgotPasswordResult {
  status: "pending";
  /** Staging affordance while the log mailer is active (D-070); else null. */
  devResetUrl: string | null;
}

/** GET /api/v1/auth/2fa/status result (hardening, D-067/D-068). */
export interface TwoFactorStatus {
  totpEnabled: boolean;
  hasPasskey: boolean;
  passkeys: PasskeyView[];
}

export interface PasskeyView {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/** POST /api/v1/auth/2fa/totp/verify result in enrollment/step-up mode. */
export interface TotpVerifyResult {
  status: string;
  /** One-time recovery codes — returned only when TOTP is enabled. */
  recoveryCodes: string[];
}

/** A configured social sign-in provider (GET /auth/oauth/providers). */
export interface SocialProvider {
  id: string;
  name: string;
}

/** GET /api/v1/oauth/authorize consent-screen data (D-066). */
export interface OAuthAuthorizeInfo {
  clientId: string;
  clientName: string;
  scopes: string[];
  redirectUri: string;
  state: string | null;
}

/** POST /api/v1/auth/resend-verification result. */
export interface ResendVerificationResult {
  /** "pending" = a fresh link was issued; "already_verified" = no-op. */
  status: "pending" | "already_verified";
  /** Fresh link outside production (D-035); null in production / on no-op. */
  devVerificationUrl: string | null;
}

export interface RegisterInput {
  handle: string;
  email: string;
  password: string;
  displayName?: string;
  /** ISO date (YYYY-MM-DD). The API derives the age bracket from it. */
  dateOfBirth: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface CreatePostInput {
  type?: PostType;
  body: string;
  parentId?: string;
  quotedPostId?: string;
  repostOfId?: string;
  communitySlug?: string;
  title?: string;
  mediaIds?: string[];
  linkUrl?: string;
  visibility?: Visibility;
  isNsfw?: boolean;
  isSpoiler?: boolean;
  /** Phase 3: inline poll payload (required when type is "POLL"). */
  poll?: CreatePollInlineInput;
  /** Phase 3: inline debate payload (required when type is "DEBATE"). */
  debate?: CreateDebateInput;
  /** Phase 5A: ISO timestamp to publish at (top-level posts only). */
  scheduledFor?: string;
}

export interface UpdatePostInput {
  body?: string;
  title?: string;
  isNsfw?: boolean;
  isSpoiler?: boolean;
  /** Phase 5A: reschedule (future ISO) or publish now (null). */
  scheduledFor?: string | null;
}

export type ReactionKind = "like" | "insightful" | "funny" | "agree" | "disagree";

// ─── Notifications ──────────────────────────────────────────────────────────

export type NotificationType =
  | "reply"
  | "mention"
  | "follow"
  | "vote_digest"
  | "debate_challenge"
  | "debate_turn"
  | "poll_closing"
  | "mod_action"
  | "dm_request"
  | "system";

/** One notification row (normalized spec `Notification`). */
export interface NotificationView {
  id: string;
  type: NotificationType;
  actor: AuthorView | null;
  subjectType: string | null;
  subjectId: string | null;
  payload: Record<string, unknown>;
  groupCount: number;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPage {
  items: NotificationView[];
  nextCursor: string | null;
  unreadCount: number;
}

export interface QuietHours {
  start: string;
  end: string;
}

export interface NotificationPreferencesView {
  /** Per-type toggles; a missing key means enabled. */
  prefs: Record<string, boolean>;
  quietHours: QuietHours | null;
  /** Every notification type the API knows (for settings UIs). */
  types: string[];
}

export interface NotificationPreferencesInput {
  prefs?: Record<string, boolean>;
  quietHours?: QuietHours | null;
}

// ─── Search ─────────────────────────────────────────────────────────────────

export type SearchType = "all" | "posts" | "people" | "communities";

export interface SearchResultsView {
  posts: CursorPage<PostView>;
  people: CursorPage<ProfileView>;
  communities: CursorPage<CommunityView>;
  hashtags: { tag: string; postCount: number }[];
  /** Phase 5B: true when semantic (vector) results were blended in. */
  semanticApplied: boolean;
}

export interface SearchSuggestion {
  kind: "user" | "community";
  label: string;
  /** Handle for users, slug for communities. */
  id: string;
}

// ─── Onboarding ─────────────────────────────────────────────────────────────

export interface OnboardingSuggestedView {
  communities: CommunityView[];
  accounts: ProfileView[];
  topics: string[];
}

// ─── Settings ───────────────────────────────────────────────────────────────

export interface UserSettingsView {
  hideAiAccounts: boolean;
  hideNsfw: boolean;
  dmPolicy: string;
  mentionPolicy: string;
  readReceipts: boolean;
  presenceVisible: boolean;
  captionsDefaultOn: boolean;
  fontScale: number;
  highContrast: boolean;
  reducedMotion: boolean;
  demographicBreakdownsOptIn: boolean;
  language: string;
  notificationPrefs: Record<string, boolean>;
  quietHours: QuietHours | null;
  /** Phase 5B additions. */
  pushPrefs: Record<string, boolean>;
  digestFrequency: string;
  preferences: Record<string, unknown>;
  /** Account visibility (profiles.is_private), carried on the settings doc. */
  isPrivate: boolean;
}

export interface UpdateSettingsInput {
  hideAiAccounts?: boolean;
  hideNsfw?: boolean;
  dmPolicy?: string;
  mentionPolicy?: string;
  readReceipts?: boolean;
  presenceVisible?: boolean;
  captionsDefaultOn?: boolean;
  fontScale?: number;
  highContrast?: boolean;
  reducedMotion?: boolean;
  demographicBreakdownsOptIn?: boolean;
  language?: string;
  notificationPrefs?: Record<string, boolean>;
  quietHours?: QuietHours | null;
  isPrivate?: boolean;
  /** Phase 5B: per-type web-push preferences (merged server-side). */
  pushPrefs?: Record<string, boolean>;
  /** Phase 5B: email digest cadence — "off" | "daily" | "weekly". */
  digestFrequency?: string;
}

export interface ChangePasswordInput {
  ["currentPassword"]: string;
  ["newPassword"]: string;
}

export interface EmailChangeResult {
  status: string;
  newEmail: string;
}

export interface HandleAvailability {
  handle: string;
  available: boolean;
  reason: "taken" | "invalid" | null;
}

export interface CommunityView {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  visibility: string;
  isNsfw: boolean;
  memberCount: number;
  postCount: number;
  topics: string[];
  viewerMembership: { role: string; status: string } | null;
  /** Phase 5B: a lockdown is active (posting restricted to mods + pre-lockdown members). */
  lockdownActive: boolean;
  createdAt: string | null;
}

export interface MembershipView {
  communityId: string;
  role: string;
  status: string;
}

export interface PageParams {
  cursor?: string;
  limit?: number;
}

export type FeedTab = "for_you" | "following";
export type ReplySort = "best" | "new" | "top" | "controversial";
export type CommunityPostSort = "hot" | "new" | "top" | "rising" | "controversial";
export type UserPostsTab = "posts" | "replies" | "media" | "debates";

export type ReportTargetType =
  | "post"
  | "user"
  | "community"
  | "message"
  | "argument"
  | "debate";

export type ReportReason =
  | "spam"
  | "harassment"
  | "hate"
  | "violence"
  | "sexual"
  | "self_harm"
  | "misinformation"
  | "copyright"
  | "impersonation"
  | "other";

export type ReportStatus =
  | "open"
  | "triaged"
  | "actioned"
  | "dismissed"
  | "appealed"
  | "closed";

export interface ReportView {
  id: string;
  targetType: string;
  targetId: string;
  reason: ReportReason;
  status: ReportStatus;
  resolution: string | null;
  createdAt: string;
}

export interface CreateReportInput {
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReason;
  details?: string;
}

export interface ResolveReportInput {
  status: "triaged" | "actioned" | "dismissed" | "closed";
  resolution?: string;
}

export interface ModQueueItemView {
  id: string;
  kind: "report" | "held";
  severity: number;
  report: ReportView;
  post: PostView | null;
  /** Phase 5B: the AutoMod rule that held this item (null for reports).
   * Rules are nameless — the citation is kind + action + match detail. */
  automodRule: {
    id: string | null;
    kind: string;
    action: string;
    detail: string | null;
  } | null;
  createdAt: string;
}

// ─── Phase 5B: AutoMod, mod actions, push, analytics ────────────────────────

export type AutomodKind =
  | "keyword"
  | "regex"
  | "account_age"
  | "karma_threshold"
  | "trust_tier"
  | "link_domain"
  | "link_count";

export type AutomodAction = "flag" | "hold" | "remove";

export interface AutomodRuleView {
  id: string;
  communityId: string;
  kind: AutomodKind;
  config: Record<string, unknown>;
  action: AutomodAction;
  isEnabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAutomodRuleInput {
  kind: AutomodKind;
  config: Record<string, unknown>;
  action: AutomodAction;
  isEnabled?: boolean;
}

export interface UpdateAutomodRuleInput {
  config?: Record<string, unknown>;
  action?: AutomodAction;
  isEnabled?: boolean;
}

export type ModActionType =
  | "remove_post"
  | "approve_post"
  | "ban"
  | "mute"
  | "lock_thread"
  | "pin"
  | "unpin"
  | "warn"
  | "note"
  | "feature"
  | "restore";

export interface ModActionInput {
  action: ModActionType;
  targetType?: "post" | "user" | "community";
  targetId?: string;
  userId?: string;
  note?: string;
}

export interface ModActionView {
  id: string;
  communityId: string;
  actorId: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  note: string | null;
  createdAt: string;
}

export interface MembershipRequestView {
  id: string;
  communityId: string;
  user: AuthorView;
  role: string;
  status: string;
  mutedUntil: string | null;
  joinedAt: string;
}

export interface PushSubscriptionView {
  id: string;
  endpoint: string;
  createdAt: string;
}

export interface CreatePushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface AnalyticsDayPoint {
  date: string;
  posts?: number;
  events?: number;
  dau?: number;
}

export interface AnalyticsOverviewView {
  windowDays: number;
  generatedAt: string;
  dauToday: number;
  mau: number;
  newUsers: { today: number; last7d: number; last30d: number };
  postsPerDay: number;
  postsSeries: AnalyticsDayPoint[];
  dauSeries: AnalyticsDayPoint[];
  debates: {
    started: number;
    completed: number;
    completionRate: number | null;
    mindChangeRate: number | null;
  };
  moderation: {
    reportsTotal: number;
    resolvedCount: number;
    pendingCount: number;
    reportRatePer100Posts: number | null;
    avgTimeToModerationHours: number | null;
  };
  activitySplit: {
    humanEvents: number;
    agentEvents: number;
    humanUsers: number;
    agentUsers: number;
  };
}

// ─── Polls (Phase 3) ─────────────────────────────────────────────────────────

export type PollType = "single" | "multiple" | "ranked" | "stance_slider" | "image" | "hot_take";
export type PollResultMode = "live" | "after_vote" | "after_close";

export interface PollOptionView {
  id: string;
  position: number;
  text: string | null;
  media: MediaView | null;
  humanVotes: number;
  agentVotes: number;
  /** Share of the human vote, 0..1. */
  share: number;
}

export interface PollViewerBallot {
  optionId: string | null;
  optionIds: string[];
  ranking: string[] | null;
  sliderValue: number | null;
}

export interface PollView {
  id: string;
  postId: string;
  type: PollType;
  question: string;
  options: PollOptionView[];
  resultMode: PollResultMode;
  resultsVisible: boolean;
  isAnonymous: boolean;
  isDailyPulse: boolean;
  minTrustTier: TrustTier;
  /** Human ballots. */
  totalVotes: number;
  agentTotalVotes: number;
  closesAt: string | null;
  isClosed: boolean;
  voided: boolean;
  viewerBallot: PollViewerBallot | null;
}

export interface PollResultsView {
  pollId: string;
  options: PollOptionView[];
  totalVotes: number;
  agentTotalVotes: number;
  winnerOptionId: string | null;
  irvRounds: Array<{
    round: number;
    tallies: Record<string, number>;
    eliminatedOptionId: string | null;
  }>;
  breakdowns: {
    byTrustTier: Record<string, number>;
    byAgeBracket: Record<string, number>;
  };
  viewerBallot: PollViewerBallot | null;
  /** Stance-slider buckets ("-2".."2") for stance_slider polls. */
  stanceDistribution: Record<string, number> | null;
}

export interface CreatePollInlineInput {
  question: string;
  type?: PollType;
  options?: Array<{ text?: string; mediaId?: string }>;
  resultMode?: PollResultMode;
  isAnonymous?: boolean;
  closesAt?: string;
  minTrustTier?: TrustTier;
  maxChoices?: number;
}

export interface CreatePollInput extends CreatePollInlineInput {
  communitySlug?: string;
  bodyMd?: string;
}

export interface PollBallotInput {
  optionId?: string;
  optionIds?: string[];
  ranking?: string[];
  sliderValue?: number;
}

// ─── Debates (Phase 3) ───────────────────────────────────────────────────────

export type DebateFormat = "open" | "structured_1v1" | "team";
export type DebateStatus =
  | "draft"
  | "open"
  | "live"
  | "awaiting_turn"
  | "closed"
  | "archived"
  | "cancelled";

export interface DebateSideView {
  id: string;
  key: string;
  label: string;
  argumentCount: number;
  humanArgumentVotes: number;
  agentArgumentVotes: number;
}

export interface DebateParticipantView {
  user: AuthorView;
  sideKey: string;
  role: string;
  eloAtStart: number | null;
}

export interface DebateRoundView {
  roundNo: number;
  kind: string;
  sideKey: string | null;
  deadlineAt: string | null;
  status: string;
  argumentId: string | null;
}

export interface DebateView {
  id: string;
  shortCode: string;
  postId: string;
  proposition: string;
  format: DebateFormat;
  status: DebateStatus;
  host: AuthorView;
  judge: AuthorView | null;
  community: { id: string; slug: string; name: string } | null;
  sourceArticleUrl: string | null;
  sides: DebateSideView[];
  participants: DebateParticipantView[];
  rounds: DebateRoundView[];
  currentRound: number | null;
  perTurnCharLimit: number;
  turnDeadlineHours: number | null;
  winnerSideKey: string | null;
  isDraw: boolean;
  winnerFormula: { argumentVotes: number; mindChange: number; evidenceQuality: number } | null;
  mindChange: {
    audiencePreCount: number;
    audiencePostCount: number;
    mindChangedCount: number;
    mindChangeRate: number;
  };
  scheduledStartAt: string | null;
  closedAt: string | null;
  createdAt: string;
  /** Pending challenge addressed to the viewer (draft 1v1 debates). */
  viewerChallenge: { id: string } | null;
  /** Closed by double-forfeit; a judge decision is still owed. */
  pendingJudge: boolean;
}

export interface EvidenceView {
  id: string;
  url: string;
  kind: string;
  quote: string | null;
  domain: string | null;
}

export interface ArgumentView {
  id: string;
  debateId: string;
  sideKey: string;
  author: AuthorView;
  authorType: AuthorType;
  roundNo: number | null;
  parentArgumentId: string | null;
  bodyMd: string;
  bodyHtml: string;
  isSteelman: boolean;
  steelmanConfirmed: boolean;
  evidence: EvidenceView[];
  fallacyFlags: Array<{ fallacy: string; confirmedByMod: boolean }>;
  upCount: number;
  downCount: number;
  score: number;
  voteBreakdown: VoteBreakdown | null;
  evidenceQuality: number;
  createdAt: string;
  viewerVote: "up" | "down" | null;
}

export interface DebateStateView {
  debateId: string;
  status: DebateStatus;
  sides: DebateSideView[];
  stanceDistribution: { pre: Record<string, number>; post: Record<string, number> };
  mindChangedCount: number;
  mindChangeRate: number;
  currentRound: number | null;
  turnDeadlineAt: string | null;
  viewerStance: { pre: number | null; post: number | null } | null;
}

export interface EvidenceInput {
  url: string;
  kind: "study" | "news" | "data" | "personal_experience" | "other";
  quote?: string;
}

export interface CreateDebateInput {
  proposition: string;
  format: DebateFormat;
  communitySlug?: string;
  sourceArticleUrl?: string;
  challengedHandle?: string;
  judgeHandle?: string;
  challengerSideKey?: string;
  turnDeadlineHours?: number;
  liveTurnSeconds?: number;
  perTurnCharLimit?: number;
  rounds?: number;
  steelmanRequired?: boolean;
  scheduledStartAt?: string;
  opening?: { sideKey: string; bodyMd: string; evidence?: EvidenceInput[] };
}

export interface CreateArgumentInput {
  sideKey: string;
  bodyMd: string;
  parentArgumentId?: string;
  isSteelman?: boolean;
  evidence?: EvidenceInput[];
}

// ─── Context notes (Phase 3) ─────────────────────────────────────────────────

export type ContextNoteStatus = "pending" | "helpful" | "not_helpful" | "needs_more_ratings";

export interface ContextNoteView {
  id: string;
  postId: string;
  author: AuthorView;
  body: string;
  sources: string[];
  status: ContextNoteStatus;
  createdAt: string;
}

// ─── Phase 4: agent platform ────────────────────────────────────────────────

export type ApiScope =
  | "read:feed"
  | "write:post"
  | "write:vote"
  | "debate:participate"
  | "dm:send"
  | "moderate:community";

export type AgentCapability =
  | "posting"
  | "replying"
  | "voting"
  | "debating"
  | "summarizing"
  | "moderating";

export interface AgentProfileView {
  userId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  purpose: string;
  owner: AuthorView;
  modelProvider: string | null;
  modelName: string | null;
  capabilities: string[];
  homepageUrl: string | null;
  rateTier: number;
  killSwitchEngaged: boolean;
  autoDisclosure: string;
  createdAt: string;
}

export interface RegisterAgentInput {
  handle: string;
  displayName: string;
  purpose: string;
  modelProvider?: string;
  modelName?: string;
  capabilities?: AgentCapability[];
  homepageUrl?: string;
}

export interface RegisterAgentResult {
  profile: AgentProfileView;
  /** The agent's first API key — `secret` is shown exactly once. */
  apiKey: ApiKeyCreatedView;
}

export interface UpdateAgentInput {
  displayName?: string;
  purpose?: string;
  modelProvider?: string | null;
  modelName?: string | null;
  capabilities?: AgentCapability[];
  homepageUrl?: string | null;
}

export interface ListAgentsParams extends PageParams {
  mine?: boolean;
  q?: string;
}

export interface ApiKeyView {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: ApiScope[];
  /** Handle of the account this key acts as (you, or one of your agents). */
  agentHandle: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface ApiKeyCreatedView extends ApiKeyView {
  /** The full secret — returned exactly once, at creation. */
  secret: string;
}

export interface CreateApiKeyInput {
  name: string;
  scopes: ApiScope[];
  /** Create the key for this owned agent instead of your own account. */
  agentHandle?: string;
  expiresAt?: string;
}

export interface OAuthClientView {
  id: string;
  clientId: string;
  name: string;
  redirectUris: string[];
  allowedScopes: ApiScope[];
  isConfidential: boolean;
  createdAt: string;
}

export interface OAuthClientCreatedView extends OAuthClientView {
  /** The client secret — returned exactly once, at creation. */
  clientSecret: string | null;
}

export interface CreateOAuthClientInput {
  name: string;
  redirectUris?: string[];
  allowedScopes: ApiScope[];
  isConfidential?: boolean;
}

export interface ClientCredentialsInput {
  clientId: string;
  clientSecret: string;
  /** The agent (owned by the client's owner) the token acts as. */
  agentHandle: string;
  scope?: string;
}

export interface OAuthTokenView {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  /** Space-separated granted scopes. */
  scope: string;
}

export type WebhookEventType =
  | "mention.created"
  | "reply.created"
  | "debate.turn_due"
  | "debate.closed"
  | "debate.challenge"
  | "poll.closed"
  | "follow.created"
  | "dm.received"
  | "ping";

export interface WebhookView {
  id: string;
  url: string;
  events: WebhookEventType[];
  isActive: boolean;
  failureStreak: number;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookCreatedView extends WebhookView {
  /** The signing secret — returned exactly once, at creation. */
  secret: string;
}

export interface CreateWebhookInput {
  url: string;
  events: WebhookEventType[];
  /** Own the webhook as this agent (you must own the agent). */
  agentHandle?: string;
}

export interface UpdateWebhookInput {
  url?: string;
  events?: WebhookEventType[];
  isActive?: boolean;
}

export interface WebhookDeliveryView {
  id: string;
  event: string;
  status: "pending" | "delivered" | "failed" | "exhausted" | string;
  attempts: number;
  responseStatus: number | null;
  nextAttemptAt: string | null;
  createdAt: string;
}

export interface AuditLogEntryView {
  id: string;
  actor: AuthorView | null;
  actorType: "human" | "agent" | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  /** Includes `api_key_id` + `auth_method` for credential-authenticated writes. */
  metadata: Record<string, unknown>;
  createdAt: string;
}

// ─── Phase 5A: messages, lists, collections, trending ──────────────────────

export type ConversationKind = "dm" | "group";
export type ConversationStatus = "active" | "requested";

export interface ConversationView {
  id: string;
  kind: ConversationKind;
  title: string | null;
  /** The viewer's own participant status (drives Requests UI). */
  status: ConversationStatus;
  /** Spec shape: plain author refs (API_SPEC Conversation.participants). */
  participants: AuthorView[];
  lastMessage: MessageView | null;
  unreadCount: number;
  mutedUntil: string | null;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface MessageView {
  id: string;
  conversationId: string;
  sender: AuthorView;
  authorType: AuthorType;
  body: string | null;
  media: MediaView | null;
  /** Quoted-message preview (API additive field alongside reply_to_message_id). */
  replyTo: { id: string; senderHandle: string; body: string | null; deleted: boolean } | null;
  sharedPost: PostView | null;
  /** Spec shape: emoji → count map. */
  reactions: Record<string, number>;
  /** Emoji the viewer has applied to this message. */
  viewerReactions: string[];
  /** Handles (besides the sender's) that have read up to this message. */
  readBy: string[];
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export interface SendMessageInput {
  body?: string;
  mediaId?: string;
  replyToMessageId?: string;
  sharedPostId?: string;
}

export interface ListView {
  id: string;
  owner: AuthorView;
  name: string;
  description: string | null;
  isPublic: boolean;
  memberCount: number;
  createdAt: string;
}

export interface CreateListInput {
  name: string;
  description?: string | null;
  isPublic?: boolean;
}

export interface UpdateListInput {
  name?: string;
  description?: string | null;
  isPublic?: boolean;
}

export interface CollectionView {
  id: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCollectionInput {
  name: string;
  description?: string | null;
  isPublic?: boolean;
}

export interface UpdateCollectionInput {
  name?: string;
  description?: string | null;
  isPublic?: boolean;
}

export interface TrendingHashtagView {
  tag: string;
  postCount: number;
}

export interface TrendingView {
  hashtags: TrendingHashtagView[];
  communities: CommunityView[];
  debates: DebateView[];
  posts: PostView[];
  /** Snapshot time (null until the worker's first run). */
  computedAt: string | null;
  /** Velocity window label, e.g. "trailing_6h" (D-052). */
  window: string;
}

export interface UnreadCountsView {
  notifications: number;
  /** Unread conversations (muted excluded) — Phase 5A (D-053). */
  dms: number;
}
