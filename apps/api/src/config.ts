import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const DEV_SECRET_PREFIX = "dev-only-";

/**
 * Minimal .env loader (dev convenience): fills unset process.env vars from
 * a .env file in the cwd or the app root. Real deployments inject env via
 * systemd/Docker; this exists so laptop dev runs (`pnpm db:seed`, vitest)
 * pick up /home/aman/gg-dev/app/.env without extra tooling.
 */
export function loadDotEnv(): void {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    // Monorepo root, when cwd is apps/api (pnpm --filter) or src/db (tsx).
    path.resolve(process.cwd(), "../../.env"),
    path.resolve(__dirname, "../.env"),
    path.resolve(__dirname, "../../.env"),
    path.resolve(__dirname, "../../../.env"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
    return;
  }
}

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "staging", "production"])
    .default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  DATABASE_URL: z.string().min(1).default("postgres://gg:gg@localhost:5432/gg"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  SESSION_SECRET: z.string().min(1).default(`${DEV_SECRET_PREFIX}session-secret-change-me`),
  JWT_SECRET: z.string().min(1).default(`${DEV_SECRET_PREFIX}jwt-secret-change-me`),
  /** Agent vote weight relative to a human vote (DECISIONS D-012: 1.0). */
  AGENT_VOTE_WEIGHT: z.coerce.number().min(0).default(1.0),
  /** Minimum registration age (DECISIONS D-011: 13). */
  MIN_AGE: z.coerce.number().int().min(1).default(13),
  // ── Media (Phase 2) ──────────────────────────────────────────────────────
  /** Root dir of the local storage adapter (ARCHITECTURE §6, D-025). */
  MEDIA_DIR: z.string().min(1).default("./media-data"),
  /** API_SPEC UploadCreateRequest: images ≤ 25 MB. */
  MEDIA_MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  /** API_SPEC UploadCreateRequest: video ≤ 2 GB (D-026). */
  MEDIA_MAX_VIDEO_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 1024 * 1024 * 1024),
  /** Phase 5A (D-046): audio uploads (voice notes) ≤ 25 MB. */
  MEDIA_MAX_AUDIO_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  /** Per-user stored-media quota (sum of size_bytes over non-failed media). */
  MEDIA_QUOTA_BYTES_PER_USER: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 1024 * 1024 * 1024),
  /** Upload sessions a user may create per rolling hour. */
  MEDIA_UPLOADS_PER_HOUR: z.coerce.number().int().positive().default(60),
  // ── Secrets at rest (hardening, D-065) ─────────────────────────────────
  /**
   * Field-encryption key: base64 of exactly 32 bytes (AES-256-GCM).
   * Encrypts webhook signing secrets and TOTP secrets at rest. REQUIRED in
   * production (boot fails closed without it); in dev/test, unset means
   * new values are stored as legacy plaintext (reads always tolerate
   * legacy plaintext rows).
   */
  WEBHOOK_ENCRYPTION_KEY: z.string().optional(),
  // ── Email verification (Phase 3 exit, D-035) ────────────────────────────
  /**
   * Mailer adapter selection (D-070). "log" = LogMailer (no mail leaves
   * the box; the D-035 dev-link affordance stays). "smtp" = real SMTP via
   * nodemailer using the SMTP_* settings below; when a real mailer is
   * configured the dev-link affordance disappears automatically.
   */
  MAILER: z.enum(["log", "smtp"]).default("log"),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z
    .union([z.boolean(), z.string()])
    .transform((value) => value === true || value === "true")
    .default(false),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASS: z.string().min(1).optional(),
  SMTP_FROM: z.string().min(1).default("GG <no-reply@genznewz.com>"),
  // ── WebAuthn passkeys (hardening, D-068) ────────────────────────────────
  /**
   * Relying-party id for passkeys. Defaults to the APP_BASE_URL hostname;
   * set explicitly when the API serves multiple web origins.
   */
  WEBAUTHN_RP_ID: z.string().min(1).optional(),
  WEBAUTHN_RP_NAME: z.string().min(1).default("GG"),
  /** Comma-separated allowed WebAuthn origins; default = APP_BASE_URL. */
  WEBAUTHN_ORIGINS: z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(",")
            .map((origin) => origin.trim())
            .filter(Boolean)
        : undefined,
    ),
  // ── Social OAuth sign-in (hardening, D-069) ─────────────────────────────
  /**
   * External provider credentials. A provider with no client id/secret is
   * unconfigured: its authorize endpoint 404s and the web hides its
   * button. The *_URL overrides exist so tests can point the generic flow
   * at a mocked provider; production leaves them unset.
   */
  OAUTH_GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  OAUTH_GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  OAUTH_GOOGLE_AUTHORIZE_URL: z.string().url().optional(),
  OAUTH_GOOGLE_TOKEN_URL: z.string().url().optional(),
  OAUTH_GOOGLE_USERINFO_URL: z.string().url().optional(),
  OAUTH_DISCORD_CLIENT_ID: z.string().min(1).optional(),
  OAUTH_DISCORD_CLIENT_SECRET: z.string().min(1).optional(),
  OAUTH_DISCORD_AUTHORIZE_URL: z.string().url().optional(),
  OAUTH_DISCORD_TOKEN_URL: z.string().url().optional(),
  OAUTH_DISCORD_USERINFO_URL: z.string().url().optional(),
  /**
   * Public base URL of the web app; verification links are built as
   * `${APP_BASE_URL}/verify-email?token=…`. Staging sets this to
   * https://gg.genznewz.com.
   */
  APP_BASE_URL: z
    .string()
    .url()
    .default("http://localhost:3000")
    .transform((value) => value.replace(/\/+$/, "")),
  // ── Web push + semantic search (Phase 5B) ──────────────────────────────
  /**
   * VAPID keypair for Web Push. The public key is served at
   * GET /push/vapid-public-key; the private key is used ONLY by the
   * worker's push sender. Both unset → push disabled (subscriptions are
   * still stored; the worker records skips honestly). Keys are generated
   * on the host (web-push generateVAPIDKeys) and live in env only.
   */
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  VAPID_SUBJECT: z.string().min(1).default("mailto:hello@genznewz.com"),
  /**
   * Local all-MiniLM-L6-v2 model directory for query-time embeddings
   * (semantic search). Unset or missing → semantic search degrades to
   * FTS-only and says so in the response (`semantic_applied: false`).
   */
  EMBEDDINGS_MODEL_PATH: z.string().min(1).optional(),
  // ── Opinion & debate (Phase 3) ───────────────────────────────────────────
  /** Handle of the platform agent account that authors the Daily Pulse (D-031). */
  PULSE_AUTHOR_HANDLE: z.string().min(1).default("gg_scout"),
  /** Per-user poll ballot writes (cast/change/retract) per rolling minute. */
  POLL_VOTES_PER_MINUTE: z.coerce.number().int().positive().default(60),
  /** Anomaly scan window for poll velocity bursts, seconds. */
  POLL_FLAG_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  /** Ballots inside the window that trip a velocity flag (brief §4). */
  POLL_FLAG_MIN_BALLOTS: z.coerce.number().int().positive().default(20),
  /** Share of burst ballots from accounts younger than a day that trips the young-account flag. */
  POLL_FLAG_YOUNG_ACCOUNT_SHARE: z.coerce.number().min(0).max(1).default(0.8),
  // ── Agent platform (Phase 4) ─────────────────────────────────────────────
  /**
   * Per-minute request ceiling for API-key / OAuth credentials at agent
   * rate tier 0 (SECURITY §8.2: agents start tightly limited). Higher tiers
   * multiply: tier 1 ×5, tier 2 ×15, tier 3 ×30 (D-041).
   */
  AGENT_KEY_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  /** Per-minute ceiling for a human's personal API keys (no rate tier). */
  PERSONAL_KEY_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(600),
  /** Webhook delivery attempts before a delivery is `exhausted` (D-042). */
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /** Base retry delay for webhook deliveries; doubles per attempt. */
  WEBHOOK_RETRY_BASE_MS: z.coerce.number().int().positive().default(30_000),
  /** Per-attempt HTTP timeout for webhook delivery. */
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

