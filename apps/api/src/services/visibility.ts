import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { AppContext } from "../context";
import { blocks, mutes, userSettings, users } from "../db/schema";

/**
 * Ids the viewer must never see in feeds/lists: blocked (either way) +
 * muted (active) + deactivated accounts (their posts hide while the
 * account is deactivated — the deactivation contract).
 */
export async function hiddenAuthorIds(
  ctx: AppContext,
  viewerId: string,
): Promise<string[]> {
  const { db } = ctx;
  const [blockedByMe, blockedMe, muted, deactivated] = await Promise.all([
    db.select().from(blocks).where(eq(blocks.blockerId, viewerId)),
    db.select().from(blocks).where(eq(blocks.blockedId, viewerId)),
    db
      .select()
      .from(mutes)
      .where(
        and(
          eq(mutes.muterId, viewerId),
          or(isNull(mutes.expiresAt), sql`${mutes.expiresAt} > now()`),
        ),
      ),
    db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.status, "deactivated"), ne(users.id, viewerId))),
  ]);
  return [
    ...blockedByMe.map((r) => r.blockedId),
    ...blockedMe.map((r) => r.blockerId),
    ...muted.map((r) => r.mutedId),
    ...deactivated.map((r) => r.id),
  ];
}

/** The viewer's hide-AI-accounts setting (D-012 transparency control). */
export async function hideAiAccounts(
  ctx: AppContext,
  viewerId: string,
): Promise<boolean> {
  const [settings] = await ctx.db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, viewerId))
    .limit(1);
  return settings?.hideAiAccounts ?? false;
}
