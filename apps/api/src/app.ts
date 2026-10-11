import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { parse as parseYaml } from "yaml";
import { loadConfig, type AppConfig } from "./config";
import type { AppContext } from "./context";
import { getDb } from "./db";
import { ProblemError } from "./lib/errors";
import { registerAdminAnalyticsRoutes } from "./routes/admin-analytics";
import { registerAgentRoutes } from "./routes/agents";
import { registerAuthRoutes } from "./routes/auth";
import { registerCollectionRoutes } from "./routes/collections";
import { registerConversationRoutes } from "./routes/conversations";
import { registerDeveloperRoutes } from "./routes/developer";
import { registerTwoFactorRoutes } from "./routes/two-factor";
import { registerSocialAuthRoutes } from "./routes/social-auth";
import { registerCommunityRoutes } from "./routes/communities";
import { registerFeedRoutes } from "./routes/feed";
import { registerDebateRoutes } from "./routes/debates";
import { registerListRoutes } from "./routes/lists";
import { registerMediaRoutes } from "./routes/media";
import { registerModerationRoutes } from "./routes/moderation";
import { registerNoteRoutes } from "./routes/notes";
import { registerNotificationRoutes } from "./routes/notifications";
import { registerPollRoutes } from "./routes/polls";
import { registerOnboardingRoutes } from "./routes/onboarding";
import { registerPushRoutes } from "./routes/push";
import { registerPostRoutes } from "./routes/posts";
import { registerRealtimeRoutes } from "./routes/realtime";
import { registerReelRoutes } from "./routes/reels";
import { registerReportRoutes } from "./routes/reports";
import { registerSearchRoutes } from "./routes/search";
import { registerSettingsRoutes } from "./routes/settings";
import { registerStoryRoutes } from "./routes/stories";
import { registerTrendingRoutes } from "./routes/trending";
import { registerUserRoutes } from "./routes/users";

/** RFC 9457 problem+json body (master spec §6.2). */
interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
}

function sendProblem(
  reply: FastifyReply,
  status: number,
  title: string,
  detail?: string,
): FastifyReply {
  const body: ProblemBody = { type: "about:blank", title, status };
  if (detail) body.detail = detail;
  body.instance = reply.request.url;
  return reply.status(status).type("application/problem+json").send(body);
}

/**
 * Locate docs/API_SPEC.yaml relative to wherever the API is running from:
 * the repo root when cwd is apps/api (dev), when running from dist/, or
 * when running from src/ via tsx.
 */
export function findApiSpecPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "../../docs/API_SPEC.yaml"),
    path.resolve(__dirname, "../../../docs/API_SPEC.yaml"),
    path.resolve(__dirname, "../../docs/API_SPEC.yaml"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function buildApp(
  config: AppConfig = loadConfig(),
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(helmet);
  await app.register(cors, {
    origin: config.CORS_ORIGINS,
    credentials: true,
    // Explicit: the API's write surface is PUT/PATCH/DELETE-heavy (votes,
    // follows, settings, report resolution). The plugin default observed in
    // the wild was GET,HEAD,POST only, which silently blocked every browser
    // mutation with a CORS error (Phase 1 exit round, D-023).
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
  });
  await app.register(cookie);
  // Media intake (Phase 2): multipart one-shot uploads stream to storage;
  // the per-file cap is a backstop — route-level caps are authoritative.
  await app.register(multipart, {
    limits: { files: 1, fileSize: config.MEDIA_MAX_VIDEO_BYTES },
  });

  // Cookie-first auth calls (refresh/logout from the web app) may send no
  // body at all — treat an empty JSON body as {} instead of Fastify's 400.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      const text = typeof body === "string" ? body : body.toString("utf8");
      if (text.trim().length === 0) return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ProblemError) {
      return sendProblem(reply, error.status, error.title, error.message);
    }
    const err = error as { statusCode?: number; message?: string };
    const status = err.statusCode ?? 500;
    const message = err.message ?? "Internal Server Error";
    if (status >= 500) request.log.error(error);
    return sendProblem(
      reply,
      status,
      status >= 500 ? "Internal Server Error" : message,
      status >= 500 ? undefined : message,
    );
  });

  app.setNotFoundHandler((request, reply) => {
    sendProblem(reply, 404, "Not Found", `No route for ${request.method} ${request.url}`);
  });

  app.get("/api/v1/health", async () => ({ status: "ok", service: "gg-api" }));

  // Phase 1: auth, users, posts/votes, communities, feeds (slice 1) +
  // notifications, search, onboarding, settings (round 2).
  const ctx: AppContext = { config, db: getDb(config.DATABASE_URL).db };
  await registerAuthRoutes(app, ctx);
  await registerTwoFactorRoutes(app, ctx);
  await registerSocialAuthRoutes(app, ctx);
  await registerUserRoutes(app, ctx);
  await registerPostRoutes(app, ctx);
  await registerCommunityRoutes(app, ctx);
  await registerFeedRoutes(app, ctx);
  await registerNotificationRoutes(app, ctx);
  await registerSearchRoutes(app, ctx);
  await registerOnboardingRoutes(app, ctx);
  await registerSettingsRoutes(app, ctx);
  await registerReportRoutes(app, ctx);
  // Phase 2: media uploads + file serving, stories, reels.
  await registerMediaRoutes(app, ctx);
  await registerStoryRoutes(app, ctx);
  await registerReelRoutes(app, ctx);
  // Phase 3: polls (+ Daily Pulse + admin vote integrity), debates, notes.
  await registerPollRoutes(app, ctx);
  await registerDebateRoutes(app, ctx);
  await registerNoteRoutes(app, ctx);
  // Phase 4: agent platform (registration, directory, kill switch, audit
  // log) + developer platform (API keys, OAuth clients/token, webhooks).
  await registerAgentRoutes(app, ctx);
  await registerDeveloperRoutes(app, ctx);
  // Phase 5A: DMs + realtime + lists + collections + trending.
  await registerConversationRoutes(app, ctx);
  await registerRealtimeRoutes(app, ctx);
  await registerListRoutes(app, ctx);
  await registerCollectionRoutes(app, ctx);
  await registerTrendingRoutes(app, ctx);
  // Phase 5B: moderation (AutoMod/lockdown/mod actions/mod mail),
  // platform analytics, web-push subscriptions.
  await registerModerationRoutes(app, ctx);
  await registerAdminAnalyticsRoutes(app, ctx);
  await registerPushRoutes(app, ctx);

  let cachedSpec: unknown = null;
  app.get("/api/openapi.json", async (request, reply) => {
    try {
      if (cachedSpec === null) {
        const specPath = findApiSpecPath();
        if (!specPath) {
          return sendProblem(
            reply,
            404,
            "OpenAPI spec not found",
            "docs/API_SPEC.yaml is not present in this deployment",
          );
        }
        cachedSpec = parseYaml(readFileSync(specPath, "utf8")) as unknown;
      }
      return reply.type("application/json").send(cachedSpec);
    } catch (error) {
      request.log.error(error);
      return sendProblem(
        reply,
        500,
        "Failed to load OpenAPI spec",
        error instanceof Error ? error.message : undefined,
      );
    }
  });

  return app;
}
