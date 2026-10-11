import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import {
  OAUTH_STATE_COOKIE,
  configuredSocialProviders,
  fetchSocialProfile,
  resolveSocialLogin,
  signOAuthState,
  socialAuthorizeUrl,
  socialProviderById,
  verifyOAuthState,
  type SocialProviderId,
} from "../services/social-auth";
import { signLoginChallenge } from "../lib/jwt";
import { issueSession } from "../services/sessions";
import { LOGIN_CHALLENGE_COOKIE, setRefreshCookie } from "./auth";

/**
 * Social sign-in routes (hardening, D-069). Browser flow: the web login
 * page links to /authorize, the provider redirects back to /callback,
 * and the callback sets the session cookie and redirects into the web
 * app (which restores the session via the refresh cookie, same as the
 * SDK's sessionLikely flow). All failures land on /login?error=… —
 * never a JSON error page mid-browser-flow.
 */
export async function registerSocialAuthRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db, config } = ctx;

  // Which providers are configured (web hides the rest).
  app.get("/api/v1/auth/oauth/providers", async (_request, reply) => {
    return reply.send({
      providers: configuredSocialProviders(config).map((provider) => ({
        id: provider.id,
        name: provider.name,
      })),
    });
  });

  app.get("/api/v1/auth/oauth/:provider/authorize", async (request, reply) => {
    const { provider: providerId } = request.params as { provider: string };
    const provider = socialProviderById(config, providerId);
    if (!provider) {
      return reply.redirect(`${config.APP_BASE_URL}/login?error=social_unavailable`);
    }
    const { state, cookie } = signOAuthState(config, provider.id);
    return reply
      .setCookie(OAUTH_STATE_COOKIE, cookie, {
        path: "/api/v1/auth",
        httpOnly: true,
        sameSite: "lax",
        secure: config.NODE_ENV === "production",
        maxAge: 600,
      })
      .redirect(socialAuthorizeUrl(config, provider, state));
  });

  app.get("/api/v1/auth/oauth/:provider/callback", async (request, reply) => {
    const { provider: providerId } = request.params as { provider: string };
    const query = request.query as { code?: string; state?: string; error?: string };
    const fail = (reason: string) =>
      reply
        .clearCookie(OAUTH_STATE_COOKIE, { path: "/api/v1/auth" })
        .redirect(`${config.APP_BASE_URL}/login?error=${reason}`);
    const provider = socialProviderById(config, providerId);
    if (!provider) return fail("social_unavailable");
    if (query.error || !query.code) return fail("social_failed");
    const stateOk = verifyOAuthState(
      config,
      request.cookies[OAUTH_STATE_COOKIE],
      provider.id as SocialProviderId,
      query.state ?? null,
    );
    if (!stateOk) return fail("social_state");
    const profile = await fetchSocialProfile(config, provider, query.code);
    if (!profile) return fail("social_failed");
    const resolution = await resolveSocialLogin(db, provider, profile);
    if (resolution.kind === "unverified_email") return fail("social_unverified");
    if (resolution.kind !== "login") return fail("social_failed");
    const { user } = resolution;
    if (
      user.status === "banned" ||
      user.status === "suspended" ||
      user.status === "deactivated"
    ) {
      return fail("account_inactive");
    }
    // A TOTP-enabled account still owes its second factor: the social
    // proof replaces the password step, so the login challenge rides in
    // an httpOnly cookie and the web's code form posts to the normal
    // verify endpoint (which also reads the challenge from this cookie).
    if (user.totpEnabled) {
      return reply
        .clearCookie(OAUTH_STATE_COOKIE, { path: "/api/v1/auth" })
        .setCookie(LOGIN_CHALLENGE_COOKIE, signLoginChallenge(user.id, config.JWT_SECRET), {
          path: "/api/v1/auth",
          httpOnly: true,
          sameSite: "lax",
          secure: config.NODE_ENV === "production",
          maxAge: 300,
        })
        .redirect(`${config.APP_BASE_URL}/login?totp=1`);
    }
    const pair = await issueSession(db, user, config.JWT_SECRET, request);
    setRefreshCookie(ctx, reply, pair.refresh);
    const destination = user.dateOfBirth
      ? `${config.APP_BASE_URL}/home`
      : `${config.APP_BASE_URL}/onboarding`;
    return reply
      .clearCookie(OAUTH_STATE_COOKIE, { path: "/api/v1/auth" })
      .redirect(destination);
  });
}
