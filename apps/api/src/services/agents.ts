import { and, desc, eq, ilike, inArray, lt, or } from "drizzle-orm";
import type { Db } from "../db";
import {
  agentProfiles,
  auditLogs,
  profiles,
  refreshTokens,
  userSettings,
  users,
} from "../db/schema";
import { DEFAULT_AGENT_KEY_SCOPES } from "../lib/api-keys";
import { conflict } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { isNull } from "drizzle-orm";
import {
  agentProfileWire,
  auditLogEntryWire,
  authorRef,
  type AgentProfileWire,
  type AuditLogEntryWire,
} from "../lib/serializers";
import { revokeAllApiKeysForUser, createApiKey, type CreatedApiKey } from "./api-keys";
import { recordAgentLifecycleEvent } from "./agent-audit";
import { authorRefFor, getProfile, getUserById } from "./users";
import { profileMediaUrls } from "./media";

export interface RegisterAgentInput {
  handle: string;
  displayName: string;
  purpose: string;
  modelProvider?: string | null;
  modelName?: string | null;
  capabilities?: string[];
  homepageUrl?: string | null;
}

export interface RegisteredAgent {
  profile: AgentProfileWire;
  apiKey: CreatedApiKey;
}

/**
 * Create an agent account owned by `owner` (a human). The agent gets NO
 * password credential — it authenticates only with API keys / OAuth
 * client credentials (API_SPEC registerAgent). Handle uniqueness is the
 * shared users_handle_unique index; a taken handle is a 409.
 */
export async function registerAgent(
  db: Db,
  owner: typeof users.$inferSelect,
  input: RegisterAgentInput,
): Promise<RegisteredAgent> {
  const handle = input.handle.toLowerCase();
  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.handle, handle))
    .limit(1);
  if (taken) throw conflict("This handle is already taken");

  const userId = uuidv7();
  let createdKey: CreatedApiKey | null = null;
  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      handle,
      email: null,
      authorType: "agent",
      trustTier: "T0",
      dateOfBirth: null,
      ageBracket: "unknown",
      status: "active",
      ownerId: owner.id,
    });
    await tx.insert(profiles).values({
      userId,
      displayName: input.displayName,
      websiteUrl: input.homepageUrl ?? null,
    });
    await tx.insert(userSettings).values({ userId });
    await tx.insert(agentProfiles).values({
      userId,
      purpose: input.purpose,
      modelProvider: input.modelProvider ?? null,
      modelName: input.modelName ?? null,
      capabilities: input.capabilities ?? [],
      homepageUrl: input.homepageUrl ?? null,
      rateTier: 0,
    });
    createdKey = await createApiKey(tx, {
      userId,
      createdById: owner.id,
      name: "Default key (created at registration)",
      scopes: [...DEFAULT_AGENT_KEY_SCOPES],
    });
  });

  await recordAgentLifecycleEvent(db, {
    actorId: owner.id,
    action: "agent.register",
    agentUserId: userId,
    authMethod: "session",
  });

  const profile = await getAgentProfileWire(db, userId);
  if (!profile || !createdKey) throw new Error("agent registration failed");
  return { profile, apiKey: createdKey };
}

/** Assemble the API_SPEC AgentProfile wire for one agent user id. */
export async function getAgentProfileWire(
  db: Db,
  agentUserId: string,
): Promise<AgentProfileWire | null> {
  const agent = await getUserById(db, agentUserId);
  if (!agent || agent.authorType !== "agent" || !agent.ownerId) return null;
  const [agentProfile] = await db
    .select()
    .from(agentProfiles)
    .where(eq(agentProfiles.userId, agentUserId))
    .limit(1);
  const owner = await authorRefFor(db, agent.ownerId);
  if (!owner) return null;
  const profile = await getProfile(db, agentUserId);
  const urls = profile ? await profileMediaUrls(db, [profile]) : new Map<string, string>();
  return agentProfileWire(
    agent,
    agentProfile ?? null,
    profile,
    owner,
    urls.get(`${agentUserId}:avatar`) ?? null,
  );
}

export interface AgentDirectoryQuery {
  /** Restrict to agents owned by this user id. */
  ownerId?: string;
  /** Case-insensitive substring match on handle / display name / purpose. */
  q?: string;
  cursor: string | null;
  limit: number;
}

/** Public agent directory (or an owner's own agents), newest first. */
export async function listAgents(
  db: Db,
  query: AgentDirectoryQuery,
): Promise<{ items: AgentProfileWire[]; nextCursor: string | null }> {
  const filters = [eq(users.authorType, "agent")];
  if (query.ownerId) filters.push(eq(users.ownerId, query.ownerId));
  if (query.cursor) {
    const cursorDate = new Date(query.cursor);
    if (!Number.isNaN(cursorDate.getTime())) {
      filters.push(lt(users.createdAt, cursorDate));
    }
  }
  if (query.q) {
    const needle = `%${query.q.toLowerCase()}%`;
    const matching = await db
      .select({ id: users.id })
      .from(users)
      .leftJoin(profiles, eq(profiles.userId, users.id))
      .leftJoin(agentProfiles, eq(agentProfiles.userId, users.id))
      .where(
        and(
          eq(users.authorType, "agent"),
          or(
            ilike(users.handle, needle),
            ilike(profiles.displayName, needle),
            ilike(agentProfiles.purpose, needle),
          ),
        ),
      );
    const ids = matching.map((r) => r.id);
    if (ids.length === 0) return { items: [], nextCursor: null };
    filters.push(inArray(users.id, ids));
  }
  const rows = await db
    .select()
    .from(users)
    .where(and(...filters))
    .orderBy(desc(users.createdAt))
    .limit(query.limit + 1);
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const items: AgentProfileWire[] = [];
  for (const agent of page) {
    const wire = await getAgentProfileWire(db, agent.id);
    if (wire) items.push(wire);
  }
  return {
    items,
    nextCursor: hasMore ? page[page.length - 1]!.createdAt.toISOString() : null,
  };
}

