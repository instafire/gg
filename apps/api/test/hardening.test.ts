/**
 * Final hardening — integration tests (runs against gg_test).
 *
 * Covers: webhook secret encryption at rest + signing (D-065), audio
 * Range responses, password reset + SMTP mailer gating (D-070), TOTP
 * 2FA full flow (D-067), passkeys with a software authenticator
 * (D-068), social OAuth against a mocked provider (D-069), and the
 * OAuth authorization-code grant with PKCE (D-066).
 */
import {
  createHash,
  createHmac,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { loadConfig, loadDotEnv } from "../src/config";
import { closeDb, getDb } from "../src/db";
import {
  media,
  oauthAuthorizationCodes,
  oauthIdentities,
  passkeyCredentials,
  passwordResetTokens,
  userTotp,
  users,
  webhookDeliveries,
  webhooks,
} from "../src/db/schema";
import { SmtpMailer, createMailer, devLinksEnabled } from "../src/lib/mailer";
import { encryptLegacyWebhookSecrets } from "../src/services/webhooks";
import { attemptWebhookDelivery } from "../src/services/webhooks";
import { LocalStorageAdapter, processMediaFile } from "@gg/media";
import { totp as totpCode } from "../src/lib/totp";

process.env.MEDIA_DIR = mkdtempSync(path.join(os.tmpdir(), "gg-hardening-media-"));
process.env.WEBHOOK_ENCRYPTION_KEY = Buffer.from(
  "gg-test-field-key-32-bytes-12345",
).toString("base64");
process.env.WEBHOOK_TIMEOUT_MS = "3000";

const suffix = randomBytes(3).toString("hex");
const cred = ["hardening", "pass", "123456"].join("-");

let app: FastifyInstance;
let config: ReturnType<typeof loadConfig>;
type Db = ReturnType<typeof getDb>["db"];
let db: Db;

// ── Mocked social provider (Google-shaped) ─────────────────────────────
let providerServer: Server;
let providerBase = "";
const mockProfile = {
  sub: `g-sub-${suffix}`,
  email: `social_new_${suffix}@example.com`,
  email_verified: true,
};

interface TestUser {
  accessToken: string;
  refreshCookie: string | null;
  id: string;
  handle: string;
  email: string;
}

async function registerUser(handle: string): Promise<TestUser> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      handle,
      email: `${handle}@example.com`,
      ["password"]: cred,
      dateOfBirth: "1995-04-02",
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as {
    user: { id: string };
    tokens: { access_token: string };
  };
  const setCookie = res.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie.join(";") : (setCookie ?? "");
  const refresh = /gg_refresh=([^;]+)/.exec(cookieHeader)?.[1] ?? null;
  return {
    accessToken: body.tokens.access_token,
    refreshCookie: refresh ? decodeURIComponent(refresh) : null,
    id: body.user.id,
    handle,
    email: `${handle}@example.com`,
  };
}

function auth(user: TestUser): Record<string, string> {
  return { authorization: `Bearer ${user.accessToken}` };
}

async function login(email: string, password: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, ["password"]: password },
  });
}

beforeAll(async () => {
  // Mocked OAuth provider: token + userinfo endpoints only.
  providerServer = createServer((req, res) => {
    if (req.url === "/token" && req.method === "POST") {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "mock-access-token", token_type: "Bearer" }));
      });
      return;
    }
    if (req.url === "/userinfo") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(mockProfile));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
  const address = providerServer.address();
  providerBase = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  process.env.OAUTH_GOOGLE_CLIENT_ID = "gg-test-google-client";
  process.env.OAUTH_GOOGLE_CLIENT_SECRET = ["gg", "test", "google", "secret"].join("-");
  process.env.OAUTH_GOOGLE_AUTHORIZE_URL = `${providerBase}/authorize`;
  process.env.OAUTH_GOOGLE_TOKEN_URL = `${providerBase}/token`;
  process.env.OAUTH_GOOGLE_USERINFO_URL = `${providerBase}/userinfo`;

  loadDotEnv();
  config = loadConfig();
  app = await buildApp(config);
  await app.ready();
  db = getDb(config.DATABASE_URL).db;
});

afterAll(async () => {
  await app.close();
  await closeDb();
  providerServer.close();
});

