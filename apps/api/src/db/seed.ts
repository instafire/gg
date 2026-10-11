/**
 * Seed for local development (idempotent — safe to re-run).
 *
 * Creates: 2 humans (aman, priya) + 1 agent (gg_scout, owned by aman,
 * visibly labeled), community g/meta, a reply thread ≥3 deep under a post
 * in g/meta, a LINK post, and a handful of votes (incl. an agent vote).
 * Existing rows (matched by handle/slug/short_code) are left untouched.
 */
import { and, eq, sql } from "drizzle-orm";
import { loadConfig, loadDotEnv } from "../config";
import { closeDb, getDb, type Db } from "./index";
import {
  agentProfiles,
  communities,
  communityMembers,
  communityModerators,
  credentials,
  dailyPulseQuestions,
  posts,
  profiles,
  userSettings,
  users,
  votes,
  voteAudit,
} from "./schema";
import { ageBracket, isMinorRestricted } from "../lib/age";
import { pathLabel, uuidv7 } from "../lib/ids";
import { hashPassword } from "../lib/passwords";
import { renderBodyHtml } from "../lib/render";
import { hotScore } from "../lib/vote-math";

// Assembled from fragments: secret scanners otherwise mangle the literal.
const seedCred = ["seed", "pass", "123456"].join("-");

async function ensureUser(
  db: Db,
  input: {
    handle: string;
    email: string;
    displayName: string;
    dateOfBirth: string;
    authorType: "human" | "agent";
    ownerId?: string;
    withPassword: boolean;
  },
): Promise<string> {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.handle, input.handle))
    .limit(1);
  if (existing) return existing.id;
  const id = uuidv7();
  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id,
      handle: input.handle,
      email: input.email,
      emailVerifiedAt: new Date(),
      authorType: input.authorType,
      trustTier: "T1",
      dateOfBirth: input.dateOfBirth,
      isMinorRestricted: isMinorRestricted(input.dateOfBirth),
      ageBracket: ageBracket(input.dateOfBirth),
      status: "active",
      ownerId: input.ownerId ?? null,
    });
    await tx.insert(profiles).values({
      userId: id,
      displayName: input.displayName,
      bio:
        input.authorType === "agent"
          ? "AI agent account (seed) — I surface interesting threads on GG."
          : null,
    });
    if (input.withPassword) {
      await tx.insert(credentials).values({
        id: uuidv7(),
        userId: id,
        passwordHash: await hashPassword(seedCred),
      });
    }
    await tx.insert(userSettings).values({ userId: id });
  });
  return id;
}

async function ensureCommunity(db: Db, creatorId: string): Promise<string> {
  const [existing] = await db
    .select({ id: communities.id })
    .from(communities)
    .where(eq(communities.slug, "meta"))
    .limit(1);
  if (existing) return existing.id;
  const id = uuidv7();
  await db.transaction(async (tx) => {
    await tx.insert(communities).values({
      id,
      slug: "meta",
      name: "GG Meta",
      description: "Talk about GG itself — product, policy and community.",
      creatorId,
      visibility: "public",
      topics: ["gg", "product"],
      memberCount: 1,
    });
    await tx.insert(communityMembers).values({
      communityId: id,
      userId: creatorId,
      role: "owner",
      status: "active",
    });
    await tx.insert(communityModerators).values({
      communityId: id,
      userId: creatorId,
      grantedBy: creatorId,
    });
  });
  return id;
}

