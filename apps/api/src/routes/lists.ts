/**
 * Lists routes (Phase 5A, D-051 — spec delta; DATA_MODEL §3.4).
 * CRUD + members + timeline + discovery + per-user listing.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { optionalAuth, requireAuth } from "../lib/auth";
import { notFound } from "../lib/errors";
import { pageEnvelope } from "../lib/serializers";
import { parseBody } from "../lib/validate";
import {
  addListMember,
  assertListOwned,
  assertListReadable,
  createList,
  deleteList,
  discoverLists,
  getListRow,
  listListsForOwner,
  listMembersWire,
  listTimeline,
  listWire,
  removeListMember,
  updateList,
} from "../services/lists";

const listBodySchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(280).nullable().optional(),
  is_public: z.boolean().optional(),
  isPublic: z.boolean().optional(),
});

const listPatchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(280).nullable().optional(),
  is_public: z.boolean().optional(),
  isPublic: z.boolean().optional(),
});

const memberSchema = z.object({ handle: z.string().min(1).max(30) });
const pageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export async function registerListRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.post(
    "/api/v1/lists",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      const body = parseBody(listBodySchema, request.body);
      const wire = await createList(ctx.db, request.authUser!.sub, {
        name: body.name,
        description: body.description ?? null,
        isPublic: body.is_public ?? body.isPublic ?? false,
      });
      return reply.status(201).send(wire);
    },
  );

  app.get(
    "/api/v1/lists/discover",
    { preHandler: optionalAuth(ctx) },
    async () => {
      const wires = await discoverLists(ctx.db, 30);
      return pageEnvelope(wires, null);
    },
  );

  app.get(
    "/api/v1/users/:handle/lists",
    { preHandler: optionalAuth(ctx) },
    async (request) => {
      const { handle } = request.params as { handle: string };
      const wires = await listListsForOwner(
        ctx.db,
        handle,
        request.authUser?.sub ?? null,
      );
      return pageEnvelope(wires, null);
    },
  );

  app.get(
    "/api/v1/lists/:listId",
    { preHandler: optionalAuth(ctx) },
    async (request) => {
      const { listId } = request.params as { listId: string };
      const row = await getListRow(ctx.db, listId);
      if (!row) throw notFound("List not found");
      assertListReadable(row, request.authUser?.sub ?? null);
      return listWire(ctx.db, row);
    },
  );

  app.patch(
    "/api/v1/lists/:listId",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const { listId } = request.params as { listId: string };
      const body = parseBody(listPatchSchema, request.body);
      const row = await getListRow(ctx.db, listId);
      if (!row) throw notFound("List not found");
      assertListOwned(row, request.authUser!.sub);
      return updateList(ctx.db, row, {
        name: body.name,
        description: body.description,
        isPublic: body.is_public ?? body.isPublic,
      });
    },
  );

  app.delete(
    "/api/v1/lists/:listId",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      const { listId } = request.params as { listId: string };
      const row = await getListRow(ctx.db, listId);
      if (!row) throw notFound("List not found");
      assertListOwned(row, request.authUser!.sub);
      await deleteList(ctx.db, row);
      return reply.status(204).send();
    },
  );

  app.get(
    "/api/v1/lists/:listId/members",
    { preHandler: optionalAuth(ctx) },
    async (request) => {
      const { listId } = request.params as { listId: string };
      const row = await getListRow(ctx.db, listId);
      if (!row) throw notFound("List not found");
      assertListReadable(row, request.authUser?.sub ?? null);
      return listMembersWire(ctx.db, row);
    },
  );

  app.post(
    "/api/v1/lists/:listId/members",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const { listId } = request.params as { listId: string };
      const body = parseBody(memberSchema, request.body);
      const row = await getListRow(ctx.db, listId);
      if (!row) throw notFound("List not found");
      assertListOwned(row, request.authUser!.sub);
      return addListMember(ctx.db, row, request.authUser!.sub, body.handle);
    },
  );

  app.delete(
    "/api/v1/lists/:listId/members/:handle",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      const { listId, handle } = request.params as { listId: string; handle: string };
      const row = await getListRow(ctx.db, listId);
      if (!row) throw notFound("List not found");
      assertListOwned(row, request.authUser!.sub);
      await removeListMember(ctx.db, row, handle);
      return reply.status(204).send();
    },
  );

  app.get(
    "/api/v1/lists/:listId/timeline",
    { preHandler: optionalAuth(ctx) },
    async (request) => {
      const { listId } = request.params as { listId: string };
      const query = pageQuerySchema.parse(request.query ?? {});
      const row = await getListRow(ctx.db, listId);
      if (!row) throw notFound("List not found");
      assertListReadable(row, request.authUser?.sub ?? null);
      const page = await listTimeline(
        ctx,
        row,
        request.authUser?.sub ?? null,
        query.cursor,
        query.limit,
      );
      return pageEnvelope(page.items, page.nextCursor);
    },
  );
}