// ── 1. Webhook secret encryption (D-065) ───────────────────────────────

describe("webhook secrets are encrypted at rest", () => {
  it("stores enc:v1 ciphertext; delivery still signs with the plaintext", async () => {
    const owner = await registerUser(`whenc${suffix}`);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/users/me/webhooks",
      headers: auth(owner),
      payload: { url: "https://example.com/hook", events: ["ping"] },
    });
    expect(created.statusCode).toBe(201);
    const wire = created.json() as { id: string; secret: string };
    expect(wire.secret).toMatch(/^ggwh_/);

    const [row] = await db.select().from(webhooks).where(eq(webhooks.id, wire.id));
    expect(row).toBeTruthy();
    expect(row!.secret).toMatch(/^enc:v1:/);
    expect(row!.secret).not.toContain(wire.secret);

    // Delivery decrypts before signing: the HMAC must verify against
    // the PLAINTEXT secret the owner was shown once.
    const { uuidv7 } = await import("../src/lib/ids");
    const payload = {
      id: `evt_${suffix}`,
      event: "ping",
      created_at: new Date().toISOString(),
      data: { hello: "world" },
    };
    const deliveryId = uuidv7();
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      webhookId: row!.id,
      event: "ping",
      payload,
      status: "pending",
    });
    const deliveries: { url: string; init?: RequestInit }[] = [];
    const fetchStub = (async (url: string, init?: RequestInit) => {
      deliveries.push({ url, init });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const outcome = await attemptWebhookDelivery(db, config, deliveryId, fetchStub);
    expect(outcome).toBe("delivered");
    const headers = (deliveries[0]!.init?.headers ?? {}) as Record<string, string>;
    const body = String(deliveries[0]!.init?.body ?? "");
    // jsonb storage reorders keys, so the invariant is: the signature
    // verifies over the exact bytes sent, using the plaintext secret.
    expect(JSON.parse(body)).toMatchObject({ id: payload.id, event: "ping" });
    const expected = createHmac("sha256", wire.secret).update(body).digest("hex");
    expect(headers["x-gg-signature"]).toBe(`sha256=${expected}`);
  });

  it("backfill re-encrypts legacy plaintext rows", async () => {
    const owner = await registerUser(`whlegacy${suffix}`);
    const legacySecret = `whsec_legacy_${suffix}`;
    const { uuidv7 } = await import("../src/lib/ids");
    const id = uuidv7();
    await db.insert(webhooks).values({
      id,
      ownerId: owner.id,
      url: "https://example.com/legacy",
      events: ["post.created"],
      secret: legacySecret,
      isActive: true,
    });
    const rewritten = await encryptLegacyWebhookSecrets(db, config);
    expect(rewritten).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(webhooks).where(eq(webhooks.id, id));
    expect(row!.secret).toMatch(/^enc:v1:/);
    expect(row!.secret).not.toContain(legacySecret);
  });
});

// ── 2. Password reset + mailer gating (D-070) ──────────────────────────

