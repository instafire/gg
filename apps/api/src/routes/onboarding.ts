/**
 * Onboarding (round 2): suggested communities/accounts/topics for the
 * post-register flow, and completion (topics → user_settings.preferences,
 * users.onboarding_completed_at stamped).
 */
import { and, desc, eq, isNull, ne, notInArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import {
  communities,
  communityMembers,
  follows,
  userSettings,
  users,
} from "../db/schema";
import { requireAuth } from "../lib/auth";
import { unauthorized } from "../lib/errors";
import { communityWire, userPrivateWire } from "../lib/serializers";
import { parseBody } from "../lib/validate";
import { getProfile, getUserById, profileMap } from "../services/users";

/** Fallback topic chips when communities carry too few topics of their own. */
const BASE_TOPICS = ["gg", "news", "tech", "sports", "movies", "music", "climate"];

const completeSchema = z.object({
  topics: z.array(z.string().min(1).max(30)).max(12).default([]),
});

export async function registerOnboardingRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db } = ctx;

  app.get(
    "/api/v1/onboarding/suggested",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const me = request.authUser!;

      const joinedRows = await db
        .select({ id: communityMembers.communityId })
        .from(communityMembers)
        .where(
          and(
            eq(communityMembers.userId, me.sub),
            eq(communityMembers.status, "active"),
          ),
        );
      const joinedIds = joinedRows.map((r) => r.id);
      const communityRows = await db
        .select()
        .from(communities)
        .where(
          and(
            isNull(communities.deletedAt),
            ne(communities.visibility, "private"),
            joinedIds.length > 0
              ? notInArray(communities.id, joinedIds)
              : undefined,
          ),
        )
        .orderBy(desc(communities.memberCount), desc(communities.id))
        .limit(8);

      // Suggested accounts: the platform agent first (it is the guided
      // first follow), then the most-followed active accounts the viewer
      // does not already follow.
      const followingRows = await db
        .select({ id: follows.followeeId })
        .from(follows)
        .where(eq(follows.followerId, me.sub));
      const followingIds = new Set(followingRows.map((r) => r.id));
      const candidates = await db
        .select()
        .from(users)
        .where(
          and(
            isNull(users.deletedAt),
            eq(users.status, "active"),
            ne(users.id, me.sub),
          ),
        )
        .orderBy(desc(users.followerCount), desc(users.createdAt))
        .limit(25);
      const scout = candidates.find((u) => u.handle === "gg_scout");
      const rest = candidates.filter(
        (u) => u.id !== scout?.id && !followingIds.has(u.id),
      );
      const picked = [
        ...(scout && !followingIds.has(scout.id) ? [scout] : []),
        ...rest,
      ].slice(0, 8);
      const profilesById = await profileMap(
        db,
        picked.map((u) => u.id),
      );
      const accounts = picked
        .map((u) => profilesById.get(u.id))
        .filter((p): p is NonNullable<typeof p> => p !== undefined);

      const topicRows = await db
        .select({ topics: communities.topics })
        .from(communities)
        .where(isNull(communities.deletedAt));
      const topicSet = new Set<string>();
      for (const row of topicRows) for (const topic of row.topics) topicSet.add(topic);
      for (const topic of BASE_TOPICS) {
        if (topicSet.size >= 8) break;
        topicSet.add(topic);
      }

      return {
        communities: communityRows.map((row) => communityWire(row)),
        accounts,
        topics: [...topicSet].slice(0, 12),
      };
    },
  );

  app.post(
    "/api/v1/onboarding/complete",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const body = parseBody(completeSchema, request.body ?? {});
      const me = request.authUser!;
      const topics = [...new Set(body.topics.map((t) => t.trim().toLowerCase()))].filter(
        Boolean,
      );
      await db.transaction(async (tx) => {
        const [settings] = await tx
          .select()
          .from(userSettings)
          .where(eq(userSettings.userId, me.sub))
          .limit(1);
        const preferences = {
          ...((settings?.preferences ?? {}) as Record<string, unknown>),
          topics,
        };
        if (settings) {
          await tx
            .update(userSettings)
            .set({ preferences, updatedAt: new Date() })
            .where(eq(userSettings.userId, me.sub));
        } else {
          await tx.insert(userSettings).values({ userId: me.sub, preferences });
        }
        const [user] = await tx
          .select()
          .from(users)
          .where(eq(users.id, me.sub))
          .limit(1);
        if (user && !user.onboardingCompletedAt) {
          await tx
            .update(users)
            .set({ onboardingCompletedAt: new Date(), updatedAt: new Date() })
            .where(eq(users.id, me.sub));
        }
      });
      const user = await getUserById(db, me.sub);
      if (!user) throw unauthorized("Account no longer exists");
      return userPrivateWire(user, await getProfile(db, me.sub));
    },
  );
}
