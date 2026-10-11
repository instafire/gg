/**
 * SDK — hardening surface (password reset, TOTP, passkeys, social,
 * OAuth consent). Stub-fetch tests in the house style.
 */
import { describe, expect, it, vi } from "vitest";
import { GGClient } from "../src/index";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const userPrivateWire = {
  id: "01921f2e-7b6d-7c8f-9a0b-1c2d3e4f5a6b",
  handle: "secureuser",
  email: "secure@example.com",
  email_verified: true,
  author_type: "human",
  trust_tier: "T2",
  age_bracket: "25_plus",
  status: "active",
  profile: null,
};

function makeClient(handler: FetchFn) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn<FetchFn>(async (input, init) => {
    calls.push({ url: input, init });
    return handler(input, init);
  });
  const client = new GGClient({
    baseUrl: "http://localhost:4000",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { client, calls };
}

function bodyOf(call: { init?: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(call.init?.body ?? "{}")) as Record<string, unknown>;
}

describe("password reset", () => {
  it("forgotPassword posts the email and surfaces the dev reset URL", async () => {
    const { client, calls } = makeClient(async () =>
      jsonResponse({ status: "pending", dev_reset_url: "https://gg.example/reset-password?token=t" }, 202),
    );
    const result = await client.forgotPassword("a@example.com");
    expect(result.devResetUrl).toContain("token=t");
    expect(calls[0]!.url).toContain("/api/v1/auth/password/forgot");
    expect(bodyOf(calls[0]!)).toEqual({ email: "a@example.com" });
  });

  it("resetPassword posts token + new_password", async () => {
    const { client, calls } = makeClient(async () => jsonResponse({ status: "password_reset" }));
    await client.resetPassword("tok123", "brand-new-password");
    expect(bodyOf(calls[0]!)).toEqual({ token: "tok123", new_password: "brand-new-password" });
  });
});

describe("TOTP", () => {
  it("login surfaces the challenge instead of tokens", async () => {
    const { client } = makeClient(async () =>
      jsonResponse({ status: "totp_required", totp_required: true, challenge_token: "chtok" }),
    );
    const result = await client.login({ email: "a@example.com", password: "x" });
    expect(result.totpRequired).toBe(true);
    expect(result.challengeToken).toBe("chtok");
    expect(result.tokens).toBeNull();
  });

  it("verifyTotp with a challenge completes the login and stores tokens", async () => {
    const { client, calls } = makeClient(async () =>
      jsonResponse(
        {
          user: userPrivateWire,
          tokens: {
            access_token: "at-1",
            refresh_token: "rt-1",
            token_type: "Bearer",
            expires_in: 900,
          },
        },
        201,
      ),
    );
    const result = await client.verifyTotp({ code: "123456", challengeToken: "chtok" });
    expect(result.tokens?.accessToken).toBe("at-1");
    expect(bodyOf(calls[0]!)).toEqual({ code: "123456", challenge_token: "chtok" });
  });

  it("beginTotp + verifyTotp enrollment returns recovery codes; status + disable wire up", async () => {
    const { client, calls } = makeClient(async (url) => {
      if (url.includes("/2fa/status")) {
        return jsonResponse({
          totp_enabled: true,
          has_passkey: true,
          passkeys: [
            { id: "pk1", label: "Phone", created_at: "2026-10-11T00:00:00Z", last_used_at: null },
          ],
        });
      }
      if (url.endsWith("/2fa/totp/verify")) {
        return jsonResponse({ status: "enabled", recovery_codes: ["AAAAA-BBBBB"] });
      }
      if (url.endsWith("/2fa/totp")) {
        return jsonResponse({ otpauth_uri: "otpauth://totp/GG:secureuser?secret=ABC" });
      }
      return jsonResponse({});
    });
    const begin = await client.beginTotp();
    expect(begin.otpauthUri).toContain("otpauth://totp/");
    const verify = await client.verifyTotp({ code: "123456" });
    expect(verify.recoveryCodes).toEqual(["AAAAA-BBBBB"]);
    const status = await client.twoFactorStatus();
    expect(status).toMatchObject({ totpEnabled: true, hasPasskey: true });
    expect(status.passkeys[0]).toMatchObject({ id: "pk1", label: "Phone" });
    await client.disableTotp({ password: "pw", code: "123456" });
    const deleteCall = calls.find((c) => c.init?.method === "DELETE");
    expect(deleteCall).toBeTruthy();
    expect(bodyOf(deleteCall!)).toEqual({ code: "123456", password: "pw" });
  });
});

describe("passkeys + social + consent", () => {
  it("passkey login verify stores the session", async () => {
    const { client } = makeClient(async () =>
      jsonResponse(
        {
          user: userPrivateWire,
          tokens: {
            access_token: "pk-at",
            refresh_token: "pk-rt",
            token_type: "Bearer",
            expires_in: 900,
          },
        },
        201,
      ),
    );
    const result = await client.passkeyLoginVerify({ id: "cred1" });
    expect(result.tokens?.accessToken).toBe("pk-at");
    expect(result.user?.handle).toBe("secureuser");
  });

  it("socialProviders + authorize URL", async () => {
    const { client } = makeClient(async () =>
      jsonResponse({ providers: [{ id: "google", name: "Google" }] }),
    );
    expect(await client.socialProviders()).toEqual([{ id: "google", name: "Google" }]);
    expect(client.socialAuthorizeUrl("google")).toBe(
      "http://localhost:4000/api/v1/auth/oauth/google/authorize",
    );
  });

  it("oauthAuthorizeInfo + decision round-trip", async () => {
    const { client, calls } = makeClient(async (url, init) => {
      if (init?.method === "POST") {
        return jsonResponse({ redirect_to: "https://client.example/cb?code=abc&state=s1" });
      }
      return jsonResponse({
        client_id: "ggc_x",
        client_name: "App",
        scopes: ["read:feed"],
        redirect_uri: "https://client.example/cb",
        state: "s1",
      });
    });
    const info = await client.oauthAuthorizeInfo({
      clientId: "ggc_x",
      redirectUri: "https://client.example/cb",
    });
    expect(info.clientName).toBe("App");
    const decision = await client.oauthAuthorizeDecision({
      clientId: "ggc_x",
      redirectUri: "https://client.example/cb",
      codeChallenge: "chal",
      decision: "approve",
    });
    expect(decision.redirectTo).toContain("code=abc");
    expect(bodyOf(calls[1]!)).toMatchObject({
      code_challenge_method: "S256",
      decision: "approve",
    });
  });
});