describe("password reset", () => {
  it("full flow: hashed token, reset revokes sessions, old password dies", async () => {
    const user = await registerUser(`pwreset${suffix}`);
    const forgot = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/forgot",
      payload: { email: user.email },
    });
    expect(forgot.statusCode).toBe(202);
    const forgotBody = forgot.json() as { dev_reset_url?: string };
    expect(forgotBody.dev_reset_url).toContain("/reset-password?token=");
    const rawToken = new URL(forgotBody.dev_reset_url!).searchParams.get("token")!;

    const [tokenRow] = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, user.id));
    expect(tokenRow).toBeTruthy();
    expect(tokenRow!.tokenHash).toBe(
      createHash("sha256").update(rawToken).digest("hex"),
    );
    expect(JSON.stringify(tokenRow)).not.toContain(rawToken);

    const newPassword = ["reset", "new", "pass", "999"].join("-");
    const reset = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/reset",
      payload: { token: rawToken, new_password: newPassword },
    });
    expect(reset.statusCode).toBe(200);

    // Old session's refresh cookie is revoked.
    expect(user.refreshCookie).toBeTruthy();
    const refresh = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: { gg_refresh: user.refreshCookie! },
    });
    expect(refresh.statusCode).toBe(401);

    // Old password fails, new password works.
    expect((await login(user.email, cred)).statusCode).toBe(401);
    expect((await login(user.email, newPassword)).statusCode).toBe(200);

    // Token is single-use.
    const reuse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/reset",
      payload: { token: rawToken, new_password: newPassword },
    });
    expect(reuse.statusCode).toBe(400);
  });

  it("forgot is enumeration-safe for unknown emails", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/forgot",
      payload: { email: `nobody_${suffix}@example.com` },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).not.toHaveProperty("dev_reset_url");
  });

  it("SMTP-configured app sends real mail and hides dev links", async () => {
    // Unit: the SMTP adapter hands the right message to the transport.
    const sent: { from: string; to: string; subject: string; text: string }[] = [];
    const fakeTransport = {
      sendMail: async (options: { from: string; to: string; subject: string; text: string }) => {
        sent.push(options);
        return { messageId: "fake" };
      },
    };
    const smtpConfig = { ...config, MAILER: "smtp" as const, SMTP_FROM: "GG <no-reply@example.com>" };
    const mailer = createMailer(smtpConfig, () => {}, fakeTransport);
    expect(mailer).toBeInstanceOf(SmtpMailer);
    await mailer.sendPasswordResetEmail("a@example.com", "https://gg.example/reset-password?token=x");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain("Reset your GG password");
    expect(sent[0]!.text).toContain("token=x");

    // Gating: with SMTP configured, no dev links anywhere.
    expect(devLinksEnabled(smtpConfig)).toBe(false);
    expect(devLinksEnabled(config)).toBe(true); // test env: log mailer, non-production

    const smtpApp = await buildApp(smtpConfig);
    try {
      const res = await smtpApp.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          handle: `smtp${suffix}`,
          email: `smtp${suffix}@example.com`,
          ["password"]: cred,
          dateOfBirth: "1995-04-02",
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).not.toHaveProperty("dev_verification_url");
    } finally {
      await smtpApp.close();
    }
  });
});

// ── 3. TOTP 2FA (D-067) ────────────────────────────────────────────────

function secretFromOtpauth(uri: string): string {
  const secret = new URL(uri).searchParams.get("secret");
  expect(secret).toBeTruthy();
  return secret!;
}

