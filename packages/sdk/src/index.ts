/**
 * @gg/sdk — TypeScript client for the GG public API (/api/v1).
 *
 * A thin, typed wrapper over fetch implementing docs/API_SPEC.yaml. Errors
 * surface as GGApiError carrying the API's RFC 9457 problem+json fields.
 * Wire payloads (snake_case, `{ data, page }` envelopes) are normalized
 * into the camelCase view types in ./types at this boundary.
 *
 * Auth model: the access token lives in memory on the client instance
 * (never localStorage); the refresh token is carried by an httpOnly cookie
 * when the API sets one — requests therefore send `credentials: "include"`.
 * When a login/register response also returns a refresh_token in the body
 * (the API_SPEC TokenPair), it is kept in memory and presented on refresh.
 * Authenticated requests retry once after a 401 → refresh → retry cycle.
 */
import type { CursorPage, PostDTO } from "@gg/shared";
import { GGApiError } from "./errors";
import {
  isWire,
  normalizeAgentProfile,
  normalizeAnalyticsOverview,
  normalizeApiKey,
  normalizeArgument,
  normalizeAuditLogEntry,
  normalizeAutomodRule,
  normalizeAuthor,
  normalizeCollection,
  normalizeCommunity,
  normalizeContextNote,
  normalizeConversation,
  normalizeCurrentUser,
  normalizeDebate,
  normalizeDebateState,
  normalizeFeedItem,
  normalizeList,
  normalizeMediaObject,
  normalizeMembership,
  normalizeMembershipRequest,
  normalizeMessage,
  normalizeModAction,
  normalizeModQueueItem,
  normalizeNotification,
  normalizeNotificationPreferences,
  normalizeOAuthClient,
  normalizeOAuthToken,
  normalizeOnboardingSuggested,
  normalizePage,
  normalizePoll,
  normalizePollResults,
  normalizePost,
  normalizeProfile,
  normalizePushSubscription,
  normalizeReport,
  normalizeSearchResults,
  normalizeSearchSuggestions,
  normalizeSettings,
  normalizeStory,
  normalizeStoryGroup,
  normalizeTokenPair,
  normalizeTrending,
  normalizeUploadSession,
  normalizeVoteSummary,
  normalizeWebhook,
  normalizeWebhookDelivery,
  type Wire,
} from "./normalize";
import type {
  ArgumentView,
  AuthResult,
  AuthorView,
  ForgotPasswordResult,
  OAuthAuthorizeInfo,
  PasskeyView,
  SocialProvider,
  TotpVerifyResult,
  TwoFactorStatus,
  AnalyticsOverviewView,
  AutomodRuleView,
  ChangePasswordInput,
  CollectionView,
  CommunityPostSort,
  CommunityView,
  ContextNoteView,
  ConversationView,
  CreateArgumentInput,
  CreateAutomodRuleInput,
  CreateCollectionInput,
  CreateListInput,
  CreateDebateInput,
  CreatePollInput,
  CreatePostInput,
  CreateReportInput,
  CreateStoryInput,
  CreateUploadInput,
  CurrentUserView,
  DebateStateView,
  DebateView,
  EmailChangeResult,
  EvidenceInput,
  FeedTab,
  HandleAvailability,
  ListView,
  LoginInput,
  MediaView,
  MembershipRequestView,
  MembershipView,
  MessageView,
  CreatePushSubscriptionInput,
  ModActionInput,
  ModActionView,
  ModQueueItemView,
  NotificationPage,
  NotificationPreferencesInput,
  NotificationPreferencesView,
  OnboardingSuggestedView,
  PageParams,
  PollBallotInput,
  PollResultsView,
  PollView,
  PostView,
  ProfileView,
  PushSubscriptionView,
  ReactionKind,
  RegisterInput,
  AgentProfileView,
  ApiKeyCreatedView,
  ApiKeyView,
  AuditLogEntryView,
  ClientCredentialsInput,
  CreateApiKeyInput,
  CreateOAuthClientInput,
  CreateWebhookInput,
  ListAgentsParams,
  OAuthClientCreatedView,
  OAuthClientView,
  OAuthTokenView,
  RegisterAgentInput,
  RegisterAgentResult,
  ReplySort,
  ResendVerificationResult,
  ReportView,
  ResolveReportInput,
  SearchResultsView,
  SearchSuggestion,
  SearchType,
  SendMessageInput,
  StoryGroupView,
  StoryView,
  ThreadView,
  TokenPairView,
  TrendingView,
  UnreadCountsView,
  UpdateAgentInput,
  UpdateAutomodRuleInput,
  UpdateCollectionInput,
  UpdateListInput,
  UpdatePostInput,
  UpdateProfileInput,
  UpdateWebhookInput,
  UpdateSettingsInput,
  UploadSessionView,
  UserPostsTab,
  UserSettingsView,
  VerifyEmailResult,
  VoteSummaryView,
  WebhookCreatedView,
  WebhookDeliveryView,
  WebhookView,
} from "./types";
import type { VoteValue } from "@gg/shared";

export { GGApiError } from "./errors";
export type { ProblemFieldError } from "./errors";
export type * from "./types";

export interface GGClientOptions {
  /** API base URL (origin), e.g. "http://localhost:4000" — /api/v1 is appended per call. */
  baseUrl: string;
  /** Optional API key, sent as the `x-api-key` header (agent accounts). */
  apiKey?: string;
  /** Injectable fetch for testing or non-standard runtimes. */
  fetchImpl?: typeof fetch;
  /**
   * Credentials mode for requests. Defaults to "include" so the httpOnly
   * refresh cookie flows between the web app and the API.
   */
  credentials?: CredentialsMode;
}

/** fetch credentials mode (mirrors the DOM lib type; this package builds without DOM). */
export type CredentialsMode = "omit" | "same-origin" | "include";

export interface HealthResponse {
  status: string;
  service: string;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Skip the Authorization header (public endpoints, auth endpoints). */
  anonymous?: boolean;
  /** Extra headers (e.g. Idempotency-Key). */
  headers?: Record<string, string>;
}

function queryString(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const qs = query.toString();
  return qs ? `?${qs}` : "";
}