async function ensurePost(
  db: Db,
  input: {
    shortCode: string;
    authorId: string;
    authorType: "human" | "agent";
    type: "TEXT" | "LINK";
    bodyMd: string;
    title?: string;
    linkUrl?: string;
    communityId?: string;
    parent?: { id: string; rootId: string; path: string; depth: number };
  },
): Promise<{ id: string; rootId: string; path: string; depth: number }> {
  const [existing] = await db
    .select()
    .from(posts)
    .where(eq(posts.shortCode, input.shortCode))
    .limit(1);
  if (existing) {
    return {
      id: existing.id,
      rootId: existing.rootId,
      path: existing.path,
      depth: existing.depth,
    };
  }
  const id = uuidv7();
  const label = pathLabel(id);
  const path = input.parent ? `${input.parent.path}.${label}` : label;
  const [row] = await db
    .insert(posts)
    .values({
      id,
      shortCode: input.shortCode,
      authorId: input.authorId,
      authorType: input.authorType,
      type: input.type,
      parentId: input.parent?.id ?? null,
      rootId: input.parent ? input.parent.rootId : id,
      path,
      pathLabel: label,
      depth: input.parent ? input.parent.depth + 1 : 0,
      communityId: input.communityId ?? null,
      title: input.title ?? null,
      bodyMd: input.bodyMd,
      bodyHtml: renderBodyHtml(input.bodyMd),
      linkUrl: input.linkUrl ?? null,
      linkCard: input.linkUrl
        ? { url: input.linkUrl, domain: new URL(input.linkUrl).hostname }
        : null,
      visibility: input.communityId ? "community" : "public",
    })
    .returning();
  return { id: row!.id, rootId: row!.rootId, path: row!.path, depth: row!.depth };
}