describe("TOTP two-factor auth", () => {
  it("enroll → login challenge → recovery code → disable", async () => {
    const user = await registerUser(`totp${suffix}`);

    const status0 = await app.inject({
      method: "GET",
      url: "/api/v1/auth/2fa/status",
      headers: auth(user),
    });
    expect(status0.json()).toMatchObject({ totp_enabled: false, has_passkey: false });

    const begin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/2fa/totp",
      headers: auth(user),
      payload: {},
    });
    expect(begin.statusCode).toBe(200);
    const { otpauth_uri } = begin.json() as { otpauth_uri: string };
    expect(otpauth_uri).toContain("otpauth://totp/");
    const secret = secretFromOtpauth(otpauth_uri);

    // The secret at rest is encrypted, never the base32 plaintext.
    const [totpRow] = await db.select().from(userTotp).where(eq(userTotp.userId, user.id));
    expect(totpRow!.secretEnc).toMatch(/^enc:v1:/);
    expect(totpRow!.secretEnc).not.toContain(secret);

    // Wrong code does not enable.
    const wrong = await app.inject({
      method: "POST",
      url: "/api/v1/auth/2fa/totp/verify",
      headers: auth(user),
      payload: { code: "000000" },
    });
    expect(wrong.statusCode).toBe(422);

    const enable = await app.inject({
      method: "POST",
      url: "/api/v1/auth/2fa/totp/verify",
      headers: auth(user),
      payload: { code: totpCode(secret) },
    });
    expect(enable.statusCode).toBe(200);
    const { recovery_codes } = enable.json() as { recovery_codes: string[] };
    expect(recovery_codes).toHaveLength(10);

    // Enabling promoted the trust tier to T2.
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: auth(user),
    });
    expect(me.json()).toMatchObject({ trust_tier: "T2" });

    // Login now stops at the challenge — no tokens issued.
    const loginRes = await login(user.email, cred);
    expect(loginRes.statusCode).toBe(200);
    const challenge = loginRes.json() as {
      totp_required?: boolean;
      challenge_token?: string;
      tokens?: unknown;
    };
    expect(challenge.totp_required).toBe(true);
    expect(challenge.challenge_token).toBeTruthy();
    expect(challenge.tokens).toBeUndefined();

    // Bad code against the challenge → 401.
    const badVerify = await app.inject({
      method: "POST",
      url: "/api/v1/auth/2fa/totp/verify",
      payload: { code: "000000", challenge_token: challenge.challenge_token },
    });
    expect(badVerify.statusCode).toBe(401);

    // Correct code completes the login.
    const goodVerify = await app.inject({
      method: "POST",
      url: "/api/v1/auth/2fa/totp/verify",
      payload: { code: totpCode(secret), challenge_token: challenge.challenge_token },
    });
    expect(goodVerify.statusCode).toBe(200);
    expect(goodVerify.json()).toHaveProperty("tokens.access_token");

    // A recovery code works — once.
    const login2 = await login(user.email, cred);
    const challenge2 = (login2.json() as { challenge_token: string }).challenge_token;
    const recoveryUse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/2fa/totp/verify",
      payload: { code: recovery_codes[0], challenge_token: challenge2 },
    });
    expect(recoveryUse.statusCode).toBe(200);
    const login3 = await login(user.email, cred);
    const challenge3 = (login3.json() as { challenge_token: string }).challenge_token;
    const recoveryReuse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/2fa/totp/verify",
      payload: { code: recovery_codes[0], challenge_token: challenge3 },
    });
    expect(recoveryReuse.statusCode).toBe(401);

    // Disable requires password + code.
    const disableBad = await app.inject({
      method: "DELETE",
      url: "/api/v1/auth/2fa/totp",
      headers: auth(user),
      payload: { ["password"]: "wrong-password", code: totpCode(secret) },
    });
    expect(disableBad.statusCode).toBe(401);
    const disable = await app.inject({
      method: "DELETE",
      url: "/api/v1/auth/2fa/totp",
      headers: auth(user),
      payload: { ["password"]: cred, code: totpCode(secret) },
    });
    expect(disable.statusCode).toBe(200);

    // Login is direct again.
    const login4 = await login(user.email, cred);
    expect(login4.json()).toHaveProperty("tokens.access_token");
  });
});

// ── 4. Passkeys with a software authenticator (D-068) ──────────────────

// Minimal CBOR encoder (maps/arrays/ints/text/bytes) for the virtual
// authenticator's attestation objects and COSE keys.
function cborEncode(value: unknown): Buffer {
  if (typeof value === "number") {
    if (value >= 0) return cborHead(0, value);
    return cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    return Buffer.concat([cborHead(2, bytes.length), bytes]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([cborHead(4, value.length), ...value.map(cborEncode)]);
  }
  if (value instanceof Map) {
    const entries = [...value.entries()];
    return Buffer.concat([
      cborHead(5, entries.length),
      ...entries.flatMap(([k, v]) => [cborEncode(k), cborEncode(v)]),
    ]);
  }
  throw new Error(`cbor: unsupported ${typeof value}`);
}
function cborHead(major: number, arg: number): Buffer {
  if (arg < 24) return Buffer.from([(major << 5) | arg]);
  if (arg < 256) return Buffer.from([(major << 5) | 24, arg]);
  if (arg < 65536) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(arg, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(arg, 1);
  return b;
}

interface VirtualAuthenticator {
  credentialId: Buffer;
  privateKey: KeyObject;
  publicKeyCose: Buffer;
  signCount: number;
}

function createVirtualAuthenticator(): VirtualAuthenticator {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const cose = cborEncode(
    new Map<unknown, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x, "base64url")],
      [-3, Buffer.from(jwk.y, "base64url")],
    ]),
  );
  return {
    credentialId: randomBytes(32),
    privateKey,
    publicKeyCose: cose,
    signCount: 0,
  };
}

function clientData(type: string, challenge: string, origin: string): string {
  return Buffer.from(
    JSON.stringify({ type, challenge, origin, crossOrigin: false }),
  ).toString("base64url");
}

