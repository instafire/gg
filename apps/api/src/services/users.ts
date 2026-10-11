import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { communities, debateRatings, profiles, users } from "../db/schema";
import {
  authorRef,
  communityRef,
  profileWire,
  type AuthorRef,
  type DebateRecordSummary,
  type CommunityRef,
  type ProfileRow,
  type ProfileWire,
  type UserRow,
} from "../lib/serializers";
import { profileMediaUrls } from "./media";

export async function getUserById(db: Db, id: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

export async function getUserByHandle(db: Db, handle: string): Promise<UserRow | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.handle, handle.toLowerCase()))
    .limit(1);
  return row ?? null;
}

export async function getProfile(db: Db, userId: string): Promise<ProfileRow | null> {
  const [row] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  return row ?? null;
}

export async function authorRefFor(db: Db, userId: string): Promise<AuthorRef | null> {
  const user = await getUserById(db, userId);
  if (!user) return null;
  const profile = await getProfile(db, userId);
  const urls = profile ? await profileMediaUrls(db, [profile]) : new Map<string, string>();
  return authorRef(user, profile, urls.get(`${userId}:avatar`) ?? null);
}

/** Batch-resolve author refs for a set of user ids (feed/thread rendering). */
export async function authorMap(
  db: Db,
  authorIds: string[],
): Promise<Map<string, AuthorRef>> {
  const map = new Map<string, AuthorRef>();
  const unique = [...new Set(authorIds)];
  if (unique.length === 0) return map;
  const userRows = await db.select().from(users).where(inArray(users.id, unique));
  const profileRows = await db
    .select()
    .from(profiles)
    .where(inArray(profiles.userId, unique));
  const profileByUser = new Map(profileRows.map((p) => [p.userId, p]));
  const urls = await profileMediaUrls(db, profileRows);
  for (const user of userRows) {
    map.set(
      user.id,
      authorRef(user, profileByUser.get(user.id) ?? null, urls.get(`${user.id}:avatar`) ?? null),
    );
  }
  return map;
}

/** Batch-resolve full Profile wires for a set of user ids (follower lists). */
export async function profileMap(
  db: Db,
  userIds: string[],
): Promise<Map<string, ProfileWire>> {
  const map = new Map<string, ProfileWire>();
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return map;
  const userRows = await db.select().from(users).where(inArray(users.id, unique));
  const profileRows = await db
    .select()
    .from(profiles)
    .where(inArray(profiles.userId, unique));
  const profileByUser = new Map(profileRows.map((p) => [p.userId, p]));
  const urls = await profileMediaUrls(db, profileRows);
  const records = await debateRecordMap(db, unique);
  for (const user of userRows) {
    map.set(
      user.id,
      profileWire(
        user,
        profileByUser.get(user.id) ?? null,
        {
          avatarUrl: urls.get(`${user.id}:avatar`) ?? null,
          bannerUrl: urls.get(`${user.id}:banner`) ?? null,
        },
        records.get(user.id) ?? null,
      ),
    );
  }
  return map;
}

/** Debate Elo + record per user (Phase 3: profiles carry real values). */
export async function debateRecordMap(
  db: Db,
  userIds: string[],
): Promise<Map<string, DebateRecordSummary>> {
  const map = new Map<string, DebateRecordSummary>();
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return map;
  const rows = await db
    .select()
    .from(debateRatings)
    .where(inArray(debateRatings.userId, unique));
  for (const row of rows) {
    map.set(row.userId, {
      rating: row.rating,
      wins: row.wins,
      losses: row.losses,
      draws: row.draws,
      debatesCount: row.debatesCount,
    });
  }
  return map;
}

/** Batch-resolve community refs for posts that live in communities. */
export async function communityMap(
  db: Db,
  communityIds: Array<string | null>,
): Promise<Map<string, CommunityRef>> {
  const map = new Map<string, CommunityRef>();
  const unique = [...new Set(communityIds.filter((id): id is string => id !== null))];
  if (unique.length === 0) return map;
  const rows = await db
    .select()
    .from(communities)
    .where(inArray(communities.id, unique));
  for (const row of rows) map.set(row.id, communityRef(row));
  return map;
}
