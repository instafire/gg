/**
 * Platform analytics (Phase 5B, API_SPEC getAdminAnalytics): aggregate
 * product metrics for platform admins only (users.platform_role = admin).
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { users } from "../db/schema";
import { requireAuth } from "../lib/auth";
import { forbidden } from "../lib/errors";
import { parseBody } from "../lib/validate";
import { computeAnalytics } from "../services/analytics";

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

export async function registerAdminAnalyticsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db } = ctx;

  app.get(
    "/api/v1/admin/analytics",
    { preHandler: requireAuth(ctx) },
    async (request) => {
      const me = request.authUser!;
      const [meRow] = await db
        .select({ platformRole: users.platformRole })
        .from(users)
        .where(eq(users.id, me.sub))
        .limit(1);
      if (meRow?.platformRole !== "admin") {
        throw forbidden("Platform admins only");
      }
      const query = parseBody(querySchema, request.query);
      return computeAnalytics(db, query.days);
    },
  );
}