function registrationResponse(
  authenticator: VirtualAuthenticator,
  challenge: string,
  origin: string,
  rpId: string,
): Record<string, unknown> {
  const rpIdHash = createHash("sha256").update(rpId).digest();
  const credIdLength = Buffer.alloc(2);
  credIdLength.writeUInt16BE(authenticator.credentialId.length);
  const authData = Buffer.concat([
    rpIdHash,
    Buffer.from([0x41]), // UP | AT
    Buffer.alloc(4), // signCount 0
    Buffer.alloc(16), // AAGUID zeros
    credIdLength,
    authenticator.credentialId,
    authenticator.publicKeyCose,
  ]);
  const attestationObject = cborEncode(
    new Map<unknown, unknown>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ]),
  );
  const id = authenticator.credentialId.toString("base64url");
  return {
    id,
    rawId: id,
    type: "public-key",
    authenticatorAttachment: "platform",
    clientExtensionResults: {},
    response: {
      clientDataJSON: clientData("webauthn.create", challenge, origin),
      attestationObject: attestationObject.toString("base64url"),
      transports: ["internal"],
    },
  };
}

function authenticationResponse(
  authenticator: VirtualAuthenticator,
  challenge: string,
  origin: string,
  rpId: string,
): Record<string, unknown> {
  authenticator.signCount += 1;
  const rpIdHash = createHash("sha256").update(rpId).digest();
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(authenticator.signCount);
  const authData = Buffer.concat([rpIdHash, Buffer.from([0x01]), counter]);
  const clientDataJson = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge,
      origin,
      crossOrigin: false,
    }),
  );
  const clientHash = createHash("sha256").update(clientDataJson).digest();
  const signature = createSign("sha256")
    .update(Buffer.concat([authData, clientHash]))
    .sign(authenticator.privateKey);
  const id = authenticator.credentialId.toString("base64url");
  return {
    id,
    rawId: id,
    type: "public-key",
    authenticatorAttachment: "platform",
    clientExtensionResults: {},
    response: {
      clientDataJSON: clientDataJson.toString("base64url"),
      authenticatorData: authData.toString("base64url"),
      signature: signature.toString("base64url"),
      userHandle: null,
    },
  };
}

function cookieOf(res: { headers: Record<string, unknown> }, name: string): string {
  const setCookie = res.headers["set-cookie"];
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const entry of list) {
    if (typeof entry === "string" && entry.startsWith(`${name}=`)) {
      return decodeURIComponent(entry.slice(name.length + 1).split(";")[0]!);
    }
  }
  throw new Error(`cookie ${name} not set`);
}

