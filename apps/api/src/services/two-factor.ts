import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { AppConfig } from "../config";
import type { Db } from "../db";
import {
  credentials,
  passkeyCredentials,
  totpRecoveryCodes,
  users,
  userTotp,
} from "../db/schema";
import type { UserRow } from "../lib/serializers";
import { conflict, unauthorized, unprocessable } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { verifyPassword } from "../lib/passwords";
import {
  decryptField,
  encryptField,
  fieldEncryptionKey,
} from "../lib/secrets";
import {
  generateTotpSecret,
  otpauthUri,
  verifyTotpCode,
} from "../lib/totp";

/**
 * TOTP two-factor auth (hardening, D-067). The TOTP secret is stored
 * AES-256-GCM-encrypted under the shared field key (D-065) — enabling
 * 2FA therefore REQUIRES the field key; without it the API fails closed
 * with a clear error rather than storing a plaintext secret. Recovery
 * codes: 10 single-use codes, SHA-256-hashed at rest, shown once.
 * Enabling TOTP (or registering a passkey) promotes the trust tier to
 * T2, upward only — a stronger-authenticated account is a stronger
 * trust signal (D-014 ladder).
 */

const RECOVERY_CODE_COUNT = 10;

function requireFieldKey(config: AppConfig): Buffer {
  const key = fieldEncryptionKey(config);
  if (!key) {
    throw unprocessable(
      "Two-factor auth is unavailable: the server field-encryption key is not configured.",
    );
  }
  return key;
}

export async function getTotpRow(db: Db, userId: string) {
  const [row] = await db
    .select()
    .from(userTotp)
    .where(eq(userTotp.userId, userId))
    .limit(1);
  return row ?? null;
}

async function decryptTotpSecret(
  config: AppConfig,
  row: { secretEnc: string },
): Promise<string> {
  return decryptField(requireFieldKey(config), row.secretEnc);
}

/** Begin enrollment: mint (or re-mint, pre-enable) the encrypted secret. */
export async function beginTotpEnrollment(
  db: Db,
  config: AppConfig,
  user: UserRow,
): Promise<{ otpauthUri: string }> {
  if (user.totpEnabled) {
    throw conflict("Two-factor auth is already enabled on this account.");
  }
  const key = requireFieldKey(config);
  const secret = generateTotpSecret();
  const encrypted = encryptField(key, secret);
  const existing = await getTotpRow(db, user.id);
  if (existing) {
    await db
      .update(userTotp)
      .set({
        secretEnc: encrypted,
        enabled: false,
        confirmedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(userTotp.userId, user.id));
  } else {
    await db.insert(userTotp).values({
      userId: user.id,
      secretEnc: encrypted,
    });
  }
  return { otpauthUri: otpauthUri(secret, user.handle) };
}

function hashRecoveryCode(code: string): string {
  return createHash("sha256")
    .update(code.replace(/[-\s]/g, "").toUpperCase())
    .digest("hex");
}

function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i += 1) {
    const raw = randomBytes(5).toString("hex").toUpperCase(); // 10 hex chars
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

async function issueRecoveryCodes(db: Db, userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await db
    .delete(totpRecoveryCodes)
    .where(eq(totpRecoveryCodes.userId, userId));
  await db.insert(totpRecoveryCodes).values(
    codes.map((code) => ({
      id: uuidv7(),
      userId,
      codeHash: hashRecoveryCode(code),
    })),
  );
  return codes;
}

/** Burn a recovery code if it matches an unused one. Returns success. */
export async function consumeRecoveryCode(
  db: Db,
  userId: string,
  code: string,
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(totpRecoveryCodes)
    .where(
      and(
        eq(totpRecoveryCodes.userId, userId),
        eq(totpRecoveryCodes.codeHash, hashRecoveryCode(code)),
        isNull(totpRecoveryCodes.usedAt),
      ),
    )
    .limit(1);
  if (!row) return false;
  await db
    .update(totpRecoveryCodes)
    .set({ usedAt: new Date() })
    .where(eq(totpRecoveryCodes.id, row.id));
  return true;
}

/** Verify a login/enrollment code: TOTP first, then a recovery code. */
export async function verifySecondFactor(
  db: Db,
  config: AppConfig,
  user: UserRow,
  code: string,
): Promise<boolean> {
  const row = await getTotpRow(db, user.id);
  if (!row) return false;
  const secret = await decryptTotpSecret(config, row);
  if (verifyTotpCode(secret, code)) return true;
  return consumeRecoveryCode(db, user.id, code);
}

/**
 * Complete enrollment: prove possession of the authenticator, flip
 * users.totp_enabled, promote tier to T2, issue recovery codes (the
 * plaintext codes are returned exactly once, here).
 */
export async function enableTotp(
  db: Db,
  config: AppConfig,
  user: UserRow,
  code: string,
): Promise<{ recoveryCodes: string[] }> {
  const row = await getTotpRow(db, user.id);
  if (!row) {
    throw unprocessable("Start two-factor setup before verifying a code.");
  }
  if (user.totpEnabled) {
    throw conflict("Two-factor auth is already enabled on this account.");
  }
  const secret = await decryptTotpSecret(config, row);
  if (!verifyTotpCode(secret, code)) {
    throw unprocessable("That code didn't match. Check your authenticator and try again.");
  }
  const recoveryCodes = await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(userTotp)
      .set({ enabled: true, confirmedAt: now, updatedAt: now })
      .where(eq(userTotp.userId, user.id));
    const patch: Partial<Pick<UserRow, "totpEnabled" | "trustTier" | "updatedAt">> = {
      totpEnabled: true,
      updatedAt: now,
    };
    if (user.trustTier === "T0" || user.trustTier === "T1") {
      patch.trustTier = "T2";
    }
    await tx.update(users).set(patch).where(eq(users.id, user.id));
    return issueRecoveryCodes(tx as unknown as Db, user.id);
  });
  return { recoveryCodes };
}

