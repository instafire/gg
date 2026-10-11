/**
 * Media service helpers (Phase 2): batch hydration for post serializers,
 * avatar/banner URL resolution, and single-row lookups shared by routes.
 */
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { media, postMedia } from "../db/schema";
import {
  mediaVariantUrl,
  mediaWire,
  type MediaObjectWire,
  type MediaRow,
  type ProfileRow,
} from "../lib/serializers";

export async function getMediaById(db: Db, id: string): Promise<MediaRow | null> {
  const [row] = await db.select().from(media).where(eq(media.id, id)).limit(1);
  return row ?? null;
}

/** Batch-fetch media rows by id (only rows that exist are returned). */
export async function mediaByIds(db: Db, ids: string[]): Promise<Map<string, MediaRow>> {
  const map = new Map<string, MediaRow>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return map;
  const rows = await db.select().from(media).where(inArray(media.id, unique));
  for (const row of rows) map.set(row.id, row);
  return map;
}

/**
 * Media wires attached to a set of posts (position-ordered). Only `ready`
 * media is ever exposed on posts; in-flight/blocked attachments are hidden.
 */
export async function mediaForPosts(
  db: Db,
  postIds: string[],
): Promise<Map<string, MediaObjectWire[]>> {
  const map = new Map<string, MediaObjectWire[]>();
  if (postIds.length === 0) return map;
  const links = await db
    .select()
    .from(postMedia)
    .where(inArray(postMedia.postId, postIds));
  if (links.length === 0) return map;
  const rowsById = await mediaByIds(
    db,
    links.map((l) => l.mediaId),
  );
  const sorted = [...links].sort((a, b) => a.position - b.position);
  for (const link of sorted) {
    const row = rowsById.get(link.mediaId);
    if (!row || row.status !== "ready") continue;
    const list = map.get(link.postId) ?? [];
    list.push(mediaWire(row));
    map.set(link.postId, list);
  }
  return map;
}

/**
 * Resolve profile avatar/banner media ids to public thumb URLs (ready
 * media only) — keyed `${userId}:avatar` / `${userId}:banner`.
 */
export async function profileMediaUrls(
  db: Db,
  profileRows: ProfileRow[],
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  const ids = profileRows.flatMap((p) =>
    [p.avatarMediaId, p.bannerMediaId].filter((id): id is string => id !== null),
  );
  if (ids.length === 0) return urls;
  const rowsById = await mediaByIds(db, ids);
  for (const profile of profileRows) {
    const avatar = profile.avatarMediaId ? rowsById.get(profile.avatarMediaId) : null;
    if (avatar && avatar.status === "ready") {
      urls.set(`${profile.userId}:avatar`, mediaVariantUrl(avatar.id, "thumb"));
    }
    const banner = profile.bannerMediaId ? rowsById.get(profile.bannerMediaId) : null;
    if (banner && banner.status === "ready") {
      urls.set(`${profile.userId}:banner`, mediaVariantUrl(banner.id, "medium"));
    }
  }
  return urls;
}