describe("passkeys (software authenticator)", () => {
  it("register → login → delete, with counter tracking", async () => {
    const user = await registerUser(`passkey${suffix}`);
    const origin = config.APP_BASE_URL;
    const rpId = new URL(config.APP_BASE_URL).hostname;
    const authenticator = createVirtualAuthenticator();

    const optionsRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/passkeys/register/options",
      headers: auth(user),
      payload: {},
    });
    expect(optionsRes.statusCode).toBe(200);
    const options = optionsRes.json() as { challenge: string };
    const challengeCookie = cookieOf(optionsRes, "gg_webauthn_challenge");

    const verifyRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/passkeys/register/verify",
      headers: auth(user),
      cookies: { gg_webauthn_challenge: challengeCookie },
      payload: {
        credential: registrationResponse(authenticator, options.challenge, origin, rpId),
        label: "Test key",
      },
    });
    expect(verifyRes.statusCode).toBe(201);

    const status = await app.inject({
      method: "GET",
      url: "/api/v1/auth/2fa/status",
      headers: auth(user),
    });
    const statusBody = status.json() as {
      has_passkey: boolean;
      passkeys: { id: string; label: string | null }[];
    };
    expect(statusBody.has_passkey).toBe(true);
    expect(statusBody.passkeys).toHaveLength(1);
    expect(statusBody.passkeys[0]!.label).toBe("Test key");

    // Login ceremony.
    const loginOptions = await app.inject({
      method: "POST",
      url: "/api/v1/auth/passkeys/login/options",
      payload: {},
    });
    expect(loginOptions.statusCode).toBe(200);
    const loginChallenge = (loginOptions.json() as { challenge: string }).challenge;
    const loginCookie = cookieOf(loginOptions, "gg_webauthn_challenge");
    const loginVerify = await app.inject({
      method: "POST",
      url: "/api/v1/auth/passkeys/login/verify",
      cookies: { gg_webauthn_challenge: loginCookie },
      payload: {
        credential: authenticationResponse(authenticator, loginChallenge, origin, rpId),
      },
    });
    expect(loginVerify.statusCode).toBe(200);
    expect(loginVerify.json()).toHaveProperty("tokens.access_token");

    const [stored] = await db
      .select()
      .from(passkeyCredentials)
      .where(eq(passkeyCredentials.userId, user.id));
    expect(stored!.counter).toBe(1);
    expect(stored!.lastUsedAt).not.toBeNull();

    // A tampered signature is rejected.
    const loginOptions2 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/passkeys/login/options",
      payload: {},
    });
    const challenge2 = (loginOptions2.json() as { challenge: string }).challenge;
    const cookie2 = cookieOf(loginOptions2, "gg_webauthn_challenge");
    const forged = authenticationResponse(authenticator, challenge2, origin, rpId) as {
      response: { signature: string };
    };
    const sigBytes = Buffer.from(forged.response.signature, "base64url");
    sigBytes[sigBytes.length - 1] = sigBytes[sigBytes.length - 1]! ^ 0xff;
    forged.response.signature = sigBytes.toString("base64url");
    const forgedRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/passkeys/login/verify",
      cookies: { gg_webauthn_challenge: cookie2 },
      payload: { credential: forged },
    });
    expect(forgedRes.statusCode).toBe(401);

    // Delete removes it.
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/passkeys/${statusBody.passkeys[0]!.id}`,
      headers: auth(user),
    });
    expect(del.statusCode).toBe(200);
    const status2 = await app.inject({
      method: "GET",
      url: "/api/v1/auth/2fa/status",
      headers: auth(user),
    });
    expect(status2.json()).toMatchObject({ has_passkey: false });
  });
});

// ── 5. Social OAuth (mocked provider, D-069) ───────────────────────────

describe("social OAuth (mocked Google)", () => {
  async function authorizeAndCallback(): Promise<{
    location: string;
    setCookie: unknown;
  }> {
    const authorize = await app.inject({
      method: "GET",
      url: "/api/v1/auth/oauth/google/authorize",
    });
    expect(authorize.statusCode).toBe(302);
    const location = authorize.headers.location as string;
    expect(location.startsWith(`${providerBase}/authorize`)).toBe(true);
    const state = new URL(location).searchParams.get("state")!;
    const stateCookie = cookieOf(authorize, "gg_oauth_state");
    const callback = await app.inject({
      method: "GET",
      url: `/api/v1/auth/oauth/google/callback?code=mock-code&state=${encodeURIComponent(state)}`,
      cookies: { gg_oauth_state: stateCookie },
    });
    expect(callback.statusCode).toBe(302);
    return { location: callback.headers.location as string, setCookie: callback.headers["set-cookie"] };
  }

  it("lists configured providers only", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/oauth/providers" });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { providers: { id: string }[] }).providers.map((p) => p.id);
    expect(ids).toContain("google");
    expect(ids).not.toContain("discord");
  });

  it("creates a verified T1 account for a new verified email, then logs the same user in", async () => {
    mockProfile.sub = `g-new-${suffix}`;
    mockProfile.email = `social_new_${suffix}@example.com`;
    mockProfile.email_verified = true;
    const first = await authorizeAndCallback();
    expect(first.location).toBe(`${config.APP_BASE_URL}/onboarding`);

    const [created] = await db
      .select()
      .from(users)
      .where(eq(users.email, mockProfile.email));
    expect(created).toBeTruthy();
    expect(created!.emailVerifiedAt).not.toBeNull();
    expect(created!.trustTier).toBe("T1");
    const [identity] = await db
      .select()
      .from(oauthIdentities)
      .where(eq(oauthIdentities.providerUserId, mockProfile.sub));
    expect(identity!.userId).toBe(created!.id);

    // With a DOB on file the same identity lands on /home.
    await db
      .update(users)
      .set({ dateOfBirth: "1990-01-01" })
      .where(eq(users.id, created!.id));
    const second = await authorizeAndCallback();
    expect(second.location).toBe(`${config.APP_BASE_URL}/home`);
  });

  it("refuses an unverified provider email", async () => {
    mockProfile.sub = `g-unverified-${suffix}`;
    mockProfile.email = `social_unv_${suffix}@example.com`;
    mockProfile.email_verified = false;
    const result = await authorizeAndCallback();
    expect(result.location).toContain("error=social_unverified");
    const rows = await db.select().from(users).where(eq(users.email, mockProfile.email));
    expect(rows).toHaveLength(0);
  });

  it("links by verified email to an existing account", async () => {
    const existing = await registerUser(`linkme${suffix}`);
    mockProfile.sub = `g-link-${suffix}`;
    mockProfile.email = existing.email;
    mockProfile.email_verified = true;
    const result = await authorizeAndCallback();
    expect(result.location).toContain("/home");
    const [identity] = await db
      .select()
      .from(oauthIdentities)
      .where(eq(oauthIdentities.providerUserId, mockProfile.sub));
    expect(identity!.userId).toBe(existing.id);
  });

  it("rejects a callback with a forged state", async () => {
    const callback = await app.inject({
      method: "GET",
      url: "/api/v1/auth/oauth/google/callback?code=mock-code&state=forged",
      cookies: { gg_oauth_state: "google.forged.badsig" },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain("error=social_state");
  });
});

// ── 6. OAuth authorization-code grant + PKCE (D-066) ───────────────────

describe("OAuth authorization-code grant", () => {
  it("consent → code → PKCE exchange → user-context token; misuse rejected", async () => {
    const owner = await registerUser(`oauthcode${suffix}`);
    const clientRes = await app.inject({
      method: "POST",
      url: "/api/v1/developers/oauth-clients",
      headers: auth(owner),
      payload: {
        name: "Code Flow App",
        redirect_uris: ["https://client.example/callback"],
        allowed_scopes: ["read:feed", "write:post"],
        is_confidential: false,
      },
    });
    expect(clientRes.statusCode).toBe(201);
    const client = clientRes.json() as { client_id: string };
    const redirectUri = "https://client.example/callback";
    const verifier = `verifier-${suffix}-0123456789abcdefghijklmnopqrstuvwxyz`;
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    const authorizeQuery = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: "read:feed",
      state: "state-123",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const info = await app.inject({
      method: "GET",
      url: `/api/v1/oauth/authorize?${authorizeQuery.toString()}`,
      headers: auth(owner),
    });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({
      client_name: "Code Flow App",
      scopes: ["read:feed"],
    });

    const decision = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/authorize",
      headers: auth(owner),
      payload: {
        client_id: client.client_id,
        redirect_uri: redirectUri,
        scope: "read:feed",
        state: "state-123",
        code_challenge: challenge,
        code_challenge_method: "S256",
        decision: "approve",
      },
    });
    expect(decision.statusCode).toBe(200);
    const redirectTo = (decision.json() as { redirect_to: string }).redirect_to;
    const code = new URL(redirectTo).searchParams.get("code")!;
    expect(code).toBeTruthy();
    expect(new URL(redirectTo).searchParams.get("state")).toBe("state-123");

    // Only the hash is stored.
    const expectedHash = createHash("sha256").update(code).digest("hex");
    const [codeRow] = await db
      .select()
      .from(oauthAuthorizationCodes)
      .where(eq(oauthAuthorizationCodes.codeHash, expectedHash));
    expect(codeRow).toBeTruthy();
    expect(JSON.stringify(codeRow)).not.toContain(code);

    // Wrong verifier → PKCE failure, and the code is NOT burned.
    const badExchange = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      payload: {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier",
      },
    });
    expect(badExchange.statusCode).toBe(400);

    const exchange = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      payload: {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        code_verifier: verifier,
      },
    });
    expect(exchange.statusCode).toBe(200);
    const tokenBody = exchange.json() as { access_token: string; scope: string };
    expect(tokenBody.scope).toBe("read:feed");

    // The token acts as the consenting user.
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: { authorization: `Bearer ${tokenBody.access_token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: owner.id });

    // Single-use: replaying the code fails.
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      payload: {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        code_verifier: verifier,
      },
    });
    expect(replay.statusCode).toBe(400);

    // Deny path + unregistered redirect rejection.
    const deny = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/authorize",
      headers: auth(owner),
      payload: {
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        decision: "deny",
      },
    });
    expect((deny.json() as { redirect_to: string }).redirect_to).toContain("error=access_denied");

    const badRedirect = await app.inject({
      method: "GET",
      url: `/api/v1/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}`,
      headers: auth(owner),
    });
    expect(badRedirect.statusCode).toBe(422);
  });
});

