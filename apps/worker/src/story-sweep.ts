/**
 * Story sweep (queue `gg-stories`, job `story.sweep`): stories hard-expire
 * 24 h after creation (enforced in API queries); frames that expired more
 * than 7 days ago are purged here — story row and views deleted, the
 * backing post tombstoned, and the media files removed when no other
 * story or post still references that media (DATA_MODEL §7).
 */
import { count, eq, lt } from "drizzle-orm";
import type { FileStore } from "@gg/media";
import {
  mediaTable,
  postMediaTable,
  postsTable,
  storiesTable,
  type WorkerDb,
} from "./db";
import { deleteMediaFiles } from "./media-job";

export const STORY_PURGE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PurgeableStory {
  postId: string;
  mediaId: string;
  mediaStorageKey: string;
}

export interface StorySweepRepo {
  listPurgeable(cutoff: Date): Promise<PurgeableStory[]>;
  mediaReferenceCount(mediaId: string, exceptPostId: string): Promise<number>;
  purgeStory(postId: string, mediaId: string): Promise<void>;
  deleteMediaRow(mediaId: string): Promise<void>;
}

export function drizzleStorySweepRepo(db: WorkerDb): StorySweepRepo {
  return {
    async listPurgeable(cutoff) {
      const rows = await db
        .select({
          postId: storiesTable.postId,
          mediaId: storiesTable.mediaId,
          mediaStorageKey: mediaTable.storageKey,
        })
        .from(storiesTable)
        .innerJoin(mediaTable, eq(mediaTable.id, storiesTable.mediaId))
        .where(lt(storiesTable.expiresAt, cutoff));
      return rows;
    },
    async mediaReferenceCount(mediaId) {
      const [fromPosts] = await db
        .select({ value: count() })
        .from(postMediaTable)
        .where(eq(postMediaTable.mediaId, mediaId));
      const [fromStories] = await db
        .select({ value: count() })
        .from(storiesTable)
        .where(eq(storiesTable.mediaId, mediaId));
      // Subtract the story currently being purged.
      const storyRefs = Math.max(0, (fromStories?.value ?? 0) - 1);
      return (fromPosts?.value ?? 0) + storyRefs;
    },
    async purgeStory(postId) {
      // story_views rows cascade with the story row.
      await db.delete(storiesTable).where(eq(storiesTable.postId, postId));
      await db
        .update(postsTable)
        .set({ deletedAt: new Date() })
        .where(eq(postsTable.id, postId));
    },
    async deleteMediaRow(mediaId) {
      await db.delete(mediaTable).where(eq(mediaTable.id, mediaId));
    },
  };
}

export async function purgeExpiredStories(
  repo: StorySweepRepo,
  store: FileStore,
  now = new Date(),
): Promise<{ purged: number; mediaDeleted: number }> {
  const cutoff = new Date(now.getTime() - STORY_PURGE_GRACE_MS);
  const candidates = await repo.listPurgeable(cutoff);
  let mediaDeleted = 0;
  for (const candidate of candidates) {
    const refs = await repo.mediaReferenceCount(
      candidate.mediaId,
      candidate.postId,
    );
    await repo.purgeStory(candidate.postId, candidate.mediaId);
    if (refs === 0) {
      await deleteMediaFiles(store, candidate.mediaId, candidate.mediaStorageKey);
      await repo.deleteMediaRow(candidate.mediaId);
      mediaDeleted += 1;
    }
  }
  return { purged: candidates.length, mediaDeleted };
}