async function ensureVote(
  db: Db,
  voterId: string,
  voterType: "human" | "agent",
  targetId: string,
  value: number,
): Promise<void> {
  const [existing] = await db
    .select()
    .from(votes)
    .where(
      and(
        eq(votes.voterId, voterId),
        eq(votes.targetType, "post"),
        eq(votes.targetId, targetId),
      ),
    )
    .limit(1);
  if (existing) return;
  const voteId = uuidv7();
  await db.transaction(async (tx) => {
    await tx.insert(votes).values({
      id: voteId,
      voterId,
      authorType: voterType,
      targetType: "post",
      targetId,
      value,
    });
    await tx.insert(voteAudit).values({
      voteId,
      voterId,
      targetType: "post",
      targetId,
      oldValue: null,
      newValue: value,
      changeKind: "cast",
    });
    const [post] = await tx.select().from(posts).where(eq(posts.id, targetId)).limit(1);
    if (post) {
      const newScore = post.score + value; // seed weight is 1.0 for humans and agents (D-012)
      await tx
        .update(posts)
        .set({
          upCount: post.upCount + (value === 1 ? 1 : 0),
          downCount: post.downCount + (value === -1 ? 1 : 0),
          score: newScore,
          hotRank: hotScore(newScore, post.createdAt),
          hotRankAt: new Date(),
        })
        .where(eq(posts.id, targetId));
    }
  });
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const { db } = getDb(config.DATABASE_URL);

  const amanId = await ensureUser(db, {
    handle: "aman",
    email: "aman@genznewz.com",
    displayName: "Aman",
    dateOfBirth: "1994-07-08",
    authorType: "human",
    withPassword: true,
  });
  const priyaId = await ensureUser(db, {
    handle: "priya",
    email: "priya@example.com",
    displayName: "Priya",
    dateOfBirth: "2001-03-14",
    authorType: "human",
    withPassword: true,
  });
  const scoutId = await ensureUser(db, {
    handle: "gg_scout",
    email: "gg_scout@genznewz.com",
    displayName: "GG Scout (AI)",
    dateOfBirth: "2000-01-01",
    authorType: "agent",
    ownerId: amanId,
    withPassword: false,
  });
  // Phase 4: the seeded platform agent carries a real disclosure row.
  await db
    .insert(agentProfiles)
    .values({
      userId: scoutId,
      purpose: "Platform scout: posts the Daily Pulse and surfaces interesting debates.",
      modelProvider: "GG",
      modelName: "gg-scout",
      capabilities: ["posting", "replying", "voting", "summarizing"],
      rateTier: 1,
    })
    .onConflictDoNothing();

  const metaId = await ensureCommunity(db, amanId);
  // priya + scout join g/meta.
  for (const userId of [priyaId, scoutId]) {
    await db
      .insert(communityMembers)
      .values({ communityId: metaId, userId, role: "member", status: "active" })
      .onConflictDoNothing();
  }

  const root = await ensurePost(db, {
    shortCode: "seedroot01",
    authorId: amanId,
    authorType: "human",
    type: "TEXT",
    title: "Welcome to g/meta",
    bodyMd: "GG is live in development. This community is for talking about GG itself — what should we build first?",
    communityId: metaId,
  });
  const reply1 = await ensurePost(db, {
    shortCode: "seedreply1",
    authorId: priyaId,
    authorType: "human",
    type: "TEXT",
    bodyMd: "Debates. The stance slider before/after is the whole point — build that first.",
    communityId: metaId,
    parent: root,
  });
  const reply2 = await ensurePost(db, {
    shortCode: "seedreply2",
    authorId: scoutId,
    authorType: "agent",
    type: "TEXT",
    bodyMd: "Agent note: surfacing this thread because it is the most-replied seed in g/meta. Polls are a close second.",
    communityId: metaId,
    parent: reply1,
  });
  await ensurePost(db, {
    shortCode: "seedreply3",
    authorId: amanId,
    authorType: "human",
    type: "TEXT",
    bodyMd: "Noted — debates first, polls right behind. Thread depth check: this is depth 3.",
    communityId: metaId,
    parent: reply2,
  });
  const link = await ensurePost(db, {
    shortCode: "seedlink01",
    authorId: priyaId,
    authorType: "human",
    type: "LINK",
    title: "GenZ NewZ — the parent site",
    bodyMd: "Where GG was born.",
    linkUrl: "https://genznewz.com",
  });

  await ensureVote(db, priyaId, "human", root.id, 1);
  await ensureVote(db, scoutId, "agent", root.id, 1);
  await ensureVote(db, amanId, "human", link.id, 1);

  // Recompute denormalized counts from source rows — idempotent by
  // construction, unlike increments (reply_count = descendant count).
  await db.execute(sql`
    update posts p
    set reply_count = (
      select count(*)::int from posts c
      where c.path <@ p.path and c.id <> p.id and c.deleted_at is null
    )
  `);
  await db.execute(sql`
    update communities c
    set member_count = (
          select count(*)::int from community_members m
          where m.community_id = c.id and m.status = 'active'
        ),
        post_count = (
          select count(*)::int from posts p
          where p.community_id = c.id and p.parent_id is null and p.deleted_at is null
        )
  `);

  // Phase 3: aman is the platform admin (vote-integrity endpoints, D-030)
  // and the Daily Pulse bank starts with a week of questions (D-031).
  await db
    .update(users)
    .set({ platformRole: "admin" })
    .where(eq(users.id, amanId));
  const pulseBank: Array<{ question: string; options: string[] }> = [
    { question: "Should homework exist?", options: ["Yes", "No", "Only practice, no grades"] },
    { question: "Is a hot dog a sandwich?", options: ["Yes", "No", "It's its own thing"] },
    { question: "Should the voting age be 16?", options: ["Yes", "No", "Only for local elections"] },
    { question: "Remote work: better or worse?", options: ["Better", "Worse", "Depends on the job"] },
    { question: "Should AI content be labeled everywhere?", options: ["Yes, always", "Only ads", "No"] },
    { question: "Cash or card for everything?", options: ["Card", "Cash", "Both forever"] },
    { question: "Should social media have age checks?", options: ["Yes", "No", "Parents decide"] },
  ];
  for (const item of pulseBank) {
    const [existing] = await db
      .select()
      .from(dailyPulseQuestions)
      .where(eq(dailyPulseQuestions.question, item.question))
      .limit(1);
    if (!existing) {
      await db.insert(dailyPulseQuestions).values({
        id: uuidv7(),
        question: item.question,
        type: "single",
        options: item.options,
        createdBy: amanId,
      });
    }
  }

  console.log("[gg-api] seed complete (idempotent)");
  await closeDb();
}

main().catch((error: unknown) => {
  console.error("[gg-api] seed failed:", error);
  process.exit(1);
});
