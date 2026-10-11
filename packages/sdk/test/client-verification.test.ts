import { describe, expect, it, vi } from "vitest";
import { GGApiError, GGClient } from "../src/index";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const tokenPairWire = {
  access_token: "access-1",
  refresh_token: "refresh-1",
  token_type: "Bearer",
  expires_in: 900,
};

const userPrivateWire = {
  id: "01921f2e-7b6d-7c8f-9a0b-1c2d3e4f5a6b",
  handle: "newuser",
  email: "newuser@example.com",
  email_verified: false,
  author_type: "human",
  trust_tier: "T0",
  age_bracket: "25_plus",
  status: "active",
  profile: {
    user_id: "01921f2e-7b6d-7c8f-9a0b-1c2d3e4f5a6b",
    handle: "newuser",
    display_name: "New User",
    bio: null,
    avatar_url: null,
    banner_url: null,
    author_type: "human",
    trust_tier: "T0",
    is_private: false,
    follower_count: 0,
    following_count: 0,
  },
};

function makeClient(handler: FetchFn) {
  const fetchImpl = vi.fn<FetchFn>(handler);
  const client = new GGClient({
    baseUrl: "http://localhost:4000",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { client, fetchImpl };
}

describe("email verification (D-035)", () => {
  it("register() surfaces devVerificationUrl from the wire", async () => {
    const devUrl = "http://localhost:3000/verify-email?token=raw-token-1";
    const { client, fetchImpl } = makeClient(async () =>
      jsonResponse(
        { user: userPrivateWire, tokens: tokenPairWire, dev_verification_url: devUrl },
        201,
      ),
    );

    const result = await client.register({
      handle: "newuser",
      email: "newuser@example.com",
      password: "correct-horse-9",
      dateOfBirth: "1995-04-02",
    });

    expect(result.devVerificationUrl).toBe(devUrl);
    expect(result.user?.emailVerified).toBe(false);
    expect(result.user?.trustTier).toBe("T0");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://localhost:4000/api/v1/auth/register");
  });

  it("register() maps a missing dev_verification_url to null (production)", async () => {
    const { client } = makeClient(async () =>
      jsonResponse({ user: userPrivateWire, tokens: tokenPairWire }, 201),
    );
    const result = await client.register({
      handle: "newuser",
      email: "newuser@example.com",
      password: "correct-horse-9",
      dateOfBirth: "1995-04-02",
    });
    expect(result.devVerificationUrl).toBeNull();
  });

  it("verifyEmail() posts the token anonymously and normalizes the result", async () => {
    const verifiedWire = {
      ...userPrivateWire,
      email_verified: true,
      trust_tier: "T1",
      profile: { ...userPrivateWire.profile, trust_tier: "T1" },
    };
    const { client, fetchImpl } = makeClient(async () =>
      jsonResponse({ email_verified: true, user: verifiedWire }),
    );

    const result = await client.verifyEmail("raw-token-1");

    expect(result.emailVerified).toBe(true);
    expect(result.user?.emailVerified).toBe(true);
    expect(result.user?.trustTier).toBe("T1");
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:4000/api/v1/auth/verify-email");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ token: "raw-token-1" });
    // Anonymous call: no Authorization header is attached.
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
  });

  it("verifyEmail() throws GGApiError with the generic detail on a bad token", async () => {
    const { client } = makeClient(async () =>
      jsonResponse(
        {
          type: "about:blank",
          title: "Bad Request",
          status: 400,
          detail: "This verification link is invalid or has expired. Request a new one and try again.",
        },
        400,
      ),
    );
    await expect(client.verifyEmail("bogus")).rejects.toBeInstanceOf(GGApiError);
    await expect(client.verifyEmail("bogus")).rejects.toThrow("invalid or has expired");
  });

  it("resendVerification() returns the pending status and the fresh dev link", async () => {
    const devUrl = "http://localhost:3000/verify-email?token=raw-token-2";
    const { client, fetchImpl } = makeClient(async () =>
      jsonResponse({ status: "pending", dev_verification_url: devUrl }, 202),
    );

    const result = await client.resendVerification();

    expect(result).toEqual({ status: "pending", devVerificationUrl: devUrl });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "http://localhost:4000/api/v1/auth/resend-verification",
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("resendVerification() maps the already-verified no-op", async () => {
    const { client } = makeClient(async () =>
      jsonResponse({ status: "already_verified" }, 202),
    );
    const result = await client.resendVerification();
    expect(result).toEqual({ status: "already_verified", devVerificationUrl: null });
  });
});
