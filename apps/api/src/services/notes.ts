/**
 * Context notes (DATA_MODEL §9, Phase 3) with the simplified bridging rule
 * from D-033: a rater's viewpoint cluster is the sign of their average
 * recorded stance (stance_votes + poll slider ballots); a note becomes
 * `helpful` — publicly shown — with ≥3 helpful ratings from EACH side
 * cluster (+1 and −1). Recomputed synchronously on every rating.
 */
import { avg, eq, sql } from "drizzle-orm";
import type { Db } from "../db";
import {
  contextNoteRatings,
  contextNotes,
  pollVotes,
  posts,
  stanceVotes,
  users,
} from "../db/schema";
import { forbidden, notFound, unprocessable } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { effectiveTrustTier } from "../lib/trust-tier";
import { contextNoteWire, type ContextNoteWire } from "../lib/serializers";
import { authorMap } from "./users";
import type { AuthorRef } from "./posts";

type NoteRow = typeof contextNotes.$inferSelect;

export const NOTE_HELPFUL_PER_SIDE = 3;
export const NOTE_RATINGS_FOR_VERDICT = 5;

/** Viewpoint cluster of a user from their recorded stances (D-033). */
export async function viewpointClusterOf(db: Db, userId: string): Promise<-1 | 0 | 1> {
  const [stance] = await db
    .select({ mean: avg(stanceVotes.stanceValue) })
    .from(stanceVotes)
    .where(eq(stanceVotes.voterId, userId));
  const [slider] = await db
    .select({ mean: avg(pollVotes.sliderValue) })
    .from(pollVotes)
    .where(eq(pollVotes.voterId, userId));
  const values: number[] = [];
  if (stance?.mean !== null && stance?.mean !== undefined) values.push(Number(stance.mean));
  if (slider?.mean !== null && slider?.mean !== undefined) values.push(Number(slider.mean));
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean >= 0.5) return 1;
  if (mean <= -0.5) return -1;
  return 0;
}

export function statusForCounts(counts: {
  helpfulPos: number;
  helpfulNeg: number;
  total: number;
  notHelpful: number;
}): NoteRow["status"] {
  if (counts.helpfulPos >= NOTE_HELPFUL_PER_SIDE && counts.helpfulNeg >= NOTE_HELPFUL_PER_SIDE) {
    return "helpful";
  }
  if (counts.total >= NOTE_RATINGS_FOR_VERDICT && counts.notHelpful * 2 > counts.total) {
    return "not_helpful";
  }
  if (counts.total >= NOTE_RATINGS_FOR_VERDICT) return "needs_more_ratings";
  return "pending";
}

async function recomputeNoteStatus(db: Db, noteId: string): Promise<NoteRow> {
  const ratings = await db
    .select()
    .from(contextNoteRatings)
    .where(eq(contextNoteRatings.noteId, noteId));
  const counts = {
    helpfulPos: ratings.filter((r) => r.rating === "helpful" && r.raterViewpointCluster === 1).length,
    helpfulNeg: ratings.filter((r) => r.rating === "helpful" && r.raterViewpointCluster === -1).length,
    total: ratings.length,
    notHelpful: ratings.filter((r) => r.rating === "not_helpful").length,
  };
  const [updated] = await db
    .update(contextNotes)
    .set({
      status: statusForCounts(counts),
      helpfulFromPos: counts.helpfulPos,
      helpfulFromNeg: counts.helpfulNeg,
      ratingCount: counts.total,
      updatedAt: new Date(),
    })
    .where(eq(contextNotes.id, noteId))
    .returning();
  return updated!;
}

export async function createNote(
  db: Db,
  author: AuthorRef,
  postId: string,
  input: { body: string; sources: string[] },
): Promise<NoteRow> {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post || post.deletedAt) throw notFound("Post not found");
  const [authorRow] = await db.select().from(users).where(eq(users.id, author.id)).limit(1);
  // Spec: proposing a note requires trust tier T1+.
  // D-045: an agent's effective tier is its owner's current tier.
  if (!authorRow || (await effectiveTrustTier(db, authorRow)) === "T0") {
    throw forbidden("Context notes require trust tier T1 or higher");
  }
  if (input.body.trim().length === 0 || input.body.length > 500) {
    throw unprocessable("Notes must be 1–500 characters");
  }
  for (const source of input.sources) {
    try {
      const url = new URL(source);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
      throw unprocessable(`Source is not a valid URL: ${source}`);
    }
  }
  const [note] = await db
    .insert(contextNotes)
    .values({
      id: uuidv7(),
      postId,
      authorId: author.id,
      authorType: author.authorType,
      body: input.body.trim(),
      sources: input.sources,
    })
    .returning();
  return note!;
}

export async function listNotesForPost(
  db: Db,
  postId: string,
  viewer: { id: string; platformRole: string } | null,
): Promise<ContextNoteWire[]> {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post || post.deletedAt) throw notFound("Post not found");
  const rows = await db
    .select()
    .from(contextNotes)
    .where(eq(contextNotes.postId, postId))
    .orderBy(sql`${contextNotes.createdAt} desc`);
  // Public sees only `helpful` notes; the note author, the post author and
  // platform moderators see everything (API_SPEC listNotes).
  const privileged =
    viewer !== null &&
    (viewer.platformRole === "moderator" ||
      viewer.platformRole === "admin" ||
      viewer.id === post.authorId);
  const visible = rows.filter(
    (row) => row.status === "helpful" || privileged || (viewer !== null && row.authorId === viewer.id),
  );
  const authors = await authorMap(db, visible.map((r) => r.authorId));
  return visible.map((row) => contextNoteWire(row, authors.get(row.authorId)!));
}

export async function rateNote(
  db: Db,
  rater: AuthorRef,
  noteId: string,
  rating: "helpful" | "somewhat" | "not_helpful",
): Promise<NoteRow> {
  const [note] = await db
    .select()
    .from(contextNotes)
    .where(eq(contextNotes.id, noteId))
    .limit(1);
  if (!note) throw notFound("Note not found");
  if (note.authorId === rater.id) {
    throw forbidden("You cannot rate your own note");
  }
  const [raterRow] = await db.select().from(users).where(eq(users.id, rater.id)).limit(1);
  // D-045: an agent's effective tier is its owner's current tier.
  if (!raterRow || (await effectiveTrustTier(db, raterRow)) === "T0") {
    throw forbidden("Rating notes requires trust tier T1 or higher");
  }
  const cluster = await viewpointClusterOf(db, rater.id);
  await db
    .insert(contextNoteRatings)
    .values({ noteId, raterId: rater.id, rating, raterViewpointCluster: cluster })
    .onConflictDoUpdate({
      target: [contextNoteRatings.noteId, contextNoteRatings.raterId],
      set: { rating, raterViewpointCluster: cluster },
    });
  return recomputeNoteStatus(db, noteId);
}

export async function getNoteById(db: Db, noteId: string): Promise<NoteRow | null> {
  const [row] = await db
    .select()
    .from(contextNotes)
    .where(eq(contextNotes.id, noteId))
    .limit(1);
  return row ?? null;
}

export async function noteWires(db: Db, rows: NoteRow[]): Promise<ContextNoteWire[]> {
  if (rows.length === 0) return [];
  const authors = await authorMap(db, rows.map((r) => r.authorId));
  return rows.map((row) => contextNoteWire(row, authors.get(row.authorId)!));
}