// ── 7. Audio Range responses ───────────────────────────────────────────

describe("media file Range support", () => {
  it("serves byte ranges for audio and 416s invalid ones", async () => {
    const user = await registerUser(`range${suffix}`);
    // Deterministic WAV: every sample byte = its index mod 251.
    const samples = 4000;
    const bytes = Buffer.alloc(44 + samples * 2);
    bytes.write("RIFF", 0);
    bytes.writeUInt32LE(36 + samples * 2, 4);
    bytes.write("WAVE", 8);
    bytes.write("fmt ", 12);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(8000, 24);
    bytes.writeUInt32LE(16000, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write("data", 36);
    bytes.writeUInt32LE(samples * 2, 40);
    for (let i = 44; i < bytes.length; i += 1) bytes[i] = i % 251;

    const session = await app.inject({
      method: "POST",
      url: "/api/v1/media/uploads",
      headers: auth(user),
      payload: { kind: "audio", mime_type: "audio/wav", size_bytes: bytes.length },
    });
    expect(session.statusCode).toBe(201);
    const wire = session.json() as { media_id: string; signed_put_url: string };
    const put = await app.inject({
      method: "PUT",
      url: wire.signed_put_url,
      headers: { ...auth(user), "content-type": "application/octet-stream" },
      payload: bytes,
    });
    expect(put.statusCode).toBe(200);
    const complete = await app.inject({
      method: "POST",
      url: `/api/v1/media/uploads/${wire.media_id}/complete`,
      headers: auth(user),
      payload: {},
    });
    expect(complete.statusCode).toBe(202);

    const [row] = await db.select().from(media).where(eq(media.id, wire.media_id));
    const store = new LocalStorageAdapter(config.MEDIA_DIR);
    const result = await processMediaFile(store, {
      id: row!.id,
      kind: row!.kind,
      mimeType: row!.mimeType,
      storageKey: row!.storageKey,
    });
    await db
      .update(media)
      .set({
        status: result.status,
        scanVerdict: result.scanVerdict,
        contentLabels: result.contentLabels,
        durationMs: result.durationMs,
        variants: result.variants,
        storageKey: result.storageKey,
        updatedAt: new Date(),
      })
      .where(eq(media.id, wire.media_id));
    expect(result.status).toBe("ready");

    const meta = await app.inject({
      method: "GET",
      url: `/api/v1/media/${wire.media_id}`,
      headers: auth(user),
    });
    const fileUrl = (meta.json() as { url: string }).url;
    const size = bytes.length;

    const full = await app.inject({ method: "GET", url: fileUrl });
    expect(full.statusCode).toBe(200);
    expect(full.headers["accept-ranges"]).toBe("bytes");
    expect(full.rawPayload.length).toBe(size);

    const ranged = await app.inject({
      method: "GET",
      url: fileUrl,
      headers: { range: "bytes=100-199" },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers["content-range"]).toBe(`bytes 100-199/${size}`);
    expect(ranged.rawPayload.equals(bytes.subarray(100, 200))).toBe(true);

    const suffixRange = await app.inject({
      method: "GET",
      url: fileUrl,
      headers: { range: "bytes=-50" },
    });
    expect(suffixRange.statusCode).toBe(206);
    expect(suffixRange.headers["content-range"]).toBe(
      `bytes ${size - 50}-${size - 1}/${size}`,
    );
    expect(suffixRange.rawPayload.equals(bytes.subarray(size - 50))).toBe(true);

    const openRange = await app.inject({
      method: "GET",
      url: fileUrl,
      headers: { range: `bytes=${size - 10}-` },
    });
    expect(openRange.statusCode).toBe(206);
    expect(openRange.rawPayload.length).toBe(10);

    const beyond = await app.inject({
      method: "GET",
      url: fileUrl,
      headers: { range: `bytes=${size + 100}-` },
    });
    expect(beyond.statusCode).toBe(416);
    expect(beyond.headers["content-range"]).toBe(`bytes */${size}`);

    const multi = await app.inject({
      method: "GET",
      url: fileUrl,
      headers: { range: "bytes=0-1,5-6" },
    });
    expect(multi.statusCode).toBe(416);
  });
});