export type AppConfig = z.infer<typeof envSchema>;

/**
 * Parse and validate environment configuration. Fails fast on invalid
 * values, and refuses to boot in production with the dev placeholder
 * secrets from .env.example.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const config = result.data;
  if (
    config.NODE_ENV === "production" &&
    (config.SESSION_SECRET.startsWith(DEV_SECRET_PREFIX) ||
      config.JWT_SECRET.startsWith(DEV_SECRET_PREFIX))
  ) {
    throw new Error(
      "SESSION_SECRET and JWT_SECRET must be set to real values in production",
    );
  }
  // Field encryption (D-065): when a key is configured it must be a valid
  // base64-encoded 32-byte key; in production it is mandatory (fail
  // closed rather than silently storing signing/TOTP secrets plaintext).
  if (config.WEBHOOK_ENCRYPTION_KEY !== undefined) {
    const decoded = Buffer.from(config.WEBHOOK_ENCRYPTION_KEY, "base64");
    if (decoded.length !== 32) {
      throw new Error(
        "WEBHOOK_ENCRYPTION_KEY must be the base64 encoding of exactly 32 bytes",
      );
    }
  } else if (config.NODE_ENV === "production") {
    throw new Error(
      "WEBHOOK_ENCRYPTION_KEY must be set in production (webhook + TOTP secrets are encrypted at rest with it)",
    );
  }
  if (config.MAILER === "smtp" && !config.SMTP_HOST) {
    throw new Error("MAILER=smtp requires SMTP_HOST to be set");
  }
  return config;
}
