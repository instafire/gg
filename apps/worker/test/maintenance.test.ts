/**
 * Hardening (D-071) — agent audit-log pruning.
 *
 * Unit: pruneAgentAuditLogs against an in-memory repo implementing the
 * D-071 predicate (rows older than the cutoff whose auth_method is set,
 * or whose actor/target is an agent account).
 * DB integration (TEST_DATABASE_URL, gg_test): drizzleAuditPruneRepo
 * against real backdated audit_logs rows.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createWorkerDb } from "../src/db";
import {
  AUDIT_LOG_RETENTION_MONTHS,
  drizzleAuditPruneRepo,
  monthsAgo,
  pruneAgentAuditLogs,
  type AuditPruneRepo,
} from "../src/maintenance";

interface FakeRow {
  id: string;
  createdAt: Date;
  actorId: string | null;
  targetId: string;
  authMethod: string | null;
}

const AGENT = "agent-1";

class FakeRepo implements AuditPruneRepo {
  rows: FakeRow[];
  constructor(rows: FakeRow[]) {
    this.rows = [...rows];
  }
  async agentUserIds(): Promise<string[]> {
    return [AGENT];
  }
  private prunable(cutoff: Date, agentIds: string[]): FakeRow[] {
    return this.rows.filter(
      (r) =>
        r.createdAt < cutoff &&
        (r.authMethod !== null ||
          (r.actorId !== null && agentIds.includes(r.actorId)) ||
          agentIds.includes(r.targetId)),
    );
  }
  async countPrunable(cutoff: Date, agentIds: string[]): Promise<number> {
    return this.prunable(cutoff, agentIds).length;
  }
  async deletePrunableBatch(cutoff: Date, agentIds: string[], limit: number): Promise<number> {
    const doomed = this.prunable(cutoff, agentIds).slice(0, limit);
    this.rows = this.rows.filter((r) => !doomed.includes(r));
    return doomed.length;
  }
}

const NOW = new Date("2026-10-11T12:00:00Z");

function row(monthsBack: number, partial: Partial<FakeRow> = {}): FakeRow {
  return {
    id: randomUUID(),
    createdAt: monthsAgo(NOW, monthsBack),
    actorId: AGENT,
    targetId: "post-1",
    authMethod: "api_key",
    ...partial,
  };
}

describe("pruneAgentAuditLogs", () => {
  it("deletes agent rows older than 24 months, keeps everything else", async () => {
    const repo = new FakeRepo([
      row(25), // agent + api_key, old → pruned
      row(30, { authMethod: null, actorId: "human-1", targetId: AGENT }), // target is agent, old → pruned
      row(6), // agent but recent → kept
      row(30, { authMethod: null, actorId: "human-1", targetId: "post-9" }), // old, human session → kept
    ]);
    const result = await pruneAgentAuditLogs(repo, { now: NOW, log: () => {} });
    expect(result.deleted).toBe(2);
    expect(result.matched).toBe(2);
    expect(repo.rows).toHaveLength(2);
    expect(result.cutoff.toISOString()).toBe(monthsAgo(NOW, AUDIT_LOG_RETENTION_MONTHS).toISOString());
  });

  it("dry-run counts without deleting", async () => {
    const repo = new FakeRepo([row(25), row(26), row(1)]);
    const result = await pruneAgentAuditLogs(repo, { now: NOW, dryRun: true, log: () => {} });
    expect(result).toMatchObject({ matched: 2, deleted: 0, dryRun: true });
    expect(repo.rows).toHaveLength(3);
  });

  it("honors a custom retention window", async () => {
    const repo = new FakeRepo([row(13), row(11)]);
    const result = await pruneAgentAuditLogs(repo, {
      now: NOW,
      retentionMonths: 12,
      log: () => {},
    });
    expect(result.deleted).toBe(1);
    expect(repo.rows).toHaveLength(1);
  });

  it("monthsAgo subtracts calendar months with day clamping", () => {
    expect(monthsAgo(new Date("2026-10-11T00:00:00Z"), 24).toISOString()).toBe(
      "2024-10-11T00:00:00.000Z",
    );
    expect(monthsAgo(new Date("2026-03-31T00:00:00Z"), 1).toISOString()).toBe(
      "2026-02-28T00:00:00.000Z",
    );
  });
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("audit pruning (DB integration)", () => {
  const { db, client } = createWorkerDb(TEST_DATABASE_URL!);
  const suffix = Math.random().toString(36).slice(2, 10);
  const ownerId = randomUUID();
  const agentId = randomUUID();
  const humanId = randomUUID();
  const oldAgentLog = randomUUID();
  const recentAgentLog = randomUUID();
  const oldHumanLog = randomUUID();

  afterAll(async () => {
    await db.execute(sql`delete from audit_logs where id in (${oldAgentLog}, ${recentAgentLog}, ${oldHumanLog})`);
    await db.execute(sql`delete from users where id in (${agentId}, ${humanId}, ${ownerId})`);
    await client.end();
  });

  it("prunes only backdated agent-trail rows from the real table", async () => {
    await db.execute(sql`
      insert into users (id, handle, author_type, status, trust_tier)
      values (${ownerId}, ${`prune_owner_${suffix}`}, 'human', 'active', 'T0'),
             (${humanId}, ${`prune_human_${suffix}`}, 'human', 'active', 'T0')`);
    await db.execute(sql`
      insert into users (id, handle, author_type, status, trust_tier, owner_id)
      values (${agentId}, ${`prune_agent_${suffix}`}, 'agent', 'active', 'T0', ${ownerId})`);
    const old = monthsAgo(new Date(), 25).toISOString();
    // Agent trail (api_key auth), old → pruned.
    await db.execute(sql`
      insert into audit_logs (id, actor_id, action, target_type, target_id, auth_method, created_at)
      values (${oldAgentLog}, ${agentId}, 'post.create', 'post', ${humanId}, 'api_key', ${old})`);
    // Agent trail but recent → kept.
    await db.execute(sql`
      insert into audit_logs (id, actor_id, action, target_type, target_id, auth_method, created_at)
      values (${recentAgentLog}, ${agentId}, 'post.create', 'post', ${humanId}, 'api_key', now())`);
    // Old but purely human (session auth, human actor/target) → kept.
    await db.execute(sql`
      insert into audit_logs (id, actor_id, action, target_type, target_id, auth_method, created_at)
      values (${oldHumanLog}, ${humanId}, 'post.create', 'post', ${humanId}, null, ${old})`);

    const repo = drizzleAuditPruneRepo(db);
    const result = await pruneAgentAuditLogs(repo, { log: () => {} });
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    const remaining = (await db.execute(sql`
      select id from audit_logs where id in (${oldAgentLog}, ${recentAgentLog}, ${oldHumanLog})`)) as unknown as { rows?: { id: string }[] } | { id: string }[];
    const rows = (Array.isArray(remaining) ? remaining : (remaining.rows ?? [])) as { id: string }[];
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(oldAgentLog);
    expect(ids).toContain(recentAgentLog);
    expect(ids).toContain(oldHumanLog);
  });
});