/** Disable TOTP: requires the account password AND a second factor. */
export async function disableTotp(
  db: Db,
  config: AppConfig,
  user: UserRow,
  password: string,
  code: string,
): Promise<void> {
  const [cred] = await db
    .select()
    .from(credentials)
    .where(eq(credentials.userId, user.id))
    .limit(1);
  const passwordOk = cred
    ? await verifyPassword(cred.passwordHash, password)
    : false;
  if (!passwordOk) throw unauthorized("Password incorrect.");
  const row = await getTotpRow(db, user.id);
  if (!row || !user.totpEnabled) {
    throw conflict("Two-factor auth is not enabled on this account.");
  }
  const secret = await decryptTotpSecret(config, row);
  const codeOk =
    verifyTotpCode(secret, code) ||
    (await consumeRecoveryCode(db, user.id, code));
  if (!codeOk) throw unauthorized("Second-factor code incorrect.");
  await db.transaction(async (tx) => {
    await tx.delete(userTotp).where(eq(userTotp.userId, user.id));
    await tx
      .delete(totpRecoveryCodes)
      .where(eq(totpRecoveryCodes.userId, user.id));
    await tx
      .update(users)
      .set({ totpEnabled: false, updatedAt: new Date() })
      .where(eq(users.id, user.id));
  });
}

export interface TwoFactorStatus {
  totpEnabled: boolean;
  hasPasskey: boolean;
  passkeys: {
    id: string;
    label: string | null;
    createdAt: Date;
    lastUsedAt: Date | null;
  }[];
}

export async function getTwoFactorStatus(
  db: Db,
  user: UserRow,
): Promise<TwoFactorStatus> {
  const rows = await db
    .select({
      id: passkeyCredentials.id,
      label: passkeyCredentials.deviceName,
      createdAt: passkeyCredentials.createdAt,
      lastUsedAt: passkeyCredentials.lastUsedAt,
    })
    .from(passkeyCredentials)
    .where(eq(passkeyCredentials.userId, user.id));
  return {
    totpEnabled: user.totpEnabled,
    hasPasskey: rows.length > 0,
    passkeys: rows,
  };
}

/** Called by the passkey service after a successful registration. */
export async function promoteTierForPasskey(db: Db, user: UserRow): Promise<void> {
  const patch: Partial<Pick<UserRow, "hasPasskey" | "trustTier" | "updatedAt">> = {
    hasPasskey: true,
    updatedAt: new Date(),
  };
  if (user.trustTier === "T0" || user.trustTier === "T1") {
    patch.trustTier = "T2";
  }
  await db.update(users).set(patch).where(eq(users.id, user.id));
}