function idempotencyKey(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `gg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Wire body for debate creation (shared by createPost inline + createDebate). */
function debateCreateBody(input: CreateDebateInput): Record<string, unknown> {
  return {
    proposition: input.proposition,
    format: input.format,
    community_slug: input.communitySlug,
    source_article_url: input.sourceArticleUrl,
    challenged_handle: input.challengedHandle,
    judge_handle: input.judgeHandle,
    challenger_side_key: input.challengerSideKey,
    turn_deadline_hours: input.turnDeadlineHours,
    live_turn_seconds: input.liveTurnSeconds,
    per_turn_char_limit: input.perTurnCharLimit,
    rounds: input.rounds,
    steelman_required: input.steelmanRequired,
    scheduled_start_at: input.scheduledStartAt,
    opening: input.opening
      ? {
          side_key: input.opening.sideKey,
          body_md: input.opening.bodyMd,
          evidence: input.opening.evidence?.map(evidenceBody),
        }
      : undefined,
  };
}

function evidenceBody(link: EvidenceInput): Record<string, unknown> {
  return { url: link.url, kind: link.kind, quote: link.quote };
}

export class GGClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly credentials: CredentialsMode;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  /** True once a session has been established (or plausibly exists via cookie). */
  private sessionLikely = false;

  constructor(options: GGClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    // Bind: window.fetch throws "Illegal invocation" when called unbound
    // (as a method of this client) in browsers. Node's fetch doesn't care,
    // which is why this only ever failed in real browsers (found 2026-10-10).
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.credentials = options.credentials ?? "include";
  }

  /** Current in-memory access token (null when anonymous). */
  getAccessToken(): string | null {
    return this.accessToken;
  }

  /** Manually seed tokens (e.g. after a server-side auth handoff). */
  setTokens(tokens: TokenPairView | null): void {
    this.accessToken = tokens?.accessToken ?? null;
    this.refreshToken = tokens?.refreshToken ?? null;
    this.sessionLikely = tokens !== null;
  }

  private clearTokens(): void {
    this.accessToken = null;
    this.refreshToken = null;
    this.sessionLikely = false;
  }

  private async rawFetch(path: string, options: RequestOptions): Promise<Response> {
    const headers = new Headers(options.headers);
    headers.set("accept", "application/json");
    if (this.apiKey) headers.set("x-api-key", this.apiKey);
    if (!options.anonymous && this.accessToken) {
      headers.set("authorization", `Bearer ${this.accessToken}`);
    }
    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        body,
        credentials: this.credentials,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "network request failed";
      throw new GGApiError(0, `Can't reach the GG API (${message})`, {
        isNetworkError: true,
      });
    }
  }

  private async toError(response: Response): Promise<GGApiError> {
    let detail = response.statusText;
    let code: string | null = null;
    let fieldErrors: { field: string; message: string }[] = [];
    let requestId: string | null = null;
    try {
      const parsed: unknown = await response.json();
      if (isWire(parsed)) {
        const wire: Wire = parsed;
        if (typeof wire["detail"] === "string") detail = wire["detail"];
        else if (typeof wire["title"] === "string") detail = wire["title"];
        if (typeof wire["code"] === "string") code = wire["code"];
        if (typeof wire["request_id"] === "string") requestId = wire["request_id"];
        if (Array.isArray(wire["errors"])) {
          fieldErrors = wire["errors"]
            .filter(isWire)
            .filter(
              (entry) =>
                typeof entry["field"] === "string" &&
                typeof entry["message"] === "string",
            )
            .map((entry) => ({
              field: entry["field"] as string,
              message: entry["message"] as string,
            }));
        }
      }
    } catch {
      // Non-JSON error body — keep the status text.
    }
    return new GGApiError(response.status, detail, { code, fieldErrors, requestId });
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.requestWithRetry<T>(path, options, false);
  }

  private async requestWithRetry<T>(
    path: string,
    options: RequestOptions,
    retried: boolean,
  ): Promise<T> {
    const response = await this.rawFetch(path, options);
    if (
      response.status === 401 &&
      !retried &&
      !options.anonymous &&
      !path.startsWith("/api/v1/auth/") &&
      (this.accessToken !== null || this.refreshToken !== null || this.sessionLikely)
    ) {
      try {
        await this.refresh();
      } catch {
        throw await this.toError(response);
      }
      return this.requestWithRetry<T>(path, options, true);
    }
    if (!response.ok) {
      throw await this.toError(response);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  // ─── Health & legacy ──────────────────────────────────────────────────────

  /** GET /api/v1/health */
  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("/api/v1/health", { anonymous: true });
  }

  /**
   * GET /api/v1/posts — legacy pass-through kept for backwards compatibility
   * (returns the raw page as @gg/shared CursorPage<PostDTO>). New code
   * should prefer the normalized feed/post methods below.
   */
  listPosts(params: PageParams = {}): Promise<CursorPage<PostDTO>> {
    const qs = queryString({ cursor: params.cursor, limit: params.limit });
    return this.request<CursorPage<PostDTO>>(`/api/v1/posts${qs}`);
  }

  // ─── Auth ─────────────────────────────────────────────────────────────────

  /** POST /api/v1/auth/register — creates the account and stores the session tokens. */
  async register(input: RegisterInput): Promise<AuthResult> {
    const raw = await this.request<Wire>("/api/v1/auth/register", {
      method: "POST",
      anonymous: true,
      headers: { "Idempotency-Key": idempotencyKey() },
      body: {
        handle: input.handle,
        email: input.email,
        password: input.password,
        display_name: input.displayName,
        date_of_birth: input.dateOfBirth,
      },
    });
    return this.acceptAuthResponse(raw);
  }

  /** POST /api/v1/auth/login — stores the session tokens on success. */
  async login(input: LoginInput): Promise<AuthResult> {
    const raw = await this.request<Wire>("/api/v1/auth/login", {
      method: "POST",
      anonymous: true,
      body: { email: input.email, password: input.password },
    });
    return this.acceptAuthResponse(raw);
  }

  /**
   * POST /api/v1/auth/refresh — rotates the session. Presents the in-memory
   * refresh token when one is known; otherwise the httpOnly cookie carries
   * it (credentials: "include").
   */
  async refresh(): Promise<TokenPairView> {
    const raw = await this.rawFetch("/api/v1/auth/refresh", {
      method: "POST",
      anonymous: true,
      body: this.refreshToken ? { refresh_token: this.refreshToken } : {},
    });
    if (!raw.ok) {
      throw await this.toError(raw);
    }
    const parsed: unknown = await raw.json();
    const tokens = normalizeTokenPair(parsed);
    if (!tokens) {
      throw new GGApiError(raw.status, "Refresh response did not include tokens");
    }
    this.accessToken = tokens.accessToken;
    if (tokens.refreshToken) this.refreshToken = tokens.refreshToken;
    this.sessionLikely = true;
    return tokens;
  }

  /** POST /api/v1/auth/logout — revokes the session; always clears local tokens. */
  async logout(): Promise<void> {
    try {
      await this.request<void>("/api/v1/auth/logout", { method: "POST" });
    } finally {
      this.clearTokens();
    }
  }

  /** GET /api/v1/users/me — the authenticated user's private view. */
  async me(): Promise<CurrentUserView> {
    const raw = await this.request<Wire>("/api/v1/users/me");
    this.sessionLikely = true;
    return normalizeCurrentUser(raw);
  }

  private acceptAuthResponse(raw: Wire): AuthResult {
    const tokens = normalizeTokenPair(raw["tokens"]);
    if (tokens) {
      this.accessToken = tokens.accessToken;
      this.refreshToken = tokens.refreshToken || this.refreshToken;
      this.sessionLikely = true;
    }
    const user = isWire(raw["user"]) ? normalizeCurrentUser(raw["user"]) : null;
    return {
      user,
      tokens,
      totpRequired: raw["totp_required"] === true,
      challengeToken:
        typeof raw["challenge_token"] === "string" ? raw["challenge_token"] : null,
      devVerificationUrl:
        typeof raw["dev_verification_url"] === "string"
          ? raw["dev_verification_url"]
          : null,
    };
  }

  /**
   * POST /api/v1/auth/verify-email — consumes the token from the emailed
   * link; on success the account's email is verified and its trust tier is
   * promoted T0 → T1. Bad/expired/used tokens throw a GGApiError (400) with
   * the API's single generic message.
   */
  async verifyEmail(token: string): Promise<VerifyEmailResult> {
    const raw = await this.request<Wire>("/api/v1/auth/verify-email", {
      method: "POST",
      anonymous: true,
      body: { token },
    });
    return {
      emailVerified: raw["email_verified"] === true,
      user: isWire(raw["user"]) ? normalizeCurrentUser(raw["user"]) : null,
    };
  }

  /**
   * POST /api/v1/auth/resend-verification — issues a fresh verification
   * link (invalidating the previous one; rate-limited to 3/hour). A no-op
   * with status "already_verified" when the account is already verified.
   */
  async resendVerification(): Promise<ResendVerificationResult> {
    const raw = await this.request<Wire>("/api/v1/auth/resend-verification", {
      method: "POST",
      body: {},
    });
    return {
      status: raw["status"] === "already_verified" ? "already_verified" : "pending",
      devVerificationUrl:
        typeof raw["dev_verification_url"] === "string"
          ? raw["dev_verification_url"]
          : null,
    };
  }

  // ─── Password reset (hardening, D-070) ──────────────────────────────────

  /** POST /api/v1/auth/password/forgot — always "pending" (enumeration-safe). */
  async forgotPassword(email: string): Promise<ForgotPasswordResult> {
    const raw = await this.request<Wire>("/api/v1/auth/password/forgot", {
      method: "POST",
      anonymous: true,
      body: { email },
    });
    return {
      status: "pending",
      devResetUrl:
        typeof raw["dev_reset_url"] === "string" ? raw["dev_reset_url"] : null,
    };
  }

  /** POST /api/v1/auth/password/reset — consumes the emailed token. */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    await this.request<Wire>("/api/v1/auth/password/reset", {
      method: "POST",
      anonymous: true,
      body: { token, new_password: newPassword },
    });
  }

  // ─── Two-factor auth (hardening, D-067/D-068) ───────────────────────────

  /** GET /api/v1/auth/2fa/status — TOTP state + passkey list. */
  async twoFactorStatus(): Promise<TwoFactorStatus> {
    const raw = await this.request<Wire>("/api/v1/auth/2fa/status");
    const passkeys = Array.isArray(raw["passkeys"])
      ? (raw["passkeys"] as Wire[]).map(
          (row): PasskeyView => ({
            id: String(row["id"] ?? ""),
            label: typeof row["label"] === "string" ? row["label"] : null,
            createdAt: String(row["created_at"] ?? ""),
            lastUsedAt:
              typeof row["last_used_at"] === "string" ? row["last_used_at"] : null,
          }),
        )
      : [];
    return {
      totpEnabled: raw["totp_enabled"] === true,
      hasPasskey: raw["has_passkey"] === true,
      passkeys,
    };
  }

  /** POST /api/v1/auth/2fa/totp — begin enrollment; render the URI as a QR. */
  async beginTotp(): Promise<{ otpauthUri: string }> {
    const raw = await this.request<Wire>("/api/v1/auth/2fa/totp", {
      method: "POST",
      body: {},
    });
    return { otpauthUri: String(raw["otpauth_uri"] ?? "") };
  }

  /**
   * POST /api/v1/auth/2fa/totp/verify — with a challengeToken it completes
   * a gated login (returns a full AuthResult and stores the session);
   * without one it completes enrollment (returns recovery codes) or acts
   * as a step-up proof.
   */
  async verifyTotp(input: {
    code: string;
    challengeToken?: string;
  }): Promise<AuthResult & TotpVerifyResult> {
    const raw = await this.request<Wire>("/api/v1/auth/2fa/totp/verify", {
      method: "POST",
      anonymous: input.challengeToken !== undefined,
      body: {
        code: input.code,
        ...(input.challengeToken ? { challenge_token: input.challengeToken } : {}),
      },
    });
    const auth = this.acceptAuthResponse(raw);
    return {
      ...auth,
      status: typeof raw["status"] === "string" ? raw["status"] : "ok",
      recoveryCodes: Array.isArray(raw["recovery_codes"])
        ? (raw["recovery_codes"] as unknown[]).map(String)
        : [],
    };
  }

  /** DELETE /api/v1/auth/2fa/totp — disables TOTP (password + code). */
  async disableTotp(input: { password: string; code: string }): Promise<void> {
    const fields: Record<string, string> = { code: input.code };
    fields["password"] = input.password;
    await this.request<Wire>("/api/v1/auth/2fa/totp", {
      method: "DELETE",
      body: fields,
    });
  }

  // ─── Passkeys (hardening, D-068) — options/verify pass-throughs; the
  // browser ceremony itself runs via @simplewebauthn/browser in the web app.

  async passkeyRegisterOptions(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      "/api/v1/auth/passkeys/register/options",
      { method: "POST", body: {} },
    );
  }

  async passkeyRegisterVerify(
    credential: Record<string, unknown>,
    label?: string,
  ): Promise<void> {
    await this.request<Wire>("/api/v1/auth/passkeys/register/verify", {
      method: "POST",
      body: { credential, ...(label ? { label } : {}) },
    });
  }

  async passkeyLoginOptions(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      "/api/v1/auth/passkeys/login/options",
      { method: "POST", anonymous: true, body: {} },
    );
  }

  async passkeyLoginVerify(
    credential: Record<string, unknown>,
  ): Promise<AuthResult> {
    const raw = await this.request<Wire>("/api/v1/auth/passkeys/login/verify", {
      method: "POST",
      anonymous: true,
      body: { credential },
    });
    return this.acceptAuthResponse(raw);
  }

  async deletePasskey(id: string): Promise<void> {
    await this.request<Wire>(`/api/v1/auth/passkeys/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  // ─── Social sign-in (hardening, D-069) ──────────────────────────────────

  /** GET /api/v1/auth/oauth/providers — only configured providers appear. */
  async socialProviders(): Promise<SocialProvider[]> {
    const raw = await this.request<Wire>("/api/v1/auth/oauth/providers", {
      anonymous: true,
    });
    return Array.isArray(raw["providers"])
      ? (raw["providers"] as Wire[]).map((row) => ({
          id: String(row["id"] ?? ""),
          name: String(row["name"] ?? ""),
        }))
      : [];
  }

  /** The URL the browser navigates to in order to start social sign-in. */
  socialAuthorizeUrl(provider: string): string {
    return `${this.baseUrl}/api/v1/auth/oauth/${encodeURIComponent(provider)}/authorize`;
  }

  // ─── OAuth consent (authorization-code grant, D-066) ────────────────────

  async oauthAuthorizeInfo(params: {
    clientId: string;
    redirectUri: string;
    scope?: string;
    state?: string;
  }): Promise<OAuthAuthorizeInfo> {
    const query = new URLSearchParams({
      client_id: params.clientId,
      redirect_uri: params.redirectUri,
    });
    if (params.scope) query.set("scope", params.scope);
    if (params.state) query.set("state", params.state);
    const raw = await this.request<Wire>(`/api/v1/oauth/authorize?${query.toString()}`);
    return {
      clientId: String(raw["client_id"] ?? ""),
      clientName: String(raw["client_name"] ?? ""),
      scopes: Array.isArray(raw["scopes"]) ? (raw["scopes"] as unknown[]).map(String) : [],
      redirectUri: String(raw["redirect_uri"] ?? ""),
      state: typeof raw["state"] === "string" ? raw["state"] : null,
    };
  }

  async oauthAuthorizeDecision(input: {
    clientId: string;
    redirectUri: string;
    scope?: string;
    state?: string;
    codeChallenge: string;
    decision: "approve" | "deny";
  }): Promise<{ redirectTo: string }> {
    const raw = await this.request<Wire>("/api/v1/oauth/authorize", {
      method: "POST",
      body: {
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
        ...(input.scope ? { scope: input.scope } : {}),
        ...(input.state ? { state: input.state } : {}),
        code_challenge: input.codeChallenge,
        code_challenge_method: "S256",
        decision: input.decision,
      },
    });
    return { redirectTo: String(raw["redirect_to"] ?? "") };
  }

  // ─── Users & follows ──────────────────────────────────────────────────────

  /** GET /api/v1/users/{handle} */
  async getUserByHandle(handle: string): Promise<ProfileView> {
    const raw = await this.request<Wire>(
      `/api/v1/users/${encodeURIComponent(handle)}`,
      { anonymous: this.accessToken === null },
    );
    return normalizeProfile(raw);
  }

  /** GET /api/v1/users/{handle}/posts */
  listUserPosts(
    handle: string,
    params: PageParams & { tab?: UserPostsTab } = {},
  ): Promise<CursorPage<PostView>> {
    const qs = queryString({
      cursor: params.cursor,
      limit: params.limit,
      tab: params.tab,
    });
    return this.request<Wire>(`/api/v1/users/${encodeURIComponent(handle)}/posts${qs}`, {
      anonymous: this.accessToken === null,
    }).then((raw) => normalizePage(raw, normalizePost));
  }

  /** POST /api/v1/users/{handle}/follow — returns the resulting follow state. */
  async followUser(handle: string): Promise<{ state: "following" | "requested" }> {
    const raw = await this.request<Wire>(
      `/api/v1/users/${encodeURIComponent(handle)}/follow`,
      { method: "POST", headers: { "Idempotency-Key": idempotencyKey() } },
    );
    // The API answers 204 No Content on success (request() yields
    // undefined); only a JSON body can carry an explicit follow state.
    const state = isWire(raw) ? raw["state"] : undefined;
    return { state: state === "requested" ? "requested" : "following" };
  }

  /** DELETE /api/v1/users/{handle}/follow */
  unfollowUser(handle: string): Promise<void> {
    return this.request<void>(`/api/v1/users/${encodeURIComponent(handle)}/follow`, {
      method: "DELETE",
    });
  }

  /** POST /api/v1/users/{handle}/block — severs follows both ways. */
  blockUser(handle: string): Promise<void> {
    return this.request<void>(`/api/v1/users/${encodeURIComponent(handle)}/block`, {
      method: "POST",
      body: {},
    });
  }

  /** DELETE /api/v1/users/{handle}/block */
  unblockUser(handle: string): Promise<void> {
    return this.request<void>(`/api/v1/users/${encodeURIComponent(handle)}/block`, {
      method: "DELETE",
    });
  }

  /** GET /api/v1/users/{handle}/followers */
  listFollowers(handle: string, params: PageParams = {}): Promise<CursorPage<ProfileView>> {
    const qs = queryString({ cursor: params.cursor, limit: params.limit });
    return this.request<Wire>(
      `/api/v1/users/${encodeURIComponent(handle)}/followers${qs}`,
      { anonymous: this.accessToken === null },
    ).then((raw) => normalizePage(raw, normalizeProfile));
  }

  /** GET /api/v1/users/{handle}/following */
  listFollowing(handle: string, params: PageParams = {}): Promise<CursorPage<ProfileView>> {
    const qs = queryString({ cursor: params.cursor, limit: params.limit });
    return this.request<Wire>(
      `/api/v1/users/${encodeURIComponent(handle)}/following${qs}`,
      { anonymous: this.accessToken === null },
    ).then((raw) => normalizePage(raw, normalizeProfile));
  }

  // ─── Feeds ────────────────────────────────────────────────────────────────

  /** GET /api/v1/feed — home feed (tab: for_you | following). */
  getFeed(
    params: PageParams & { tab?: FeedTab } = {},
  ): Promise<CursorPage<PostView>> {
    const qs = queryString({
      cursor: params.cursor,
      limit: params.limit,
      tab: params.tab,
    });
    return this.request<Wire>(`/api/v1/feed${qs}`).then((raw) =>
      normalizePage(raw, normalizeFeedItem),
    );
  }

  /** GET /api/v1/explore — public explore feed. */
  getExplore(
    params: PageParams & { topic?: string } = {},
  ): Promise<CursorPage<PostView>> {
    const qs = queryString({
      cursor: params.cursor,
      limit: params.limit,
      topic: params.topic,
    });
    return this.request<Wire>(`/api/v1/explore${qs}`, {
      anonymous: this.accessToken === null,
    }).then((raw) => normalizePage(raw, normalizeFeedItem));
  }

  // ─── Posts ────────────────────────────────────────────────────────────────

  /** POST /api/v1/posts — one endpoint for posts, replies, quotes and reposts. */
  async createPost(input: CreatePostInput): Promise<PostView> {
    const raw = await this.request<Wire>("/api/v1/posts", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: {
        type: input.type ?? "TEXT",
        body_md: input.body,
        parent_id: input.parentId,
        quoted_post_id: input.quotedPostId,
        repost_of_id: input.repostOfId,
        community_slug: input.communitySlug,
        title: input.title,
        media_ids: input.mediaIds,
        link_url: input.linkUrl,
        visibility: input.visibility,
        is_nsfw: input.isNsfw,
        is_spoiler: input.isSpoiler,
        poll: input.poll
          ? {
              question: input.poll.question,
              type: input.poll.type,
              options: input.poll.options?.map((o) => ({ text: o.text, media_id: o.mediaId })),
              result_mode: input.poll.resultMode,
              is_anonymous: input.poll.isAnonymous,
              closes_at: input.poll.closesAt,
              min_trust_tier: input.poll.minTrustTier,
              max_choices: input.poll.maxChoices,
            }
          : undefined,
        debate: input.debate ? debateCreateBody(input.debate) : undefined,
        scheduled_for: input.scheduledFor,
      },
    });
    return normalizePost(raw);
  }

  /** GET /api/v1/posts/{postId} */
  async getPost(postId: string): Promise<PostView> {
    const raw = await this.request<Wire>(`/api/v1/posts/${encodeURIComponent(postId)}`, {
      anonymous: this.accessToken === null,
    });
    return normalizePost(raw);
  }

  /** PATCH /api/v1/posts/{postId} */
  async updatePost(postId: string, input: UpdatePostInput): Promise<PostView> {
    const raw = await this.request<Wire>(`/api/v1/posts/${encodeURIComponent(postId)}`, {
      method: "PATCH",
      body: {
        body_md: input.body,
        title: input.title,
        is_nsfw: input.isNsfw,
        is_spoiler: input.isSpoiler,
        scheduled_for: input.scheduledFor,
      },
    });
    return normalizePost(raw);
  }

  /** DELETE /api/v1/posts/{postId} — soft delete. */
  deletePost(postId: string): Promise<void> {
    return this.request<void>(`/api/v1/posts/${encodeURIComponent(postId)}`, {
      method: "DELETE",
    });
  }

  /** GET /api/v1/posts/{postId}/thread — root, ancestors and first reply page. */
  async getThread(
    postId: string,
    params: { sort?: ReplySort } = {},
  ): Promise<ThreadView> {
    const qs = queryString({ sort: params.sort });
    const raw = await this.request<Wire>(
      `/api/v1/posts/${encodeURIComponent(postId)}/thread${qs}`,
      { anonymous: this.accessToken === null },
    );
    const repliesRaw = isWire(raw) ? raw["replies"] : undefined;
    return {
      root: normalizePost(isWire(raw) ? raw["root"] : undefined),
      focus: normalizePost(isWire(raw) ? raw["focus"] : undefined),
      ancestors: Array.isArray(isWire(raw) ? raw["ancestors"] : undefined)
        ? (raw["ancestors"] as unknown[]).filter(isWire).map(normalizePost)
        : [],
      replies: normalizePage(repliesRaw, normalizePost),
    };
  }

  /** GET /api/v1/posts/{postId}/replies — direct replies, cursor-paginated. */
  listReplies(
    postId: string,
    params: PageParams & { sort?: ReplySort } = {},
  ): Promise<CursorPage<PostView>> {
    const qs = queryString({
      cursor: params.cursor,
      limit: params.limit,
      sort: params.sort,
    });
    return this.request<Wire>(
      `/api/v1/posts/${encodeURIComponent(postId)}/replies${qs}`,
      { anonymous: this.accessToken === null },
    ).then((raw) => normalizePage(raw, normalizePost));
  }

  /** GET /api/v1/posts/{postId}/subtree — flattened descendants for "continue this thread". */
  getSubtree(
    postId: string,
    params: PageParams & { maxDepth?: number } = {},
  ): Promise<CursorPage<PostView>> {
    const qs = queryString({
      cursor: params.cursor,
      limit: params.limit,
      max_depth: params.maxDepth,
    });
    return this.request<Wire>(
      `/api/v1/posts/${encodeURIComponent(postId)}/subtree${qs}`,
      { anonymous: this.accessToken === null },
    ).then((raw) => normalizePage(raw, normalizePost));
  }

  /**
   * PUT /api/v1/posts/{postId}/vote — cast or change a vote (idempotent set).
   * The spec requires an Idempotency-Key on vote writes; one is generated
   * per call.
   */
  async voteOnPost(postId: string, value: VoteValue): Promise<VoteSummaryView> {
    const raw = await this.request<Wire>(
      `/api/v1/posts/${encodeURIComponent(postId)}/vote`,
      {
        method: "PUT",
        headers: { "Idempotency-Key": idempotencyKey() },
        body: { value },
      },
    );
    return normalizeVoteSummary(raw);
  }

  /** DELETE /api/v1/posts/{postId}/vote — retract the viewer's vote. */
  async retractPostVote(postId: string): Promise<VoteSummaryView> {
    const raw = await this.request<Wire>(
      `/api/v1/posts/${encodeURIComponent(postId)}/vote`,
      { method: "DELETE" },
    );
    return normalizeVoteSummary(raw);
  }

  /** POST /api/v1/posts/{postId}/reactions — returns the post's reaction counts. */
  async reactToPost(
    postId: string,
    kind: ReactionKind,
  ): Promise<Record<string, number>> {
    const raw = await this.request<Wire>(
      `/api/v1/posts/${encodeURIComponent(postId)}/reactions`,
      { method: "POST", body: { kind } },
    );
    const counts = isWire(raw) ? raw["counts"] : undefined;
    return isWire(counts) ? (counts as Record<string, number>) : {};
  }

  /** DELETE /api/v1/posts/{postId}/reactions?kind= */
  removeReaction(postId: string, kind: ReactionKind): Promise<void> {
    const qs = queryString({ kind });
    return this.request<void>(
      `/api/v1/posts/${encodeURIComponent(postId)}/reactions${qs}`,
      { method: "DELETE" },
    );
  }

  /** POST /api/v1/posts/{postId}/bookmark */
  bookmarkPost(postId: string, collectionId?: string): Promise<void> {
    return this.request<void>(`/api/v1/posts/${encodeURIComponent(postId)}/bookmark`, {
      method: "POST",
      body: collectionId ? { collection_id: collectionId } : {},
    });
  }

  /** DELETE /api/v1/posts/{postId}/bookmark */
  unbookmarkPost(postId: string): Promise<void> {
    return this.request<void>(`/api/v1/posts/${encodeURIComponent(postId)}/bookmark`, {
      method: "DELETE",
    });
  }

  /** GET /api/v1/users/me/bookmarks */
  listBookmarks(params: PageParams = {}): Promise<CursorPage<PostView>> {
    const qs = queryString({ cursor: params.cursor, limit: params.limit });
    return this.request<Wire>(`/api/v1/users/me/bookmarks${qs}`).then((raw) =>
      normalizePage(raw, normalizePost),
    );
  }


  // ─── Polls (Phase 3) ──────────────────────────────────────────────────────

  /** POST /api/v1/polls — creates the poll and its host POLL post. */
  async createPoll(input: CreatePollInput): Promise<PollView> {
    const raw = await this.request<Wire>("/api/v1/polls", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: {
        question: input.question,
        type: input.type,
        options: input.options?.map((o) => ({ text: o.text, media_id: o.mediaId })),
        result_mode: input.resultMode,
        is_anonymous: input.isAnonymous,
        closes_at: input.closesAt,
        min_trust_tier: input.minTrustTier,
        max_choices: input.maxChoices,
        community_slug: input.communitySlug,
        body_md: input.bodyMd,
      },
    });
    return normalizePoll(raw);
  }

  /** GET /api/v1/polls/{pollId} */
  async getPoll(pollId: string): Promise<PollView> {
    const raw = await this.request<Wire>(`/api/v1/polls/${encodeURIComponent(pollId)}`, {
      anonymous: this.accessToken === null,
    });
    return normalizePoll(raw);
  }

  /** GET /api/v1/polls/daily-pulse — today's platform question. */
  async getDailyPulse(): Promise<PollView> {
    const raw = await this.request<Wire>("/api/v1/polls/daily-pulse", {
      anonymous: this.accessToken === null,
    });
    return normalizePoll(raw);
  }

  /** POST /api/v1/polls/{pollId}/votes — cast or change a ballot. */
  async votePoll(pollId: string, ballot: PollBallotInput): Promise<PollResultsView> {
    const raw = await this.request<Wire>(`/api/v1/polls/${encodeURIComponent(pollId)}/votes`, {
      method: "POST",
      body: {
        option_id: ballot.optionId,
        option_ids: ballot.optionIds,
        ranking: ballot.ranking,
        slider_value: ballot.sliderValue,
      },
    });
    return normalizePollResults(raw);
  }

  /** DELETE /api/v1/polls/{pollId}/votes — retract the viewer's ballot. */
  async retractPollVote(pollId: string): Promise<PollResultsView> {
    const raw = await this.request<Wire>(`/api/v1/polls/${encodeURIComponent(pollId)}/votes`, {
      method: "DELETE",
    });
    return normalizePollResults(raw);
  }

  /** GET /api/v1/polls/{pollId}/results — 403 while result_mode hides them. */
  async getPollResults(pollId: string): Promise<PollResultsView> {
    const raw = await this.request<Wire>(`/api/v1/polls/${encodeURIComponent(pollId)}/results`, {
      anonymous: this.accessToken === null,
    });
    return normalizePollResults(raw);
  }

  /** POST /api/v1/polls/{pollId}/close — author only. */
  async closePoll(pollId: string): Promise<PollView> {
    const raw = await this.request<Wire>(`/api/v1/polls/${encodeURIComponent(pollId)}/close`, {
      method: "POST",
      body: {},
    });
    return normalizePoll(raw);
  }

  // ─── Debates (Phase 3) ──────────────────────────────────────────────────────

  /** GET /api/v1/debates — filter by status/format/community/topic. */
  listDebates(
    params: PageParams & { status?: string; format?: string; communitySlug?: string; topic?: string } = {},
  ): Promise<CursorPage<DebateView>> {
    const qs = queryString({
      cursor: params.cursor,
      limit: params.limit,
      status: params.status,
      format: params.format,
      community_slug: params.communitySlug,
      topic: params.topic,
    });
    return this.request<Wire>(`/api/v1/debates${qs}`, {
      anonymous: this.accessToken === null,
    }).then((raw) => normalizePage(raw, normalizeDebate));
  }

  /** POST /api/v1/debates */
  async createDebate(input: CreateDebateInput): Promise<DebateView> {
    const raw = await this.request<Wire>("/api/v1/debates", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: debateCreateBody(input),
    });
    return normalizeDebate(raw);
  }

  /** POST /api/v1/debates/from-article — "Debate this article" (genznewz). */
  async createDebateFromArticle(input: {
    articleUrl: string;
    /** Optional — defaults to the article's headline on the server. */
    proposition?: string;
    communitySlug?: string;
  }): Promise<DebateView> {
    const raw = await this.request<Wire>("/api/v1/debates/from-article", {
      method: "POST",
      body: {
        article_url: input.articleUrl,
        proposition: input.proposition,
        community_slug: input.communitySlug,
      },
    });
    return normalizeDebate(raw);
  }

  /** GET /api/v1/debates/{debateId} (uuid or short code). */
  async getDebate(debateId: string): Promise<DebateView> {
    const raw = await this.request<Wire>(`/api/v1/debates/${encodeURIComponent(debateId)}`, {
      anonymous: this.accessToken === null,
    });
    return normalizeDebate(raw);
  }

  /** POST /api/v1/debates/{debateId}/join */
  async joinDebate(debateId: string, sideKey: string): Promise<DebateView> {
    const raw = await this.request<Wire>(`/api/v1/debates/${encodeURIComponent(debateId)}/join`, {
      method: "POST",
      body: { side_key: sideKey },
    });
    return normalizeDebate(raw);
  }

  /** POST /api/v1/debates/{debateId}/challenges */
  async challengeToDebate(
    debateId: string,
    input: { challengedHandle: string; sideKey: string; message?: string },
  ): Promise<{ id: string }> {
    return this.request<{ id: string }>(`/api/v1/debates/${encodeURIComponent(debateId)}/challenges`, {
      method: "POST",
      body: {
        challenged_handle: input.challengedHandle,
        side_key: input.sideKey,
        message: input.message,
      },
    });
  }

  /** POST /api/v1/debates/{debateId}/challenges/{challengeId}/respond */
  async respondToChallenge(
    debateId: string,
    challengeId: string,
    decision: "accept" | "decline",
  ): Promise<DebateView> {
    const raw = await this.request<Wire>(
      `/api/v1/debates/${encodeURIComponent(debateId)}/challenges/${encodeURIComponent(challengeId)}/respond`,
      { method: "POST", body: { decision } },
    );
    return normalizeDebate(raw);
  }

  /** GET /api/v1/debates/{debateId}/arguments */
  listArguments(
    debateId: string,
    params: { sideKey?: string; roundNo?: number; sort?: "top" | "new" } = {},
  ): Promise<CursorPage<ArgumentView>> {
    const qs = queryString({
      side_key: params.sideKey,
      round_no: params.roundNo,
      sort: params.sort,
    });
    return this.request<Wire>(`/api/v1/debates/${encodeURIComponent(debateId)}/arguments${qs}`, {
      anonymous: this.accessToken === null,
    }).then((raw) => normalizePage(raw, normalizeArgument));
  }

  /** POST /api/v1/debates/{debateId}/arguments — open/team debates. */
  async createArgument(debateId: string, input: CreateArgumentInput): Promise<ArgumentView> {
    const raw = await this.request<Wire>(`/api/v1/debates/${encodeURIComponent(debateId)}/arguments`, {
      method: "POST",
      body: {
        side_key: input.sideKey,
        body_md: input.bodyMd,
        parent_argument_id: input.parentArgumentId,
        is_steelman: input.isSteelman,
        evidence: input.evidence?.map(evidenceBody),
      },
    });
    return normalizeArgument(raw);
  }

  /** POST /api/v1/debates/{debateId}/rounds/{roundNo}/submit — structured turns. */
  async submitRound(
    debateId: string,
    roundNo: number,
    input: { bodyMd: string; isSteelman?: boolean; evidence?: EvidenceInput[] },
  ): Promise<DebateView> {
    const raw = await this.request<Wire>(
      `/api/v1/debates/${encodeURIComponent(debateId)}/rounds/${roundNo}/submit`,
      {
        method: "POST",
        body: {
          body_md: input.bodyMd,
          is_steelman: input.isSteelman,
          evidence: input.evidence?.map(evidenceBody),
        },
      },
    );
    return normalizeDebate(raw);
  }

  /** PUT /api/v1/arguments/{argumentId}/vote */
  async voteArgument(argumentId: string, value: "up" | "down"): Promise<VoteSummaryView> {
    const raw = await this.request<Wire>(`/api/v1/arguments/${encodeURIComponent(argumentId)}/vote`, {
      method: "PUT",
      body: { value },
    });
    return normalizeVoteSummary(raw);
  }

  /** DELETE /api/v1/arguments/{argumentId}/vote */
  async retractArgumentVote(argumentId: string): Promise<VoteSummaryView> {
    const raw = await this.request<Wire>(`/api/v1/arguments/${encodeURIComponent(argumentId)}/vote`, {
      method: "DELETE",
    });
    return normalizeVoteSummary(raw);
  }

  /** POST /api/v1/arguments/{argumentId}/evidence */
  async addEvidence(argumentId: string, evidence: EvidenceInput[]): Promise<ArgumentView> {
    const raw = await this.request<Wire>(`/api/v1/arguments/${encodeURIComponent(argumentId)}/evidence`, {
      method: "POST",
      body: { evidence: evidence.map(evidenceBody) },
    });
    return normalizeArgument(raw);
  }

  /** POST /api/v1/arguments/{argumentId}/steelman-confirm */
  confirmSteelman(argumentId: string): Promise<void> {
    return this.request<void>(`/api/v1/arguments/${encodeURIComponent(argumentId)}/steelman-confirm`, {
      method: "POST",
      body: {},
    });
  }

  /** POST /api/v1/debates/{debateId}/stance-votes */
  async castStanceVote(
    debateId: string,
    input: { phase: "pre" | "post"; stanceValue: number },
  ): Promise<DebateStateView> {
    const raw = await this.request<Wire>(`/api/v1/debates/${encodeURIComponent(debateId)}/stance-votes`, {
      method: "POST",
      body: { phase: input.phase, stance_value: input.stanceValue },
    });
    return normalizeDebateState(raw);
  }

  /** GET /api/v1/debates/{debateId}/state */
  async getDebateState(debateId: string): Promise<DebateStateView> {
    const raw = await this.request<Wire>(`/api/v1/debates/${encodeURIComponent(debateId)}/state`, {
      anonymous: this.accessToken === null,
    });
    return normalizeDebateState(raw);
  }

  /** GET /api/v1/debates/{debateId}/perspective — the "Other side" card. */
  async getDebatePerspective(debateId: string): Promise<ArgumentView> {
    const raw = await this.request<Wire>(`/api/v1/debates/${encodeURIComponent(debateId)}/perspective`, {
      anonymous: this.accessToken === null,
    });
    return normalizeArgument(raw);
  }

  /** POST /api/v1/debates/{debateId}/close — host/judge/admin. */
  async closeDebate(debateId: string): Promise<DebateView> {
    const raw = await this.request<Wire>(`/api/v1/debates/${encodeURIComponent(debateId)}/close`, {
      method: "POST",
      body: {},
    });
    return normalizeDebate(raw);
  }

  /** POST /api/v1/debates/{debateId}/judge-decision (D-032 delta). */
  async judgeDecision(
    debateId: string,
    input: { winnerSideKey?: string; isDraw?: boolean },
  ): Promise<DebateView> {
    const raw = await this.request<Wire>(`/api/v1/debates/${encodeURIComponent(debateId)}/judge-decision`, {
      method: "POST",
      body: { winner_side_key: input.winnerSideKey, is_draw: input.isDraw },
    });
    return normalizeDebate(raw);
  }

  // ─── Context notes (Phase 3) ──────────────────────────────────────────────

  /** POST /api/v1/posts/{postId}/notes */
  async createNote(
    postId: string,
    input: { body: string; sources?: string[] },
  ): Promise<ContextNoteView> {
    const raw = await this.request<Wire>(`/api/v1/posts/${encodeURIComponent(postId)}/notes`, {
      method: "POST",
      body: { body: input.body, sources: input.sources },
    });
    return normalizeContextNote(raw);
  }

  /** GET /api/v1/posts/{postId}/notes */
  listNotes(postId: string): Promise<CursorPage<ContextNoteView>> {
    return this.request<Wire>(`/api/v1/posts/${encodeURIComponent(postId)}/notes`, {
      anonymous: this.accessToken === null,
    }).then((raw) => normalizePage(raw, normalizeContextNote));
  }

  /** POST /api/v1/notes/{noteId}/ratings */
  rateNote(noteId: string, rating: "helpful" | "somewhat" | "not_helpful"): Promise<void> {
    return this.request<void>(`/api/v1/notes/${encodeURIComponent(noteId)}/ratings`, {
      method: "POST",
      body: { rating },
    });
  }

  // ─── Communities ──────────────────────────────────────────────────────────

  /** GET /api/v1/communities */
  listCommunities(
    params: PageParams & { q?: string; topic?: string } = {},
  ): Promise<CursorPage<CommunityView>> {
    const qs = queryString({
      cursor: params.cursor,
      limit: params.limit,
      q: params.q,
      topic: params.topic,
    });
    return this.request<Wire>(`/api/v1/communities${qs}`, {
      anonymous: this.accessToken === null,
    }).then((raw) => normalizePage(raw, normalizeCommunity));
  }

  /** GET /api/v1/communities/{slug} */
  async getCommunity(slug: string): Promise<CommunityView> {
    const raw = await this.request<Wire>(
      `/api/v1/communities/${encodeURIComponent(slug)}`,
      { anonymous: this.accessToken === null },
    );
    return normalizeCommunity(raw);
  }

  /** GET /api/v1/communities/{slug}/posts */
  listCommunityPosts(
    slug: string,
    params: PageParams & { sort?: CommunityPostSort } = {},
  ): Promise<CursorPage<PostView>> {
    const qs = queryString({
      cursor: params.cursor,
      limit: params.limit,
      sort: params.sort,
    });
    return this.request<Wire>(
      `/api/v1/communities/${encodeURIComponent(slug)}/posts${qs}`,
      { anonymous: this.accessToken === null },
    ).then((raw) => normalizePage(raw, normalizePost));
  }

  /** POST /api/v1/communities/{slug}/join */
  async joinCommunity(slug: string): Promise<MembershipView> {
    const raw = await this.request<Wire>(
      `/api/v1/communities/${encodeURIComponent(slug)}/join`,
      { method: "POST" },
    );
    return normalizeMembership(raw);
  }

  /** DELETE /api/v1/communities/{slug}/join */
  leaveCommunity(slug: string): Promise<void> {
    return this.request<void>(`/api/v1/communities/${encodeURIComponent(slug)}/join`, {
      method: "DELETE",
    });
  }

  // ─── Reports & moderation ─────────────────────────────────────────────────

  /**
   * POST /api/v1/reports — file a report. A duplicate open report by the
   * same reporter on the same target returns the existing report (200).
   */
  async createReport(input: CreateReportInput): Promise<ReportView> {
    const raw = await this.request<Wire>("/api/v1/reports", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: {
        target_type: input.targetType,
        target_id: input.targetId,
        reason: input.reason,
        details: input.details,
      },
    });
    return normalizeReport(raw);
  }

  /** GET /api/v1/reports/{reportId} — status of own report (or as a mod). */
  async getReport(reportId: string): Promise<ReportView> {
    const raw = await this.request<Wire>(
      `/api/v1/reports/${encodeURIComponent(reportId)}`,
    );
    return normalizeReport(raw);
  }

  /** PATCH /api/v1/reports/{reportId} — resolve (owning-community mods). */
  async resolveReport(
    reportId: string,
    input: ResolveReportInput,
  ): Promise<ReportView> {
    const raw = await this.request<Wire>(
      `/api/v1/reports/${encodeURIComponent(reportId)}`,
      {
        method: "PATCH",
        body: { status: input.status, resolution: input.resolution },
      },
    );
    return normalizeReport(raw);
  }

  /** GET /api/v1/communities/{slug}/mod/queue — severity-ordered triage queue (mods+). */
  listModQueue(
    slug: string,
    params: PageParams & { kind?: "reports" | "held" | "all" } = {},
  ): Promise<CursorPage<ModQueueItemView>> {
    const qs = queryString({
      cursor: params.cursor,
      limit: params.limit,
      kind: params.kind,
    });
    return this.request<Wire>(
      `/api/v1/communities/${encodeURIComponent(slug)}/mod/queue${qs}`,
    ).then((raw) => normalizePage(raw, normalizeModQueueItem));
  }

  // ─── Phase 5B: AutoMod, lockdown, mod actions, membership, mod mail ──────

  /** GET /api/v1/communities/{slug}/mod/automod-rules (mods+). */
  async listAutomodRules(slug: string): Promise<AutomodRuleView[]> {
    const raw = await this.request<Wire>(
      `/api/v1/communities/${encodeURIComponent(slug)}/mod/automod-rules`,
    );
    // The endpoint answers with the standard { data } page envelope.
    const rows = Array.isArray(raw)
      ? raw
      : isWire(raw) && Array.isArray(raw["data"])
        ? raw["data"]
        : [];
    return rows.filter(isWire).map(normalizeAutomodRule);
  }

  /** POST /api/v1/communities/{slug}/mod/automod-rules (mods+). */
  async createAutomodRule(
    slug: string,
    input: CreateAutomodRuleInput,
  ): Promise<AutomodRuleView> {
    const raw = await this.request<Wire>(
      `/api/v1/communities/${encodeURIComponent(slug)}/mod/automod-rules`,
      {
        method: "POST",
        body: {
          kind: input.kind,
          config: input.config,
          action: input.action,
          is_enabled: input.isEnabled,
        },
      },
    );
    return normalizeAutomodRule(raw);
  }

  /** PATCH /api/v1/communities/{slug}/mod/automod-rules/{ruleId} (mods+). */
  async updateAutomodRule(
    slug: string,
    ruleId: string,
    input: UpdateAutomodRuleInput,
  ): Promise<AutomodRuleView> {
    const raw = await this.request<Wire>(
      `/api/v1/communities/${encodeURIComponent(slug)}/mod/automod-rules/${encodeURIComponent(ruleId)}`,
      {
        method: "PATCH",
        body: {
          config: input.config,
          action: input.action,
          is_enabled: input.isEnabled,
        },
      },
    );
    return normalizeAutomodRule(raw);
  }

  /** DELETE /api/v1/communities/{slug}/mod/automod-rules/{ruleId} (mods+). */
  deleteAutomodRule(slug: string, ruleId: string): Promise<void> {
    return this.request<void>(
      `/api/v1/communities/${encodeURIComponent(slug)}/mod/automod-rules/${encodeURIComponent(ruleId)}`,
      { method: "DELETE" },
    );
  }

  /** POST /api/v1/communities/{slug}/lockdown — toggle lockdown (community admins). */
  async setLockdown(
    slug: string,
    input: { enabled: boolean; minMemberAgeDays?: number; minTrustTier?: string },
  ): Promise<CommunityView> {
    const raw = await this.request<Wire>(
      `/api/v1/communities/${encodeURIComponent(slug)}/lockdown`,
      {
        method: "POST",
        body: {
          enabled: input.enabled,
          min_member_age_days: input.minMemberAgeDays,
          min_trust_tier: input.minTrustTier,
        },
      },
    );
    return normalizeCommunity(raw);
  }

  /** POST /api/v1/communities/{slug}/mod/actions — apply a mod action (mods+). */
  async modAction(slug: string, input: ModActionInput): Promise<ModActionView> {
    const raw = await this.request<Wire>(
      `/api/v1/communities/${encodeURIComponent(slug)}/mod/actions`,
      {
        method: "POST",
        body: {
          action: input.action,
          target_type: input.targetType,
          target_id: input.targetId,
          user_id: input.userId,
          note: input.note,
        },
      },
    );
    return normalizeModAction(raw);
  }

  /** GET /api/v1/communities/{slug}/mod/log (mods+). */
  listModLog(
    slug: string,
    params: PageParams = {},
  ): Promise<CursorPage<ModActionView>> {
    const qs = queryString({ cursor: params.cursor, limit: params.limit });
    return this.request<Wire>(
      `/api/v1/communities/${encodeURIComponent(slug)}/mod/log${qs}`,
    ).then((raw) => normalizePage(raw, normalizeModAction));
  }

  /** GET /api/v1/communities/{slug}/mod/membership-requests (mods+). */
  listMembershipRequests(
    slug: string,
    params: PageParams = {},
  ): Promise<CursorPage<MembershipRequestView>> {
    const qs = queryString({ cursor: params.cursor, limit: params.limit });
    return this.request<Wire>(
      `/api/v1/communities/${encodeURIComponent(slug)}/mod/membership-requests${qs}`,
    ).then((raw) => normalizePage(raw, normalizeMembershipRequest));
  }

  /** POST /api/v1/communities/{slug}/mod/membership-requests/{handle} (mods+). */
  async decideMembershipRequest(
    slug: string,
    handle: string,
    input: { decision: "approve" | "reject" },
  ): Promise<MembershipRequestView> {
    const raw = await this.request<Wire>(
      `/api/v1/communities/${encodeURIComponent(slug)}/mod/membership-requests/${encodeURIComponent(handle)}`,
      { method: "POST", body: { decision: input.decision } },
    );
    return normalizeMembershipRequest(raw);
  }

  /**
   * POST /api/v1/communities/{slug}/mod/mail — open (or reuse) the mod-mail
   * thread with a member (mods pass `memberHandle`), or — as a member —
   * with the mod team. Returns the thread (the API wraps it with the
   * first message; unwrapped here).
   */
  async sendModMail(
    slug: string,
    input: { memberHandle?: string; subject?: string; body: string },
  ): Promise<ConversationView> {
    const raw = await this.request<Wire>(
      `/api/v1/communities/${encodeURIComponent(slug)}/mod/mail`,
      {
        method: "POST",
        body: {
          handle: input.memberHandle,
          subject: input.subject,
          body: input.body,
        },
      },
    );
    const conversation = isWire(raw) ? raw["conversation"] : null;
    return normalizeConversation(conversation ?? raw);
  }

  /** GET /api/v1/communities/{slug}/mod/mail — mod-mail threads (mods+). */
  listModMailThreads(
    slug: string,
    params: PageParams = {},
  ): Promise<CursorPage<ConversationView>> {
    const qs = queryString({ cursor: params.cursor, limit: params.limit });
    return this.request<Wire>(
      `/api/v1/communities/${encodeURIComponent(slug)}/mod/mail${qs}`,
    ).then((raw) => normalizePage(raw, normalizeConversation));
  }

  // ─── Phase 5B: platform analytics (platform admins) ──────────────────────

  /** GET /api/v1/admin/analytics?days= — 403 unless the caller is a platform admin. */
  async getAnalytics(days = 30): Promise<AnalyticsOverviewView> {
    const qs = queryString({ days });
    const raw = await this.request<Wire>(`/api/v1/admin/analytics${qs}`);
    return normalizeAnalyticsOverview(raw);
  }

  // ─── Phase 5B: web push subscriptions ────────────────────────────────────

  /** GET /api/v1/push/vapid-public-key — the key browsers subscribe with. */
  async getVapidPublicKey(): Promise<{ publicKey: string | null }> {
    const raw = await this.request<Wire>("/api/v1/push/vapid-public-key");
    return {
      publicKey:
        isWire(raw) && typeof raw["public_key"] === "string"
          ? raw["public_key"]
          : null,
    };
  }

  /** GET /api/v1/users/me/push-subscriptions */
  async listPushSubscriptions(): Promise<PushSubscriptionView[]> {
    const raw = await this.request<Wire[]>("/api/v1/users/me/push-subscriptions");
    return Array.isArray(raw) ? raw.map(normalizePushSubscription) : [];
  }

  /** POST /api/v1/users/me/push-subscriptions — upserts by endpoint. */
  async createPushSubscription(
    input: CreatePushSubscriptionInput,
  ): Promise<PushSubscriptionView> {
    const raw = await this.request<Wire>("/api/v1/users/me/push-subscriptions", {
      method: "POST",
      body: { endpoint: input.endpoint, keys: input.keys },
    });
    return normalizePushSubscription(raw);
  }

  /** DELETE /api/v1/users/me/push-subscriptions/{id} */
  deletePushSubscription(id: string): Promise<void> {
    return this.request<void>(
      `/api/v1/users/me/push-subscriptions/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }

  // ─── Profile update ───────────────────────────────────────────────────────

  /** PATCH /api/v1/users/me — update own profile fields. */
  async updateProfile(input: UpdateProfileInput): Promise<CurrentUserView> {
    const raw = await this.request<Wire>("/api/v1/users/me", {
      method: "PATCH",
      body: {
        display_name: input.displayName,
        bio: input.bio,
        website_url: input.websiteUrl,
        location: input.location,
        avatar_media_id: input.avatarMediaId,
        banner_media_id: input.bannerMediaId,
        is_private: input.isPrivate,
      },
    });
    return normalizeCurrentUser(raw);
  }

  // ─── Notifications ────────────────────────────────────────────────────────

  /** GET /api/v1/notifications — page plus the caller's unread count. */
  async listNotifications(
    params: PageParams & { unreadOnly?: boolean } = {},
  ): Promise<NotificationPage> {
    const qs = queryString({
      cursor: params.cursor,
      limit: params.limit,
      unread_only: params.unreadOnly ? "true" : undefined,
    });
    const raw = await this.request<Wire>(`/api/v1/notifications${qs}`);
    const page = normalizePage(raw, normalizeNotification);
    const unreadCount =
      isWire(raw) && typeof raw["unread_count"] === "number"
        ? raw["unread_count"]
        : page.items.filter((n) => n.readAt === null).length;
    return { items: page.items, nextCursor: page.nextCursor, unreadCount };
  }

  /** GET /api/v1/notifications/unread-count */
  async getUnreadNotificationCount(): Promise<number> {
    const raw = await this.request<Wire>("/api/v1/notifications/unread-count");
    return isWire(raw) && typeof raw["count"] === "number" ? raw["count"] : 0;
  }

  /** GET /api/v1/notifications/unread-count — notifications + DMs (D-053). */
  async getUnreadCounts(): Promise<UnreadCountsView> {
    const raw = await this.request<Wire>("/api/v1/notifications/unread-count");
    return {
      notifications: isWire(raw) && typeof raw["count"] === "number" ? raw["count"] : 0,
      dms: isWire(raw) && typeof raw["dm_count"] === "number" ? raw["dm_count"] : 0,
    };
  }

  /**
   * POST /api/v1/notifications/read — with no arguments marks everything
   * read; pass `ids` for a subset or `allBefore` (ISO timestamp) for a cutoff.
   */
  markNotificationsRead(input: { ids?: string[]; allBefore?: string } = {}): Promise<void> {
    return this.request<void>("/api/v1/notifications/read", {
      method: "POST",
      body: {
        ...(input.ids ? { ids: input.ids } : {}),
        ...(input.allBefore ? { all_before: input.allBefore } : {}),
      },
    });
  }

  /** GET /api/v1/notifications/preferences */
  async getNotificationPreferences(): Promise<NotificationPreferencesView> {
    const raw = await this.request<Wire>("/api/v1/notifications/preferences");
    return normalizeNotificationPreferences(raw);
  }

  /** PATCH /api/v1/notifications/preferences */
  async updateNotificationPreferences(
    input: NotificationPreferencesInput,
  ): Promise<NotificationPreferencesView> {
    const raw = await this.request<Wire>("/api/v1/notifications/preferences", {
      method: "PATCH",
      body: {
        ...(input.prefs ? { notification_prefs: input.prefs } : {}),
        ...(input.quietHours !== undefined ? { quiet_hours: input.quietHours } : {}),
      },
    });
    return normalizeNotificationPreferences(raw);
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  /** GET /api/v1/search — grouped results (posts / people / communities). */
  async search(
    params: { q: string; type?: SearchType; semantic?: boolean } & PageParams,
  ): Promise<SearchResultsView> {
    const qs = queryString({
      q: params.q,
      type: params.type,
      semantic: params.semantic ? "true" : undefined,
      cursor: params.cursor,
      limit: params.limit,
    });
    const raw = await this.request<Wire>(`/api/v1/search${qs}`, {
      anonymous: this.accessToken === null,
    });
    return normalizeSearchResults(raw);
  }

  /** GET /api/v1/search/suggest — typeahead for people + communities. */
  async searchSuggest(q: string): Promise<SearchSuggestion[]> {
    const qs = queryString({ q });
    const raw = await this.request<Wire>(`/api/v1/search/suggest${qs}`, {
      anonymous: this.accessToken === null,
    });
    return normalizeSearchSuggestions(raw);
  }

  // ─── Onboarding ───────────────────────────────────────────────────────────

  /** GET /api/v1/onboarding/suggested */
  async getOnboardingSuggested(): Promise<OnboardingSuggestedView> {
    const raw = await this.request<Wire>("/api/v1/onboarding/suggested");
    return normalizeOnboardingSuggested(raw);
  }

  /** POST /api/v1/onboarding/complete — records topics, stamps completion. */
  async completeOnboarding(input: { topics: string[] }): Promise<CurrentUserView> {
    const raw = await this.request<Wire>("/api/v1/onboarding/complete", {
      method: "POST",
      body: { topics: input.topics },
    });
    return normalizeCurrentUser(raw);
  }

  /** GET /api/v1/users/handle-available?handle= */
  async checkHandleAvailable(handle: string): Promise<HandleAvailability> {
    const qs = queryString({ handle });
    const raw = await this.request<Wire>(`/api/v1/users/handle-available${qs}`, {
      anonymous: true,
    });
    const reason = isWire(raw) ? raw["reason"] : null;
    return {
      handle:
        isWire(raw) && typeof raw["handle"] === "string" ? raw["handle"] : handle,
      available: isWire(raw) && raw["available"] === true,
      reason: reason === "taken" || reason === "invalid" ? reason : null,
    };
  }

  // ─── Settings & account ───────────────────────────────────────────────────

  /** GET /api/v1/users/me/settings */
  async getSettings(): Promise<UserSettingsView> {
    const raw = await this.request<Wire>("/api/v1/users/me/settings");
    return normalizeSettings(raw);
  }

  /** PATCH /api/v1/users/me/settings — partial update. */
  async updateSettings(input: UpdateSettingsInput): Promise<UserSettingsView> {
    const raw = await this.request<Wire>("/api/v1/users/me/settings", {
      method: "PATCH",
      body: {
        hide_ai_accounts: input.hideAiAccounts,
        hide_nsfw: input.hideNsfw,
        dm_policy: input.dmPolicy,
        mention_policy: input.mentionPolicy,
        read_receipts: input.readReceipts,
        presence_visible: input.presenceVisible,
        captions_default_on: input.captionsDefaultOn,
        font_scale: input.fontScale,
        high_contrast: input.highContrast,
        reduced_motion: input.reducedMotion,
        demographic_breakdowns_opt_in: input.demographicBreakdownsOptIn,
        language: input.language,
        notification_prefs: input.notificationPrefs,
        quiet_hours: input.quietHours,
        is_private: input.isPrivate,
        push_prefs: input.pushPrefs,
        digest_frequency: input.digestFrequency,
      },
    });
    return normalizeSettings(raw);
  }

  /** POST /api/v1/users/me/change-password — other sessions are revoked server-side. */
  changePassword(input: ChangePasswordInput): Promise<void> {
    return this.request<void>("/api/v1/users/me/change-password", {
      method: "POST",
      body: {
        ["current_password"]: input.currentPassword,
        ["new_password"]: input.newPassword
      },
    });
  }

  /** POST /api/v1/users/me/email-change — 202, request recorded server-side. */
  async requestEmailChange(newEmail: string): Promise<EmailChangeResult> {
    const raw = await this.request<Wire>("/api/v1/users/me/email-change", {
      method: "POST",
      body: { new_email: newEmail },
    });
    return {
      status: isWire(raw) && typeof raw["status"] === "string" ? raw["status"] : "pending",
      newEmail:
        isWire(raw) && typeof raw["new_email"] === "string" ? raw["new_email"] : newEmail,
    };
  }

  /** POST /api/v1/users/me/deactivate — soft-deactivates; local tokens are dropped. */
  async deactivateAccount(): Promise<void> {
    try {
      await this.request<void>("/api/v1/users/me/deactivate", { method: "POST" });
    } finally {
      this.clearTokens();
    }
  }

  // ─── Media (Phase 2) ──────────────────────────────────────────────────────

  /** POST /api/v1/media/uploads (JSON) — open an upload session. */
  async createUploadSession(input: CreateUploadInput): Promise<UploadSessionView> {
    const raw = await this.request<Wire>("/api/v1/media/uploads", {
      method: "POST",
      body: {
        kind: input.kind,
        mime_type: input.mimeType,
        size_bytes: input.sizeBytes,
        filename: input.filename,
        sha256: input.sha256,
      },
    });
    return normalizeUploadSession(raw);
  }

  /** Binary request with the session auth + one refresh retry. */
  private async binaryRequest(
    path: string,
    init: { method: string; headers?: Record<string, string>; body: Blob },
    retried = false,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.apiKey) headers.set("x-api-key", this.apiKey);
    if (this.accessToken) headers.set("authorization", `Bearer ${this.accessToken}`);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method,
        headers,
        body: init.body,
        credentials: this.credentials,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "network request failed";
      throw new GGApiError(0, `Can't reach the GG API (${message})`, {
        isNetworkError: true,
      });
    }
    if (
      response.status === 401 &&
      !retried &&
      (this.accessToken !== null || this.refreshToken !== null || this.sessionLikely)
    ) {
      try {
        await this.refresh();
      } catch {
        throw await this.toError(response);
      }
      return this.binaryRequest(path, init, true);
    }
    if (!response.ok) throw await this.toError(response);
    return response;
  }

  /**
   * Upload bytes into a session: one-shot PUT via the signed-PUT URL for
   * payloads up to 8 MB, otherwise tus-style PATCH chunks of 4 MB with
   * offset resumption. `onProgress` receives the fraction uploaded.
   */
  async uploadToSession(
    session: UploadSessionView,
    data: Blob,
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
    const ONE_SHOT_LIMIT = 8 * 1024 * 1024;
    const putUrl =
      session.signedPutUrl ?? `${session.tusUrl}/content`;
    if (data.size <= ONE_SHOT_LIMIT) {
      await this.binaryRequest(putUrl, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: data,
      });
      onProgress?.(1);
      return;
    }
    const CHUNK = 4 * 1024 * 1024;
    let offset = session.offset;
    while (offset < data.size) {
      const chunk = data.slice(offset, Math.min(offset + CHUNK, data.size));
      const response = await this.binaryRequest(session.tusUrl, {
        method: "PATCH",
        headers: {
          "content-type": "application/offset+octet-stream",
          "upload-offset": String(offset),
          "tus-resumable": "1.0.0",
        },
        body: chunk,
      });
      const next = Number.parseInt(
        response.headers.get("upload-offset") ?? "",
        10,
      );
      offset = Number.isNaN(next) ? offset + chunk.size : next;
      onProgress?.(Math.min(1, offset / data.size));
    }
  }

  /** POST /api/v1/media/uploads/{id}/complete — finalize and queue processing. */
  async completeUpload(mediaId: string): Promise<MediaView> {
    const raw = await this.request<Wire>(
      `/api/v1/media/uploads/${mediaId}/complete`,
      { method: "POST", body: {} },
    );
    return normalizeMediaObject(raw);
  }

  /**
   * Full convenience flow: create a session, upload the file (with
   * progress), and complete it. The returned media is `processing` — poll
   * getMedia() until `ready` before attaching it to a post.
   */
  async uploadMedia(
    file: Blob & { name?: string },
    options: {
      kind?: CreateUploadInput["kind"];
      onProgress?: (fraction: number) => void;
    } = {},
  ): Promise<MediaView> {
    const mimeType = file.type || "application/octet-stream";
    const kind =
      options.kind ??
      (mimeType.startsWith("video/")
        ? "video"
        : mimeType === "image/gif"
          ? "gif"
          : "image");
    const session = await this.createUploadSession({
      kind,
      mimeType,
      sizeBytes: file.size,
      filename: file.name,
    });
    await this.uploadToSession(session, file, options.onProgress);
    return this.completeUpload(session.mediaId);
  }

  /** GET /api/v1/media/{id} — media metadata (non-ready media: owner only). */
  async getMedia(mediaId: string): Promise<MediaView> {
    const raw = await this.request<Wire>(`/api/v1/media/${mediaId}`, {
      anonymous: this.accessToken === null,
    });
    return normalizeMediaObject(raw);
  }

  /** PATCH /api/v1/media/{id} — set or clear alt text. */
  async updateMediaAlt(mediaId: string, altText: string | null): Promise<MediaView> {
    const raw = await this.request<Wire>(`/api/v1/media/${mediaId}`, {
      method: "PATCH",
      body: { alt_text: altText },
    });
    return normalizeMediaObject(raw);
  }

  /** GET /api/v1/reels — the reels feed (REEL posts with ready media). */
  getReels(params: PageParams = {}): Promise<CursorPage<PostView>> {
    const qs = queryString({ cursor: params.cursor, limit: params.limit });
    return this.request<Wire>(`/api/v1/reels${qs}`, {
      anonymous: this.accessToken === null,
    }).then((raw) => normalizePage(raw, normalizePost));
  }

  // ─── Stories (Phase 2) ────────────────────────────────────────────────────

  /** POST /api/v1/stories — publish a story frame from ready media. */
  async createStory(input: CreateStoryInput): Promise<StoryView> {
    const raw = await this.request<Wire>("/api/v1/stories", {
      method: "POST",
      body: {
        media_id: input.mediaId,
        audience: input.audience ?? "everyone",
        stickers: (input.stickers ?? []).map((sticker) => ({
          kind: sticker.kind,
          poll_id: sticker.pollId,
          text: sticker.text,
          x: sticker.x,
          y: sticker.y,
        })),
      },
    });
    return normalizeStory(raw);
  }

  /** GET /api/v1/stories/feed — rings for followed accounts, own first. */
  async getStoriesFeed(): Promise<StoryGroupView[]> {
    const raw = await this.request<Wire>("/api/v1/stories/feed");
    const data = isWire(raw) ? raw["data"] : undefined;
    return Array.isArray(data) ? data.map(normalizeStoryGroup) : [];
  }

  /**
   * GET /api/v1/users/{handle}/stories — the user's active story group for
   * the profile ring, or null when they have no visible active story.
   */
  async getUserStories(handle: string): Promise<StoryGroupView | null> {
    const raw = await this.request<Wire>(
      `/api/v1/users/${encodeURIComponent(handle)}/stories`,
      { anonymous: this.accessToken === null },
    );
    const data = isWire(raw) ? raw["data"] : undefined;
    return data && typeof data === "object" ? normalizeStoryGroup(data as Wire) : null;
  }

  /** GET /api/v1/stories/{id} */
  async getStory(storyId: string): Promise<StoryView> {
    const raw = await this.request<Wire>(`/api/v1/stories/${storyId}`, {
      anonymous: this.accessToken === null,
    });
    return normalizeStory(raw);
  }

  /** POST /api/v1/stories/{id}/view — record that the viewer saw this frame. */
  viewStory(storyId: string): Promise<void> {
    return this.request<void>(`/api/v1/stories/${storyId}/view`, {
      method: "POST",
      body: {},
    });
  }

  /** GET /api/v1/stories/{id}/viewers — author only. */
  listStoryViewers(
    storyId: string,
    params: PageParams = {},
  ): Promise<CursorPage<ProfileView>> {
    const qs = queryString({ cursor: params.cursor, limit: params.limit });
    return this.request<Wire>(`/api/v1/stories/${storyId}/viewers${qs}`).then(
      (raw) => normalizePage(raw, normalizeProfile),
    );
  }

  /** DELETE /api/v1/stories/{id} — take a story down early. */
  deleteStory(storyId: string): Promise<void> {
    return this.request<void>(`/api/v1/stories/${storyId}`, { method: "DELETE" });
  }

  // ─── Phase 4: agents, API keys, OAuth clients, webhooks ──────────────────
  //
  // Credential management is session-only on the server (a key cannot mint
  // or revoke credentials, D-038): these methods are meant for the signed-in
  // owner's client. Data-plane calls work with either a session token or an
  // `apiKey` client option.

  /** POST /api/v1/agents/register — create an agent account you own. The
   *  returned `apiKey.secret` is shown exactly once. */
  async registerAgent(input: RegisterAgentInput): Promise<RegisterAgentResult> {
    const raw = await this.request<Wire>("/api/v1/agents/register", {
      method: "POST",
      body: {
        handle: input.handle,
        display_name: input.displayName,
        purpose: input.purpose,
        model_provider: input.modelProvider,
        model_name: input.modelName,
        capabilities: input.capabilities,
        homepage_url: input.homepageUrl,
      },
    });
    const wire = isWire(raw) ? raw : {};
    return {
      profile: normalizeAgentProfile(raw),
      apiKey: normalizeApiKey(wire["api_key"]),
    };
  }

  /** GET /api/v1/agents — public directory (`mine` = only your agents). */
  async listAgents(params: ListAgentsParams = {}): Promise<CursorPage<AgentProfileView>> {
    const qs = queryString({
      cursor: params.cursor,
      limit: params.limit,
      mine: params.mine ? "1" : undefined,
      q: params.q,
    });
    const raw = await this.request<Wire>(`/api/v1/agents${qs}`, {
      anonymous: this.accessToken === null,
    });
    return normalizePage(raw, normalizeAgentProfile);
  }

  /** GET /api/v1/agents/{handle} — public agent profile. */
  async getAgent(handle: string): Promise<AgentProfileView> {
    const raw = await this.request<Wire>(`/api/v1/agents/${handle}`, {
      anonymous: this.accessToken === null,
    });
    return normalizeAgentProfile(raw);
  }

  /** PATCH /api/v1/agents/{handle} — owner only. */
  async updateAgent(handle: string, input: UpdateAgentInput): Promise<AgentProfileView> {
    const raw = await this.request<Wire>(`/api/v1/agents/${handle}`, {
      method: "PATCH",
      body: {
        display_name: input.displayName,
        purpose: input.purpose,
        model_provider: input.modelProvider,
        model_name: input.modelName,
        capabilities: input.capabilities,
        homepage_url: input.homepageUrl,
      },
    });
    return normalizeAgentProfile(raw);
  }

  /** POST /api/v1/agents/{handle}/kill-switch — engage: owner or admin;
   *  release: admin only. Revoked keys are never resurrected (D-040). */
  async setAgentKillSwitch(
    handle: string,
    engaged: boolean,
    reason?: string,
  ): Promise<AgentProfileView> {
    const raw = await this.request<Wire>(`/api/v1/agents/${handle}/kill-switch`, {
      method: "POST",
      body: { engaged, reason },
    });
    return normalizeAgentProfile(raw);
  }

  /** GET /api/v1/agents/{handle}/audit-log — owner or platform staff only. */
  async getAgentAuditLog(
    handle: string,
    params: PageParams = {},
  ): Promise<CursorPage<AuditLogEntryView>> {
    const qs = queryString({ cursor: params.cursor, limit: params.limit });
    const raw = await this.request<Wire>(`/api/v1/agents/${handle}/audit-log${qs}`);
    return normalizePage(raw, normalizeAuditLogEntry);
  }

  /** GET /api/v1/users/me/api-keys — your keys, or one owned agent's. */
  async listApiKeys(agentHandle?: string): Promise<ApiKeyView[]> {
    const qs = queryString({ agent_handle: agentHandle });
    const raw = await this.request<Wire>(`/api/v1/users/me/api-keys${qs}`);
    const data = isWire(raw) && Array.isArray(raw["data"]) ? raw["data"] : [];
    return data.filter(isWire).map((item) => normalizeApiKey(item));
  }

  /** POST /api/v1/users/me/api-keys — `secret` is shown exactly once. */
  async createApiKey(input: CreateApiKeyInput): Promise<ApiKeyCreatedView> {
    const raw = await this.request<Wire>("/api/v1/users/me/api-keys", {
      method: "POST",
      body: {
        name: input.name,
        scopes: input.scopes,
        agent_handle: input.agentHandle,
        expires_at: input.expiresAt,
      },
    });
    return normalizeApiKey(raw);
  }

  /** DELETE /api/v1/users/me/api-keys/{keyId} */
  async revokeApiKey(keyId: string): Promise<void> {
    await this.request<void>(`/api/v1/users/me/api-keys/${keyId}`, { method: "DELETE" });
  }

  /** GET /api/v1/developers/oauth-clients */
  async listOAuthClients(): Promise<OAuthClientView[]> {
    const raw = await this.request<Wire>("/api/v1/developers/oauth-clients");
    const data = isWire(raw) && Array.isArray(raw["data"]) ? raw["data"] : [];
    return data.filter(isWire).map((item) => normalizeOAuthClient(item));
  }

  /** POST /api/v1/developers/oauth-clients — `clientSecret` shown once. */
  async createOAuthClient(input: CreateOAuthClientInput): Promise<OAuthClientCreatedView> {
    const raw = await this.request<Wire>("/api/v1/developers/oauth-clients", {
      method: "POST",
      body: {
        name: input.name,
        redirect_uris: input.redirectUris ?? [],
        allowed_scopes: input.allowedScopes,
        is_confidential: input.isConfidential ?? true,
      },
    });
    return normalizeOAuthClient(raw);
  }

  /** DELETE /api/v1/developers/oauth-clients/{clientRowId} */
  async deleteOAuthClient(clientRowId: string): Promise<void> {
    await this.request<void>(`/api/v1/developers/oauth-clients/${clientRowId}`, {
      method: "DELETE",
    });
  }

  /** POST /api/v1/oauth/token — client-credentials grant (D-037/D-043).
   *  The returned access token authenticates as the agent; use it via
   *  `setTokens` or as a Bearer token in any client. */
  async oauthClientCredentials(input: ClientCredentialsInput): Promise<OAuthTokenView> {
    const raw = await this.request<Wire>("/api/v1/oauth/token", {
      method: "POST",
      anonymous: true,
      body: {
        grant_type: "client_credentials",
        client_id: input.clientId,
        client_secret: input.clientSecret,
        agent_handle: input.agentHandle,
        scope: input.scope,
      },
    });
    return normalizeOAuthToken(raw);
  }

  /** GET /api/v1/users/me/webhooks — yours, or one owned agent's. */
  async listWebhooks(agentHandle?: string): Promise<WebhookView[]> {
    const qs = queryString({ agent_handle: agentHandle });
    const raw = await this.request<Wire>(`/api/v1/users/me/webhooks${qs}`);
    const data = isWire(raw) && Array.isArray(raw["data"]) ? raw["data"] : [];
    return data.filter(isWire).map((item) => normalizeWebhook(item));
  }

  /** POST /api/v1/users/me/webhooks — signing `secret` shown once. */
  async createWebhook(input: CreateWebhookInput): Promise<WebhookCreatedView> {
    const raw = await this.request<Wire>("/api/v1/users/me/webhooks", {
      method: "POST",
      body: {
        url: input.url,
        events: input.events,
        agent_handle: input.agentHandle,
      },
    });
    return normalizeWebhook(raw);
  }

  /** PATCH /api/v1/webhooks/{webhookId} */
  async updateWebhook(webhookId: string, input: UpdateWebhookInput): Promise<WebhookView> {
    const raw = await this.request<Wire>(`/api/v1/webhooks/${webhookId}`, {
      method: "PATCH",
      body: {
        url: input.url,
        events: input.events,
        is_active: input.isActive,
      },
    });
    return normalizeWebhook(raw);
  }

  /** DELETE /api/v1/webhooks/{webhookId} */
  async deleteWebhook(webhookId: string): Promise<void> {
    await this.request<void>(`/api/v1/webhooks/${webhookId}`, { method: "DELETE" });
  }

  /** GET /api/v1/webhooks/{webhookId}/deliveries */
  async listWebhookDeliveries(
    webhookId: string,
    params: PageParams = {},
  ): Promise<CursorPage<WebhookDeliveryView>> {
    const qs = queryString({ cursor: params.cursor, limit: params.limit });
    const raw = await this.request<Wire>(`/api/v1/webhooks/${webhookId}/deliveries${qs}`);
    return normalizePage(raw, normalizeWebhookDelivery);
  }

  /** POST /api/v1/webhooks/{webhookId}/test — queues a signed ping (202). */
  async testWebhook(webhookId: string): Promise<void> {
    await this.request<void>(`/api/v1/webhooks/${webhookId}/test`, { method: "POST" });
  }

  // ─── Phase 5A: conversations / messages ─────────────────────────────────

  /** GET /api/v1/conversations?box=main|requests */
  async listConversations(
    box: "main" | "requests" = "main",
    params: PageParams = {},
  ): Promise<CursorPage<ConversationView>> {
    const qs = queryString({ box, cursor: params.cursor, limit: params.limit });
    const raw = await this.request<Wire>(`/api/v1/conversations${qs}`);
    return normalizePage(raw, normalizeConversation);
  }

  /** POST /api/v1/conversations — 1 handle = DM, 2–50 = group. */
  async createConversation(
    participantHandles: string[],
    title?: string,
  ): Promise<ConversationView> {
    const raw = await this.request<Wire>("/api/v1/conversations", {
      method: "POST",
      body: { participant_handles: participantHandles, title },
    });
    return normalizeConversation(raw);
  }

  /** GET /api/v1/conversations/{id} */
  async getConversation(conversationId: string): Promise<ConversationView> {
    const raw = await this.request<Wire>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}`,
    );
    return normalizeConversation(raw);
  }

  /** GET /api/v1/conversations/{id}/messages — newest first. */
  async listMessages(
    conversationId: string,
    params: PageParams = {},
  ): Promise<CursorPage<MessageView>> {
    const qs = queryString({ cursor: params.cursor, limit: params.limit });
    const raw = await this.request<Wire>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages${qs}`,
    );
    return normalizePage(raw, normalizeMessage);
  }

  /** POST /api/v1/conversations/{id}/messages */
  async sendMessage(
    conversationId: string,
    input: SendMessageInput,
  ): Promise<MessageView> {
    const raw = await this.request<Wire>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: "POST",
        body: {
          body: input.body,
          media_id: input.mediaId,
          reply_to_message_id: input.replyToMessageId,
          shared_post_id: input.sharedPostId,
        },
      },
    );
    return normalizeMessage(raw);
  }

  /** POST /api/v1/conversations/{id}/read */
  async markConversationRead(conversationId: string, messageId: string): Promise<void> {
    await this.request<void>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/read`,
      { method: "POST", body: { message_id: messageId } },
    );
  }

  /** POST /api/v1/conversations/{id}/accept */
  async acceptConversation(conversationId: string): Promise<ConversationView> {
    const raw = await this.request<Wire>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/accept`,
      { method: "POST", body: {} },
    );
    return normalizeConversation(raw);
  }

  /** POST /api/v1/conversations/{id}/decline */
  async declineConversation(conversationId: string): Promise<ConversationView> {
    const raw = await this.request<Wire>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/decline`,
      { method: "POST", body: {} },
    );
    return normalizeConversation(raw);
  }

  /** POST /api/v1/conversations/{id}/mute — null unmutes. */
  async muteConversation(
    conversationId: string,
    mutedUntil: string | null,
  ): Promise<ConversationView> {
    const raw = await this.request<Wire>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/mute`,
      { method: "POST", body: { muted_until: mutedUntil } },
    );
    return normalizeConversation(raw);
  }

  /** POST /api/v1/conversations/{id}/leave */
  async leaveConversation(conversationId: string): Promise<void> {
    await this.request<void>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/leave`,
      { method: "POST", body: {} },
    );
  }

  /** POST /api/v1/conversations/{id}/participants */
  async addConversationParticipant(
    conversationId: string,
    handle: string,
  ): Promise<ConversationView> {
    const raw = await this.request<Wire>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/participants`,
      { method: "POST", body: { handle } },
    );
    return normalizeConversation(raw);
  }

  /** DELETE /api/v1/conversations/{id}/participants/{handle} */
  async removeConversationParticipant(
    conversationId: string,
    handle: string,
  ): Promise<void> {
    await this.request<void>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/participants/${encodeURIComponent(handle)}`,
      { method: "DELETE" },
    );
  }

  /** PATCH /api/v1/conversations/{id}/messages/{messageId} */
  async editMessage(
    conversationId: string,
    messageId: string,
    body: string,
  ): Promise<MessageView> {
    const raw = await this.request<Wire>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
      { method: "PATCH", body: { body } },
    );
    return normalizeMessage(raw);
  }

  /** DELETE /api/v1/conversations/{id}/messages/{messageId} */
  async deleteMessage(conversationId: string, messageId: string): Promise<void> {
    await this.request<void>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
      { method: "DELETE" },
    );
  }

  /** POST /api/v1/conversations/{id}/messages/{messageId}/reactions */
  async reactToMessage(
    conversationId: string,
    messageId: string,
    emoji: string,
  ): Promise<MessageView> {
    const raw = await this.request<Wire>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/reactions`,
      { method: "POST", body: { emoji } },
    );
    return normalizeMessage(raw);
  }

  /** DELETE .../reactions/{emoji} */
  async unreactToMessage(
    conversationId: string,
    messageId: string,
    emoji: string,
  ): Promise<MessageView> {
    const raw = await this.request<Wire>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`,
      { method: "DELETE" },
    );
    return normalizeMessage(raw);
  }

  /** POST /api/v1/conversations/{id}/typing — realtime relay, no persistence. */
  async sendTyping(conversationId: string): Promise<void> {
    await this.request<void>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/typing`,
      { method: "POST", body: {} },
    );
  }

  // ─── Phase 5A: lists ────────────────────────────────────────────────────

  /** POST /api/v1/lists */
  async createList(input: CreateListInput): Promise<ListView> {
    const raw = await this.request<Wire>("/api/v1/lists", {
      method: "POST",
      body: { name: input.name, description: input.description, is_public: input.isPublic },
    });
    return normalizeList(raw);
  }

  /** GET /api/v1/lists/{id} */
  async getList(listId: string): Promise<ListView> {
    const raw = await this.request<Wire>(`/api/v1/lists/${encodeURIComponent(listId)}`);
    return normalizeList(raw);
  }

  /** PATCH /api/v1/lists/{id} */
  async updateList(listId: string, input: UpdateListInput): Promise<ListView> {
    const raw = await this.request<Wire>(`/api/v1/lists/${encodeURIComponent(listId)}`, {
      method: "PATCH",
      body: { name: input.name, description: input.description, is_public: input.isPublic },
    });
    return normalizeList(raw);
  }

  /** DELETE /api/v1/lists/{id} */
  async deleteList(listId: string): Promise<void> {
    await this.request<void>(`/api/v1/lists/${encodeURIComponent(listId)}`, {
      method: "DELETE",
    });
  }

  /** GET /api/v1/lists/discover — public lists by member count. */
  async discoverLists(): Promise<CursorPage<ListView>> {
    const raw = await this.request<Wire>("/api/v1/lists/discover", {
      anonymous: this.accessToken === null,
    });
    return normalizePage(raw, normalizeList);
  }

  /** GET /api/v1/users/{handle}/lists */
  async getUserLists(handle: string): Promise<CursorPage<ListView>> {
    const raw = await this.request<Wire>(
      `/api/v1/users/${encodeURIComponent(handle)}/lists`,
      { anonymous: this.accessToken === null },
    );
    return normalizePage(raw, normalizeList);
  }

  /** GET /api/v1/lists/{id}/members */
  async getListMembers(listId: string): Promise<AuthorView[]> {
    const raw = await this.request<Wire>(
      `/api/v1/lists/${encodeURIComponent(listId)}/members`,
      { anonymous: this.accessToken === null },
    );
    const page = normalizePage(raw, normalizeAuthor);
    return page.items;
  }

  /** POST /api/v1/lists/{id}/members */
  async addListMember(listId: string, handle: string): Promise<ListView> {
    const raw = await this.request<Wire>(
      `/api/v1/lists/${encodeURIComponent(listId)}/members`,
      { method: "POST", body: { handle } },
    );
    return normalizeList(raw);
  }

  /** DELETE /api/v1/lists/{id}/members/{handle} */
  async removeListMember(listId: string, handle: string): Promise<void> {
    await this.request<void>(
      `/api/v1/lists/${encodeURIComponent(listId)}/members/${encodeURIComponent(handle)}`,
      { method: "DELETE" },
    );
  }

  /** GET /api/v1/lists/{id}/timeline */
  async getListTimeline(
    listId: string,
    params: PageParams = {},
  ): Promise<CursorPage<PostView>> {
    const qs = queryString({ cursor: params.cursor, limit: params.limit });
    const raw = await this.request<Wire>(
      `/api/v1/lists/${encodeURIComponent(listId)}/timeline${qs}`,
      { anonymous: this.accessToken === null },
    );
    return normalizePage(raw, normalizePost);
  }

  // ─── Phase 5A: collections ──────────────────────────────────────────────

  /** GET /api/v1/collections */
  async listCollections(): Promise<CursorPage<CollectionView>> {
    const raw = await this.request<Wire>("/api/v1/collections");
    return normalizePage(raw, normalizeCollection);
  }

  /** POST /api/v1/collections */
  async createCollection(input: CreateCollectionInput): Promise<CollectionView> {
    const raw = await this.request<Wire>("/api/v1/collections", {
      method: "POST",
      body: { name: input.name, description: input.description, is_public: input.isPublic },
    });
    return normalizeCollection(raw);
  }

  /** GET /api/v1/collections/{id} */
  async getCollection(collectionId: string): Promise<CollectionView> {
    const raw = await this.request<Wire>(
      `/api/v1/collections/${encodeURIComponent(collectionId)}`,
    );
    return normalizeCollection(raw);
  }

  /** PATCH /api/v1/collections/{id} */
  async updateCollection(
    collectionId: string,
    input: UpdateCollectionInput,
  ): Promise<CollectionView> {
    const raw = await this.request<Wire>(
      `/api/v1/collections/${encodeURIComponent(collectionId)}`,
      {
        method: "PATCH",
        body: { name: input.name, description: input.description, is_public: input.isPublic },
      },
    );
    return normalizeCollection(raw);
  }

  /** DELETE /api/v1/collections/{id} — bookmarks survive, unfiled. */
  async deleteCollection(collectionId: string): Promise<void> {
    await this.request<void>(`/api/v1/collections/${encodeURIComponent(collectionId)}`, {
      method: "DELETE",
    });
  }

  /** GET /api/v1/collections/{id}/posts */
  async getCollectionPosts(
    collectionId: string,
    params: PageParams = {},
  ): Promise<CursorPage<PostView>> {
    const qs = queryString({ cursor: params.cursor, limit: params.limit });
    const raw = await this.request<Wire>(
      `/api/v1/collections/${encodeURIComponent(collectionId)}/posts${qs}`,
    );
    return normalizePage(raw, normalizePost);
  }

  // ─── Phase 5A: scheduled posts + trending ───────────────────────────────

  /** GET /api/v1/users/me/scheduled */
  async getScheduledPosts(): Promise<CursorPage<PostView>> {
    const raw = await this.request<Wire>("/api/v1/users/me/scheduled");
    return normalizePage(raw, normalizePost);
  }

  /** GET /api/v1/trending — latest worker snapshot (trailing 6h velocity). */
  async getTrending(): Promise<TrendingView> {
    const raw = await this.request<Wire>("/api/v1/trending", {
      anonymous: this.accessToken === null,
    });
    return normalizeTrending(raw);
  }
}
