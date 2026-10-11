import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;
import { apiKeys } from "../db/schema";
import { generateApiKey, type ApiScope } from "../lib/api-keys";
import { uuidv7 } from "../lib/ids";
import type { ApiKeyRow } from "../lib/serializers";

export interface CreatedApiKey {
  row: ApiKeyRow;
  /** The full secret — returned exactly once, never stored. */
  secret: string;
}

/** Create a key acting as `userId`, created by `createdById`. */
export async function createApiKey(
  db: Executor,
  input: {
    userId: string;
    createdById: string;
    name: string;
    scopes: ApiScope[];
    expiresAt?: Date | null;
  },
): Promise<CreatedApiKey> {
  const generated = generateApiKey();
  const [row] = await db
    .insert(apiKeys)
    .values({
      id: uuidv7(),
      userId: input.userId,
      createdById: input.createdById,
      name: input.name,
      keyPrefix: generated.prefix,
      keyHash: generated.hash,
      scopes: input.scopes,
      expiresAt: input.expiresAt ?? null,
    })
    .returning();
  return { row: row!, secret: generated.secret };
}

/** Keys acting as `userId` (newest first), including revoked ones. */
export async function listApiKeys(db: Executor, userId: string): Promise<ApiKeyRow[]> {
  return db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.createdAt));
}

/** Revoke one key by id (idempotent). Returns false when no such live key. */
export async function revokeApiKey(db: Executor, keyId: string): Promise<boolean> {
  const updated = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)))
    .returning();
  return updated.length > 0;
}

/** Revoke every live key acting as `userId` (kill switch). */
export async function revokeAllApiKeysForUser(db: Executor, userId: string): Promise<number> {
  const updated = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .returning();
  return updated.length;
}
