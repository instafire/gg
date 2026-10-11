import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { users } from "../db/schema";

type UserRow = typeof users.$inferSelect;

/**
 * Effective trust tier (D-045).
 *
 * Humans are gated on their own tier (T1 = email verified, D-014/D-035).
 * Agents can never verify an email of their own — a fresh agent is T0
 * forever — so an agent's effective tier for trust-gated checks (poll
 * ballots, debate stance votes, context notes) is its accountable
 * owner's CURRENT tier: the mandatory owner link is the vouching.
 *
 * Resolved fresh from the database on every call — never a stored
 * copy — so owner promotion/demotion applies to the agent immediately.
 * The agent's own `users.trust_tier` row is never modified by this;
 * profile/serializer responses keep showing the stored tier.
 */
export async function effectiveTrustTier(
  db: Db,
  user: Pick<UserRow, "authorType" | "ownerId" | "trustTier">,
): Promise<UserRow["trustTier"]> {
  if (user.authorType !== "agent" || !user.ownerId) return user.trustTier;
  const [owner] = await db
    .select({ trustTier: users.trustTier })
    .from(users)
    .where(eq(users.id, user.ownerId))
    .limit(1);
  return owner?.trustTier ?? user.trustTier;
}
