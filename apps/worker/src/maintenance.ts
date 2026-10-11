/**
 * Worker maintenance jobs (hardening). Today: agent audit-log pruning
 * (D-044 retention, SECURITY §9.3 — 24 months).
 *
 * Scope decision (D-071): the pruned set is exactly the per-agent audit
 * trail's row set — rows whose actor OR target is an agent account, plus
 * any row recorded with a credential auth method (api_key/oauth). Human
 * platform-moderation audit rows (poll voids etc. by admins via session)
 * are NOT pruned by this job.
 */
import { and, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import type { WorkerDb } from "./db";
import { auditLogsTable, usersTable } from "./db";

export const MAINTENANCE_QUEUE_NAME = "gg-maintenance";
export const AUDIT_PRUNE_JOB = "audit.prune";

/** Retention for agent-action audit logs (SECURITY §9.3). */
export const AUDIT_LOG_RETENTION_MONTHS = 24;

const DELETE_BATCH = 5000;

export interface AuditPruneRepo {
  /** Ids of agent accounts (for actor/target matching). */
  agentUserIds(): Promise<string[]>;
  /** Count rows matching the prune predicate older than `cutoff`. */
  countPrunable(cutoff: Date, agentIds: string[]): Promise<number>;
  /** Delete up to `limit` matching rows; returns how many were deleted. */
  deletePrunableBatch(
    cutoff: Date,
    agentIds: string[],
    limit: number,
  ): Promise<number>;
}

export function drizzleAuditPruneRepo(db: WorkerDb): AuditPruneRepo {
  const predicate = (cutoff: Date, agentIds: string[]) =>
    and(
      lt(auditLogsTable.createdAt, cutoff),
      or(
        isNotNull(auditLogsTable.authMethod),
        agentIds.length > 0
          ? inArray(auditLogsTable.actorId, agentIds)
          : undefined,
        agentIds.length > 0
          ? inArray(auditLogsTable.targetId, agentIds)
          : undefined,
      ),
    );
  return {
    async agentUserIds() {
      const rows = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(sql`${usersTable.authorType} = 'agent'`);
      return rows.map((r) => r.id);
    },
    async countPrunable(cutoff, agentIds) {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(auditLogsTable)
        .where(predicate(cutoff, agentIds));
      return row?.n ?? 0;
    },
    async deletePrunableBatch(cutoff, agentIds, limit) {
      const ids = await db
        .select({ id: auditLogsTable.id })
        .from(auditLogsTable)
        .where(predicate(cutoff, agentIds))
        .limit(limit);
      if (ids.length === 0) return 0;
      const deleted = await db
        .delete(auditLogsTable)
        .where(
          inArray(
            auditLogsTable.id,
            ids.map((r) => r.id),
          ),
        )
        .returning({ id: auditLogsTable.id });
      return deleted.length;
    },
  };
}

export interface AuditPruneOptions {
  /** Months of history to keep. Default AUDIT_LOG_RETENTION_MONTHS. */
  retentionMonths?: number;
  /** When true, count + report but delete nothing. */
  dryRun?: boolean;
  now?: Date;
  log?: (message: string) => void;
}

export interface AuditPruneResult {
  cutoff: Date;
  matched: number;
  deleted: number;
  dryRun: boolean;
}

/** Subtract calendar months (clamped to the target month's last day). */
export function monthsAgo(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const lastDay = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

export async function pruneAgentAuditLogs(
  repo: AuditPruneRepo,
  options: AuditPruneOptions = {},
): Promise<AuditPruneResult> {
  const retentionMonths =
    options.retentionMonths ?? AUDIT_LOG_RETENTION_MONTHS;
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? new Date();
  const log = options.log ?? ((m: string) => console.log(m));
  const cutoff = monthsAgo(now, retentionMonths);
  const agentIds = await repo.agentUserIds();
  const matched = await repo.countPrunable(cutoff, agentIds);
  let deleted = 0;
  if (!dryRun && matched > 0) {
    // Batched deletes keep each statement short-locked.
    for (;;) {
      const n = await repo.deletePrunableBatch(cutoff, agentIds, DELETE_BATCH);
      deleted += n;
      if (n < DELETE_BATCH) break;
    }
  }
  log(
    `[gg-worker] [maintenance] audit prune ${dryRun ? "(dry-run) " : ""}` +
      `cutoff=${cutoff.toISOString()} matched=${matched} deleted=${deleted}`,
  );
  return { cutoff, matched, deleted, dryRun };
}

/** Env knobs for the scheduled prune job. */
export function auditPruneOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AuditPruneOptions {
  const months = Number.parseInt(env.AUDIT_PRUNE_RETENTION_MONTHS ?? "", 10);
  return {
    retentionMonths:
      Number.isFinite(months) && months > 0
        ? months
        : AUDIT_LOG_RETENTION_MONTHS,
    dryRun: env.AUDIT_PRUNE_DRY_RUN === "true",
  };
}