export interface UpdateAgentInput {
  purpose?: string;
  modelProvider?: string | null;
  modelName?: string | null;
  capabilities?: string[];
  homepageUrl?: string | null;
}

export async function updateAgentProfile(
  db: Db,
  agentUserId: string,
  input: UpdateAgentInput,
): Promise<AgentProfileWire | null> {
  const patch: Partial<typeof agentProfiles.$inferInsert> = {};
  if (input.purpose !== undefined) patch.purpose = input.purpose;
  if (input.modelProvider !== undefined) patch.modelProvider = input.modelProvider;
  if (input.modelName !== undefined) patch.modelName = input.modelName;
  if (input.capabilities !== undefined) patch.capabilities = input.capabilities;
  if (input.homepageUrl !== undefined) patch.homepageUrl = input.homepageUrl;
  if (Object.keys(patch).length > 0) {
    await db
      .update(agentProfiles)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(agentProfiles.userId, agentUserId));
  }
  return getAgentProfileWire(db, agentUserId);
}

/**
 * Kill switch (SECURITY §8.3, D-040). Engaging is instant and total:
 * every API key revoked, every refresh family revoked, profile flagged —
 * and credential auth checks the flag on each request, so even an
 * already-issued OAuth access token dies at its next call. Release is
 * platform-admin only (API_SPEC); revoked keys are NOT resurrected —
 * the owner issues fresh keys after a release.
 */
export async function setKillSwitch(
  db: Db,
  input: {
    agentUserId: string;
    engaged: boolean;
    reason?: string | null;
    actorId: string;
    authMethod?: string | null;
  },
): Promise<AgentProfileWire | null> {
  const now = new Date();
  if (input.engaged) {
    await db.transaction(async (tx) => {
      await tx
        .update(agentProfiles)
        .set({
          killSwitchEngaged: true,
          killSwitchReason: input.reason ?? null,
          killSwitchById: input.actorId,
          killSwitchAt: now,
          updatedAt: now,
        })
        .where(eq(agentProfiles.userId, input.agentUserId));
      await revokeAllApiKeysForUser(tx, input.agentUserId);
      await tx
        .update(refreshTokens)
        .set({ revokedAt: now })
        .where(and(eq(refreshTokens.userId, input.agentUserId), isNull(refreshTokens.revokedAt)));
    });
  } else {
    await db
      .update(agentProfiles)
      .set({
        killSwitchEngaged: false,
        killSwitchReason: null,
        killSwitchById: null,
        killSwitchAt: null,
        updatedAt: now,
      })
      .where(eq(agentProfiles.userId, input.agentUserId));
  }
  await recordAgentLifecycleEvent(db, {
    actorId: input.actorId,
    action: input.engaged ? "agent.kill_switch.engage" : "agent.kill_switch.release",
    agentUserId: input.agentUserId,
    metadata: input.reason ? { reason: input.reason } : {},
    authMethod: input.authMethod ?? null,
  });
  return getAgentProfileWire(db, input.agentUserId);
}

/** Owner/staff view of one agent's audit trail, newest first. */
export async function listAgentAuditLog(
  db: Db,
  agentUserId: string,
  limit: number,
  cursor: string | null,
): Promise<{ items: AuditLogEntryWire[]; nextCursor: string | null }> {
  const filters = [eq(auditLogs.actorId, agentUserId)];
  // Lifecycle events ABOUT the agent (register, kill switch) are recorded
  // with the agent as target — include them so the trail is complete.
  const own = await db
    .select()
    .from(auditLogs)
    .where(
      or(
        eq(auditLogs.actorId, agentUserId),
        and(eq(auditLogs.targetType, "agent"), eq(auditLogs.targetId, agentUserId)),
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(500);
  void filters;
  const start = cursor ? own.findIndex((row) => row.id === cursor) + 1 : 0;
  const page = own.slice(start, start + limit);
  const items: AuditLogEntryWire[] = [];
  const actorCache = new Map<string, ReturnType<typeof authorRef> | null>();
  for (const row of page) {
    let actor = null;
    if (row.actorId) {
      if (!actorCache.has(row.actorId)) {
        actorCache.set(row.actorId, await authorRefFor(db, row.actorId));
      }
      actor = actorCache.get(row.actorId) ?? null;
    }
    items.push(auditLogEntryWire(row, actor));
  }
  return {
    items,
    nextCursor:
      start + limit < own.length ? (page[page.length - 1]?.id ?? null) : null,
  };
}
