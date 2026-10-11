/**
 * Bookmark collections routes (API_SPEC /collections; Phase 5A completes
 * the CRUD over the Phase 1 tables — DATA_MODEL §5.7). Collections are
 * private named folders owned by the caller.
 */
import { and, asc, desc, eq, inArray, lt, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { bookmarks, collections, posts } from "../db/schema";
import { requireAuth } from "../lib/auth";
import { notFound, unprocessable } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { decodeCursor, encodeCursor } from "../lib/pagination";
import { pageEnvelope } from "../lib/serializers";
import { parseBody } from "../lib/validate";
import { hydratePosts } from "../services/posts";

type CollectionRow = typeof collections.$inferSelect;

function collectionWire(row: CollectionRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    is_public: row.isPublic,
    item_count: row.itemCount,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

const createSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(280).nullable().optional(),
  is_public: z.boolean().optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(280).nullable().optional(),
  is_public: z.boolean().optional(),
});

const pageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

async function loadOwned(ctx: AppContext, id: string, userId: string): Promise<CollectionRow> {
  const [row] = await ctx.db
    .select()
    .from(collections)
    .where(eq(collections.id, id))
    .limit(1);
  if (!row || row.ownerId !== userId) throw notFound("Collection not found");
  return row;
}

export async function registerCollectionRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db } = ctx;

  app.get(
    "/api/v1/collections",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const me = request.authUser!;
      const rows = await db
        .select()
        .from(collections)
        .where(eq(collections.ownerId, me.sub))
        .orderBy(asc(collections.name));
      return pageEnvelope(rows.map(collectionWire), null);
    },
  );

  app.post(
    "/api/v1/collections",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      const body = parseBody(createSchema, request.body);
      const name = body.name.trim();
      if (!name) throw unprocessable("name: must not be empty");
      const [row] = await db
        .insert(collections)
        .values({
          id: uuidv7(),
          ownerId: request.authUser!.sub,
          name,
          description: body.description?.trim() || null,
          isPublic: body.is_public ?? false,
        })
        .returning();
      return reply.status(201).send(collectionWire(row!));
    },
  );

  app.get(
    "/api/v1/collections/:collectionId",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const { collectionId } = request.params as { collectionId: string };
      const row = await loadOwned(ctx, collectionId, request.authUser!.sub);
      return collectionWire(row);
    },
  );

  app.patch(
    "/api/v1/collections/:collectionId",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const { collectionId } = request.params as { collectionId: string };
      const body = parseBody(patchSchema, request.body);
      const row = await loadOwned(ctx, collectionId, request.authUser!.sub);
      const patch: Partial<CollectionRow> = { updatedAt: new Date() };
      if (body.name !== undefined) {
        const name = body.name.trim();
        if (!name) throw unprocessable("name: must not be empty");
        patch.name = name;
      }
      if (body.description !== undefined) patch.description = body.description?.trim() || null;
      if (body.is_public !== undefined) patch.isPublic = body.is_public;
      const [updated] = await db
        .update(collections)
        .set(patch)
        .where(eq(collections.id, row.id))
        .returning();
      return collectionWire(updated!);
    },
  );

  app.delete(
    "/api/v1/collections/:collectionId",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      const { collectionId } = request.params as { collectionId: string };
      const row = await loadOwned(ctx, collectionId, request.authUser!.sub);
      // Bookmarks survive: the FK nulls their collection_id (DATA_MODEL §5.7).
      await db.delete(collections).where(eq(collections.id, row.id));
      return reply.status(204).send();
    },
  );

  app.get(
    "/api/v1/collections/:collectionId/posts",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const { collectionId } = request.params as { collectionId: string };
      const query = pageQuerySchema.parse(request.query ?? {});
      const me = request.authUser!;
      const row = await loadOwned(ctx, collectionId, me.sub);
      const cursor = decodeCursor<{ createdAt: string; postId: string }>(query.cursor);
      const bookmarkRows = await db
        .select()
        .from(bookmarks)
        .where(
          and(
            eq(bookmarks.userId, me.sub),
            eq(bookmarks.collectionId, row.id),
            cursor
              ? or(
                  lt(bookmarks.createdAt, new Date(cursor.createdAt)),
                  and(
                    eq(bookmarks.createdAt, new Date(cursor.createdAt)),
                    lt(bookmarks.postId, cursor.postId),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(bookmarks.createdAt), desc(bookmarks.postId))
        .limit(query.limit + 1);
      const sliced = bookmarkRows.slice(0, query.limit);
      const ids = sliced.map((b) => b.postId);
      const fetched =
        ids.length > 0
          ? await db.select().from(posts).where(inArray(posts.id, ids))
          : [];
      const byId = new Map(fetched.map((p) => [p.id, p]));
      const ordered = ids
        .map((id) => byId.get(id))
        .filter((p): p is NonNullable<typeof p> => Boolean(p) && !p!.deletedAt);
      const wires = await hydratePosts(db, ordered, me.sub);
      const last = sliced[sliced.length - 1];
      return pageEnvelope(
        wires,
        bookmarkRows.length > query.limit && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), postId: last.postId })
          : null,
      );
    },
  );
}
