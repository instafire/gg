/**
 * User lists (Phase 5A; DATA_MODEL §3.4, D-051). A list is a named set of
 * accounts owned by one user; its timeline is the members' posts. Public
 * lists are readable by anyone, private lists only by their owner.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db";
import { listMembers, lists, posts } from "../db/schema";
import { forbidden, notFound, unprocessable } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { decodeCursor, encodeCursor, type Page } from "../lib/pagination";
import { postPublishedCondition } from "./posts";
import { authorMap, getUserByHandle } from "./users";
import { hydratePosts } from "./posts";
import { hiddenAuthorIds } from "./visibility";
import type { AppContext } from "../context";
import type { AuthorRef, PostWire } from "../lib/serializers";

type ListRow = typeof lists.$inferSelect;

export interface ListWire {
  id: string;
  owner: AuthorRef;
  name: string;
  description: string | null;
  is_public: boolean;
  member_count: number;
  created_at: string;
}

export async function listWire(db: Db, row: ListRow): Promise<ListWire> {
  const authors = await authorMap(db, [row.ownerId]);
  return {
    id: row.id,
    owner: authors.get(row.ownerId)!,
    name: row.name,
    description: row.description,
    is_public: row.isPublic,
    member_count: row.memberCount,
    created_at: row.createdAt.toISOString(),
  };
}

export async function getListRow(db: Db, id: string): Promise<ListRow | null> {
  const [row] = await db.select().from(lists).where(eq(lists.id, id)).limit(1);
  return row ?? null;
}

/** Read gate: public lists for everyone; private lists owner-only. */
export function assertListReadable(row: ListRow, viewerId: string | null): void {
  if (!row.isPublic && row.ownerId !== viewerId) throw notFound("List not found");
}

export function assertListOwned(row: ListRow, userId: string): void {
  if (row.ownerId !== userId) throw forbidden("Only the list owner can change this list");
}

export async function createList(
  db: Db,
  ownerId: string,
  input: { name: string; description?: string | null; isPublic?: boolean },
): Promise<ListWire> {
  const name = input.name.trim();
  if (!name) throw unprocessable("name: must not be empty");
  const [row] = await db
    .insert(lists)
    .values({
      id: uuidv7(),
      ownerId,
      name,
      description: input.description?.trim() || null,
      isPublic: input.isPublic ?? false,
    })
    .returning();
  return listWire(db, row!);
}

export async function updateList(
  db: Db,
  row: ListRow,
  input: { name?: string; description?: string | null; isPublic?: boolean },
): Promise<ListWire> {
  const patch: Partial<ListRow> = { updatedAt: new Date() };
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw unprocessable("name: must not be empty");
    patch.name = name;
  }
  if (input.description !== undefined) patch.description = input.description?.trim() || null;
  if (input.isPublic !== undefined) patch.isPublic = input.isPublic;
  const [updated] = await db.update(lists).set(patch).where(eq(lists.id, row.id)).returning();
  return listWire(db, updated!);
}

export async function deleteList(db: Db, row: ListRow): Promise<void> {
  await db.delete(lists).where(eq(lists.id, row.id));
}

export async function listListsForOwner(
  db: Db,
  ownerHandle: string,
  viewerId: string | null,
): Promise<ListWire[]> {
  const owner = await getUserByHandle(db, ownerHandle.replace(/^@/, "").toLowerCase());
  if (!owner || owner.deletedAt) throw notFound(`User @${ownerHandle} not found`);
  const conditions = [eq(lists.ownerId, owner.id)];
  if (viewerId !== owner.id) conditions.push(eq(lists.isPublic, true));
  const rows = await db
    .select()
    .from(lists)
    .where(and(...conditions))
    .orderBy(desc(lists.createdAt));
  const wires: ListWire[] = [];
  for (const row of rows) wires.push(await listWire(db, row));
  return wires;
}

