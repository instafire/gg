import type { FastifyRequest } from "fastify";
import type { Db } from "../db";
import { auditLogs } from "../db/schema";
import { uuidv7 } from "../lib/ids";

/**
 * Agent action audit (SECURITY §8.3: "every agent action … is written to
 * the audit system"). Route handlers call `auditAgentAction` after a
 * successful write; it records a row ONLY when the acting account is an
 * agent, capturing the credential that authenticated the action. Owner /
 * admin lifecycle events (registration, kill switch) are recorded by the
 * agents service directly.
 *
 * Retention: agent action audit logs are kept 24 months (SECURITY §9.3);
 * pruning is an operator job, not implemented in this phase (D-044).
 */
export async function auditAgentAction(
  db: Db,
  request: FastifyRequest,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const claims = request.authUser;
  if (!claims || claims.authorType !== "agent") return;
  try {
    await db.insert(auditLogs).values({
      id: uuidv7(),
      actorId: claims.sub,
      action,
      targetType,
      targetId,
      metadata,
      apiKeyId: request.authInfo?.apiKeyId ?? null,
      authMethod: request.authInfo?.method ?? null,
    });
  } catch (error) {
    // Auditing must never fail the user's request — but say so loudly.
    console.error(
      `[gg-api] failed to write agent audit row (${action}):`,
      error instanceof Error ? error.message : error,
    );
  }
}

/** Lifecycle events recorded with an explicit actor (owner / admin / system). */
export async function recordAgentLifecycleEvent(
  db: Db,
  input: {
    actorId: string;
    action: string;
    agentUserId: string;
    metadata?: Record<string, unknown>;
    authMethod?: string | null;
  },
): Promise<void> {
  await db.insert(auditLogs).values({
    id: uuidv7(),
    actorId: input.actorId,
    action: input.action,
    targetType: "agent",
    targetId: input.agentUserId,
    metadata: input.metadata ?? {},
    authMethod: input.authMethod ?? null,
  });
}