export async function discoverLists(db: Db, limit: number): Promise<ListWire[]> {
  const rows = await db
    .select()
    .from(lists)
    .where(eq(lists.isPublic, true))
    .orderBy(desc(lists.memberCount), desc(lists.createdAt))
    .limit(limit);
  const wires: ListWire[] = [];
  for (const row of rows) wires.push(await listWire(db, row));
  return wires;
}

export async function listMembersWire(
  db: Db,
  row: ListRow,
): Promise<{ data: AuthorRef[] }> {
  const members = await db
    .select()
    .from(listMembers)
    .where(eq(listMembers.listId, row.id))
    .orderBy(desc(listMembers.createdAt));
  const authors = await authorMap(db, members.map((m) => m.userId));
  return {
    data: members
      .map((m) => authors.get(m.userId))
      .filter((a): a is AuthorRef => Boolean(a)),
  };
}

export async function addListMember(
  db: Db,
  row: ListRow,
  actorId: string,
  handle: string,
): Promise<ListWire> {
  const user = await getUserByHandle(db, handle.replace(/^@/, "").toLowerCase());
  if (!user || user.deletedAt) throw notFound(`User @${handle} not found`);
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(listMembers)
      .values({ listId: row.id, userId: user.id, addedBy: actorId })
      .onConflictDoNothing()
      .returning();
    if (inserted.length > 0) {
      await tx
        .update(lists)
        .set({ memberCount: sql`${lists.memberCount} + 1`, updatedAt: new Date() })
        .where(eq(lists.id, row.id));
    }
  });
  const [fresh] = await db.select().from(lists).where(eq(lists.id, row.id)).limit(1);
  return listWire(db, fresh!);
}

export async function removeListMember(
  db: Db,
  row: ListRow,
  handle: string,
): Promise<ListWire> {
  const user = await getUserByHandle(db, handle.replace(/^@/, "").toLowerCase());
  if (!user) throw notFound(`User @${handle} not found`);
  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(listMembers)
      .where(and(eq(listMembers.listId, row.id), eq(listMembers.userId, user.id)))
      .returning();
    if (deleted.length > 0) {
      await tx
        .update(lists)
        .set({ memberCount: sql`${lists.memberCount} - 1`, updatedAt: new Date() })
        .where(eq(lists.id, row.id));
    }
  });
  const [fresh] = await db.select().from(lists).where(eq(lists.id, row.id)).limit(1);
  return listWire(db, fresh!);
}

/** Timeline: published posts by list members, newest first (keyset). */
export async function listTimeline(
  ctx: AppContext,
  row: ListRow,
  viewerId: string | null,
  cursor: string | undefined,
  limit: number,
): Promise<Page<PostWire>> {
  const { db } = ctx;
  const members = await db
    .select({ userId: listMembers.userId })
    .from(listMembers)
    .where(eq(listMembers.listId, row.id));
  if (members.length === 0) return { items: [], nextCursor: null };
  const memberIds = members.map((m) => m.userId);
  const hidden = viewerId ? await hiddenAuthorIds(ctx, viewerId) : [];
  const visibleMemberIds = memberIds.filter((id) => !hidden.includes(id));
  if (visibleMemberIds.length === 0) return { items: [], nextCursor: null };

  const decoded = decodeCursor<{ k: string; id: string }>(cursor);
  const conditions = [
    inArray(posts.authorId, visibleMemberIds),
    sql`${posts.deletedAt} is null`,
    sql`${posts.parentId} is null`,
    postPublishedCondition(viewerId),
  ];
  if (decoded) {
    conditions.push(
      sql`(${posts.createdAt}, ${posts.id}) < (${decoded.k}::timestamptz, ${decoded.id}::uuid)`,
    );
  }
  const rows = await db
    .select()
    .from(posts)
    .where(and(...conditions))
    .orderBy(desc(posts.createdAt), desc(posts.id))
    .limit(limit + 1);
  const pageRows = rows.slice(0, limit);
  const items = await hydratePosts(db, pageRows, viewerId);
  const last = pageRows[pageRows.length - 1];
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ k: last.createdAt.toISOString(), id: last.id })
        : null,
  };
}
