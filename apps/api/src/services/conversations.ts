/**
 * Conversations & DMs (Phase 5A; DATA_MODEL §10.2, API_SPEC Messages,
 * DECISIONS D-047/D-048/D-049).
 *
 * Model: a conversation has per-participant rows carrying the request
 * state (`active | requested | declined`), read position, mute and leave
 * state — inbox placement is a property of the VIEWER's row, never of the
 * conversation itself. DMs are deduplicated by a canonical pair key with
 * a database UNIQUE constraint (one DM per pair, DATA_MODEL §14).
 *
 * Gates (D-049) live here, not in the routes: blocks, recipient dm_policy,
 * minor protection (SECURITY §10), agent rules (SECURITY §9).
 */
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import {
  blocks,
  conversationParticipants,
  conversations,
  follows,
  media,
  messageReactions,
  messages,
  posts,
  userSettings,
  users,
} from "../db/schema";
import { forbidden, notFound, unprocessable } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { decodeCursor, encodeCursor, type Page } from "../lib/pagination";
import { publishToUsers } from "../lib/realtime";
import {
  mediaWire,
  type AuthorRef,
  type MediaObjectWire,
  type PostWire,
  type UserRow,
} from "../lib/serializers";
import { mediaByIds } from "./media";
import { notify } from "./notifications";
import { hydratePosts } from "./posts";
import { authorMap, getUserByHandle } from "./users";

type ParticipantRow = typeof conversationParticipants.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;
type MessageRow = typeof messages.$inferSelect;

export const GROUP_MAX_PARTICIPANTS = 50;
export const MESSAGE_BODY_MAX = 4000;

// ─── Wires ───────────────────────────────────────────────────────────────────

export interface MessageWire {
  id: string;
  conversation_id: string;
  sender: AuthorRef;
  author_type: UserRow["authorType"];
  body: string | null;
  media: MediaObjectWire | null;
  reply_to_message_id: string | null;
  reply_to: {
    id: string;
    sender_handle: string;
    body: string | null;
    deleted: boolean;
  } | null;
  shared_post: PostWire | null;
  reactions: Record<string, number>;
  viewer_reactions: string[];
  edited_at: string | null;
  deleted_at: string | null;
  read_by: string[];
  created_at: string;
}

export interface ConversationWire {
  id: string;
  kind: "dm" | "group" | "modmail";
  /** Phase 5B: owning community for mod-mail threads. */
  community_id: string | null;
  title: string | null;
  participants: AuthorRef[];
  status: "active" | "requested";
  last_message: MessageWire | null;
  unread_count: number;
  last_message_at: string | null;
  muted_until: string | null;
  created_at: string;
}

// ─── Small lookups ───────────────────────────────────────────────────────────

export async function isFollowing(db: Db, followerId: string, followeeId: string): Promise<boolean> {
  const [edge] = await db
    .select({ followerId: follows.followerId })
    .from(follows)
    .where(and(eq(follows.followerId, followerId), eq(follows.followeeId, followeeId)))
    .limit(1);
  return Boolean(edge);
}

export async function isBlockedEitherWay(db: Db, a: string, b: string): Promise<boolean> {
  const rows = await db
    .select({ blockerId: blocks.blockerId })
    .from(blocks)
    .where(
      or(
        and(eq(blocks.blockerId, a), eq(blocks.blockedId, b)),
        and(eq(blocks.blockerId, b), eq(blocks.blockedId, a)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function getParticipant(
  db: Db,
  conversationId: string,
  userId: string,
): Promise<ParticipantRow | null> {
  const [row] = await db
    .select()
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.userId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getConversationRow(db: Db, id: string): Promise<ConversationRow | null> {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  return row ?? null;
}

async function participantsOf(db: Db, conversationId: string): Promise<ParticipantRow[]> {
  return db
    .select()
    .from(conversationParticipants)
    .where(eq(conversationParticipants.conversationId, conversationId));
}

/** Ids of participants who have not left (realtime fan-out, WS typing). */
export async function activeParticipantIds(db: Db, conversationId: string): Promise<string[]> {
  const rows = await participantsOf(db, conversationId);
  return rows.filter((r) => !r.leftAt).map((r) => r.userId);
}

// ─── Message hydration ───────────────────────────────────────────────────────

/**
 * Hydrate message rows to spec Message wires for one viewer: authors,
 * media, reaction counts + the viewer's own reactions, quoted-message
 * previews, shared posts, and read_by (participants whose read position
 * covers the message AND who allow read receipts — API_SPEC Message).
 */
export async function messageWires(
  db: Db,
  rows: MessageRow[],
  viewerId: string,
): Promise<MessageWire[]> {
  if (rows.length === 0) return [];
  const conversationIds = [...new Set(rows.map((r) => r.conversationId))];
  const senderIds = [...new Set(rows.map((r) => r.senderId))];
  const mediaIds = rows.map((r) => r.mediaId).filter((id): id is string => id !== null);
  const sharedPostIds = rows.map((r) => r.sharedPostId).filter((id): id is string => id !== null);
  const replyToIds = rows
    .map((r) => r.replyToMessageId)
    .filter((id): id is string => id !== null);

  const [authors, mediaMap, sharedPosts, participants, replyRows] = await Promise.all([
    authorMap(db, senderIds),
    mediaByIds(db, mediaIds),
    sharedPostIds.length
      ? db.select().from(posts).where(inArray(posts.id, sharedPostIds))
      : Promise.resolve([]),
    db
      .select()
      .from(conversationParticipants)
      .where(inArray(conversationParticipants.conversationId, conversationIds)),
    replyToIds.length
      ? db.select().from(messages).where(inArray(messages.id, replyToIds))
      : Promise.resolve([]),
  ]);

  const sharedWires = new Map<string, PostWire>();
  if (sharedPosts.length > 0) {
    const hydrated = await hydratePosts(
      db,
      sharedPosts.filter((p) => !p.deletedAt),
      viewerId,
    );
    for (const wire of hydrated) sharedWires.set(wire.id, wire);
  }

  const reactionRows = await db
    .select()
    .from(messageReactions)
    .where(
      inArray(
        messageReactions.messageId,
        rows.map((r) => r.id),
      ),
    );
  const reactionsByMessage = new Map<string, Record<string, number>>();
  const viewerReactions = new Map<string, string[]>();
  for (const reaction of reactionRows) {
    const counts = reactionsByMessage.get(reaction.messageId) ?? {};
    counts[reaction.emoji] = (counts[reaction.emoji] ?? 0) + 1;
    reactionsByMessage.set(reaction.messageId, counts);
    if (reaction.userId === viewerId) {
      const mine = viewerReactions.get(reaction.messageId) ?? [];
      mine.push(reaction.emoji);
      viewerReactions.set(reaction.messageId, mine);
    }
  }

  // Read receipts: participants (other than the sender) whose read
  // position covers the message and whose settings allow receipts.
  const receiptSettings = new Map<string, boolean>();
  const participantUserIds = [...new Set(participants.map((p) => p.userId))];
  if (participantUserIds.length > 0) {
    const settings = await db
      .select()
      .from(userSettings)
      .where(inArray(userSettings.userId, participantUserIds));
    for (const s of settings) receiptSettings.set(s.userId, s.readReceipts);
  }
  const handleById = new Map<string, string>();
  for (const p of participants) {
    const author = authors.get(p.userId);
    if (author) handleById.set(p.userId, author.handle);
  }
  // Handles for participants who never sent a message in this page.
  const missingHandles = participantUserIds.filter((id) => !handleById.has(id));
  if (missingHandles.length > 0) {
    const extra = await authorMap(db, missingHandles);
    for (const [id, ref] of extra) handleById.set(id, ref.handle);
  }

  const replyById = new Map(replyRows.map((r) => [r.id, r]));

  return rows.map((row) => {
    const deleted = row.deletedAt !== null;
    const readBy: string[] = [];
    for (const p of participants) {
      if (p.conversationId !== row.conversationId) continue;
      if (p.userId === row.senderId) continue;
      if (p.lastReadAt && p.lastReadAt >= row.createdAt && receiptSettings.get(p.userId) !== false) {
        const handle = handleById.get(p.userId);
        if (handle) readBy.push(handle);
      }
    }
    const replyTo = row.replyToMessageId ? replyById.get(row.replyToMessageId) : undefined;
    const mediaRow = row.mediaId ? mediaMap.get(row.mediaId) : undefined;
    return {
      id: row.id,
      conversation_id: row.conversationId,
      sender: authors.get(row.senderId)!,
      author_type: row.authorType,
      body: deleted ? null : row.body,
      media: !deleted && mediaRow && mediaRow.status === "ready" ? mediaWire(mediaRow) : null,
      reply_to_message_id: row.replyToMessageId,
      reply_to: replyTo
        ? {
            id: replyTo.id,
            sender_handle: handleById.get(replyTo.senderId) ?? "unknown",
            body: replyTo.deletedAt ? null : (replyTo.body?.slice(0, 140) ?? null),
            deleted: replyTo.deletedAt !== null,
          }
        : null,
      shared_post: deleted ? null : row.sharedPostId
        ? (sharedWires.get(row.sharedPostId) ?? null)
        : null,
      reactions: reactionsByMessage.get(row.id) ?? {},
      viewer_reactions: viewerReactions.get(row.id) ?? [],
      edited_at: row.editedAt?.toISOString() ?? null,
      deleted_at: row.deletedAt?.toISOString() ?? null,
      read_by: readBy,
      created_at: row.createdAt.toISOString(),
    };
  });
}

// ─── Conversation hydration ──────────────────────────────────────────────────

async function unreadCountFor(
  db: Db,
  conversationId: string,
  participant: ParticipantRow,
): Promise<number> {
  // Id-based when a read marker exists: message ids are uuidv7 (time
  // ordered), which sidesteps a timestamptz precision trap — the stored
  // last_read_at is the JS-millisecond truncation of the message's
  // microsecond created_at, so a pure timestamp comparison would keep
  // the just-read message "unread" forever.
  const afterReadMarker = participant.lastReadMessageId
    ? gt(messages.id, participant.lastReadMessageId)
    : gt(messages.createdAt, participant.createdAt);
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        ne(messages.senderId, participant.userId),
        afterReadMarker,
        isNull(messages.deletedAt),
      ),
    );
  return row?.value ?? 0;
}

export async function conversationWire(
  db: Db,
  conversation: ConversationRow,
  viewerId: string,
): Promise<ConversationWire> {
  const participants = await participantsOf(db, conversation.id);
  const viewerRow = participants.find((p) => p.userId === viewerId);
  const authors = await authorMap(db, participants.map((p) => p.userId));
  const [lastMessage] = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversation.id))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const [lastWire] = lastMessage
    ? await messageWires(db, [lastMessage], viewerId)
    : [null];
  return {
    id: conversation.id,
    kind:
      conversation.kind === "group"
        ? "group"
        : conversation.kind === "modmail"
          ? "modmail"
          : "dm",
    community_id: conversation.communityId ?? null,
    title: conversation.title,
    participants: participants
      .filter((p) => !p.leftAt)
      .map((p) => authors.get(p.userId))
      .filter((a): a is AuthorRef => Boolean(a)),
    status: viewerRow?.status === "requested" ? "requested" : "active",
    last_message: lastWire ?? null,
    unread_count: viewerRow ? await unreadCountFor(db, conversation.id, viewerRow) : 0,
    last_message_at: conversation.lastMessageAt?.toISOString() ?? null,
    muted_until: viewerRow?.mutedUntil?.toISOString() ?? null,
    created_at: conversation.createdAt.toISOString(),
  };
}

/** Total unread DM conversations count for the badge (D-053). */
export async function dmUnreadCount(db: Db, userId: string): Promise<number> {
  const mine = await db
    .select()
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.userId, userId),
        eq(conversationParticipants.status, "active"),
        isNull(conversationParticipants.leftAt),
        or(
          isNull(conversationParticipants.mutedUntil),
          sql`${conversationParticipants.mutedUntil} < now()`,
        ),
      ),
    );
  let total = 0;
  for (const row of mine) {
    if ((await unreadCountFor(db, row.conversationId, row)) > 0) total += 1;
  }
  return total;
}

// ─── Inbox ───────────────────────────────────────────────────────────────────

export async function listConversations(
  db: Db,
  viewerId: string,
  box: "main" | "requests",
  cursor: string | undefined,
  limit: number,
): Promise<Page<ConversationWire>> {
  const decoded = decodeCursor<{ k: string; id: string }>(cursor);
  const conditions = [
    eq(conversationParticipants.userId, viewerId),
    eq(conversationParticipants.status, box === "requests" ? "requested" : "active"),
  ];
  if (box === "main") {
    // Hidden when I left — except DMs, which resurface on a new message
    // (the send path clears left_at for DMs; this also covers races).
    conditions.push(
      or(
        isNull(conversationParticipants.leftAt),
        and(
          eq(conversations.kind, "dm"),
          sql`${conversations.lastMessageAt} > ${conversationParticipants.leftAt}`,
        ),
      )!,
    );
  }
  if (decoded) {
    conditions.push(
      or(
        sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt}) < ${decoded.k}::timestamptz`,
        and(
          sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt}) = ${decoded.k}::timestamptz`,
          sql`${conversations.id} < ${decoded.id}::uuid`,
        ),
      )!,
    );
  }
  const rows = await db
    .select({ conversation: conversations })
    .from(conversationParticipants)
    .innerJoin(
      conversations,
      eq(conversations.id, conversationParticipants.conversationId),
    )
    .where(and(...conditions))
    .orderBy(
      sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt}) desc`,
      desc(conversations.id),
    )
    .limit(limit + 1);
  const pageRows = rows.slice(0, limit);
  const wires: ConversationWire[] = [];
  for (const row of pageRows) {
    wires.push(await conversationWire(db, row.conversation, viewerId));
  }
  const last = pageRows[pageRows.length - 1]?.conversation;
  return {
    items: wires,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({
            k: (last.lastMessageAt ?? last.createdAt).toISOString(),
            id: last.id,
          })
        : null,
  };
}

// ─── Creation gates (D-049) ──────────────────────────────────────────────────

/**
 * Validate that `sender` may open a DM with `recipient`; returns the
 * recipient's initial participant status. Throws 403 on any hard gate.
 */
async function dmRecipientStatus(
  db: Db,
  sender: UserRow,
  recipient: UserRow,
): Promise<"active" | "requested"> {
  if (await isBlockedEitherWay(db, sender.id, recipient.id)) {
    throw forbidden("You cannot message this account");
  }
  const recipientFollowsSender = await isFollowing(db, recipient.id, sender.id);
  // Minors (SECURITY §10): no agent DMs at all; DMs only from accounts
  // the minor follows — everything else is 403, never a request.
  if (recipient.isMinorRestricted) {
    if (sender.authorType === "agent") {
      throw forbidden("Agent accounts cannot message minor accounts");
    }
    if (!recipientFollowsSender) {
      throw forbidden("This account can only receive messages from people they follow");
    }
  }
  if (sender.isMinorRestricted && recipient.authorType === "agent") {
    throw forbidden("Minor accounts cannot message agent accounts");
  }
  const [settings] = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, recipient.id))
    .limit(1);
  const policy = settings?.dmPolicy ?? "everyone";
  if (policy === "none") {
    const senderFollowsRecipient = await isFollowing(db, sender.id, recipient.id);
    if (!(recipientFollowsSender && senderFollowsRecipient)) {
      throw forbidden("This account does not accept direct messages");
    }
  } else if (policy === "followers" || policy === "mentioned") {
    if (!recipientFollowsSender) {
      throw forbidden("This account only accepts messages from people they follow");
    }
  }
  // Agent-initiated DMs land as requests unless the recipient follows the
  // agent (SECURITY §9 opt-in posture).
  if (sender.authorType === "agent" && !recipientFollowsSender) return "requested";
  return recipientFollowsSender ? "active" : "requested";
}

/** Mutual-follow requirement for any group containing a minor (D-049). */
async function assertGroupMinorRule(db: Db, memberIds: string[]): Promise<void> {
  const rows = await db.select().from(users).where(inArray(users.id, memberIds));
  const minors = rows.filter((u) => u.isMinorRestricted);
  if (minors.length === 0) return;
  if (rows.some((u) => u.authorType === "agent")) {
    throw forbidden("Agent accounts cannot join conversations with minor accounts");
  }
  for (const minor of minors) {
    for (const other of rows) {
      if (other.id === minor.id) continue;
      const [minorFollows, otherFollows] = await Promise.all([
        isFollowing(db, minor.id, other.id),
        isFollowing(db, other.id, minor.id),
      ]);
      if (!minorFollows || !otherFollows) {
        throw forbidden(
          "Group chats with a minor account require mutual follows with every member",
        );
      }
    }
  }
}

export interface CreateConversationResult {
  conversation: ConversationWire;
  created: boolean;
}

export async function createConversation(
  db: Db,
  me: UserRow,
  participantHandles: string[],
  title: string | null,
): Promise<CreateConversationResult> {
  const handles = [...new Set(participantHandles.map((h) => h.replace(/^@/, "").toLowerCase()))]
    .filter((h) => h !== me.handle);
  if (handles.length === 0) throw unprocessable("participant_handles: at least one other participant is required");
  const others: UserRow[] = [];
  for (const handle of handles) {
    const user = await getUserByHandle(db, handle);
    if (!user || user.deletedAt || user.status === "deactivated") {
      throw notFound(`User @${handle} not found`);
    }
    others.push(user);
  }

  if (others.length === 1) {
    const other = others[0]!;
    const pairKey = [me.id, other.id].sort().join(":");
    const [existing] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.dmPairKey, pairKey))
      .limit(1);
    if (existing) {
      // Re-opening a conversation I previously declined acts as accept.
      await db
        .update(conversationParticipants)
        .set({ status: "active", leftAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(conversationParticipants.conversationId, existing.id),
            eq(conversationParticipants.userId, me.id),
            eq(conversationParticipants.status, "declined"),
          ),
        );
      return { conversation: await conversationWire(db, existing, me.id), created: false };
    }
    const recipientStatus = await dmRecipientStatus(db, me, other);
    const id = uuidv7();
    const [created] = await db.transaction(async (tx) => {
      const [conv] = await tx
        .insert(conversations)
        .values({ id, kind: "dm", title: null, createdBy: me.id, dmPairKey: pairKey })
        .returning();
      await tx.insert(conversationParticipants).values([
        { conversationId: id, userId: me.id, role: "admin", status: "active" },
        { conversationId: id, userId: other.id, role: "member", status: recipientStatus },
      ]);
      return [conv!];
    });
    return { conversation: await conversationWire(db, created!, me.id), created: true };
  }

  // Group chat.
  if (others.length + 1 > GROUP_MAX_PARTICIPANTS) {
    throw unprocessable(`Group chats are capped at ${GROUP_MAX_PARTICIPANTS} participants`);
  }
  await assertGroupMinorRule(db, [me.id, ...others.map((u) => u.id)]);
  for (const other of others) {
    if (await isBlockedEitherWay(db, me.id, other.id)) {
      throw forbidden("You cannot start a group chat with an account you have blocked or that has blocked you");
    }
  }
  const id = uuidv7();
  const [created] = await db.transaction(async (tx) => {
    const [conv] = await tx
      .insert(conversations)
      .values({ id, kind: "group", title: title?.trim() || null, createdBy: me.id, dmPairKey: null })
      .returning();
    await tx.insert(conversationParticipants).values([
      { conversationId: id, userId: me.id, role: "admin", status: "active" },
      ...others.map((u) => ({
        conversationId: id,
        userId: u.id,
        role: "member" as const,
        status: "active" as const,
      })),
    ]);
    return [conv!];
  });
  return { conversation: await conversationWire(db, created!, me.id), created: true };
}

// ─── Messages ────────────────────────────────────────────────────────────────

export async function listMessages(
  db: Db,
  conversationId: string,
  viewerId: string,
  cursor: string | undefined,
  limit: number,
): Promise<Page<MessageWire>> {
  const decoded = decodeCursor<{ k: string; id: string }>(cursor);
  const conditions = [eq(messages.conversationId, conversationId)];
  if (decoded) {
    conditions.push(
      or(
        sql`${messages.createdAt} < ${decoded.k}::timestamptz`,
        and(
          sql`${messages.createdAt} = ${decoded.k}::timestamptz`,
          sql`${messages.id} < ${decoded.id}::uuid`,
        ),
      )!,
    );
  }
  const rows = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit + 1);
  const pageRows = rows.slice(0, limit);
  const wires = await messageWires(db, pageRows, viewerId);
  const last = pageRows[pageRows.length - 1];
  return {
    items: wires,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ k: last.createdAt.toISOString(), id: last.id })
        : null,
  };
}

export interface SendMessageInput {
  body?: string | null;
  mediaId?: string | null;
  replyToMessageId?: string | null;
  sharedPostId?: string | null;
}

export async function sendMessage(
  db: Db,
  conversation: ConversationRow,
  me: UserRow,
  input: SendMessageInput,
): Promise<MessageWire> {
  const mine = await getParticipant(db, conversation.id, me.id);
  if (!mine) throw forbidden("You are not a participant in this conversation");
  if (mine.status === "declined") throw forbidden("You declined this conversation");
  const participants = await participantsOf(db, conversation.id);
  const others = participants.filter((p) => p.userId !== me.id);

  if (mine.leftAt) {
    if (conversation.kind === "group") throw forbidden("You left this conversation");
    // DM: sending again rejoins my side.
    await db
      .update(conversationParticipants)
      .set({ leftAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(conversationParticipants.conversationId, conversation.id),
          eq(conversationParticipants.userId, me.id),
        ),
      );
  }
  if (conversation.kind === "dm") {
    const other = others[0];
    if (other?.status === "declined") {
      throw forbidden("This user declined your message request");
    }
    if (other && (await isBlockedEitherWay(db, me.id, other.userId))) {
      throw forbidden("You cannot message this account");
    }
  }

  const body = input.body?.trim() ? input.body : null;
  if (body && body.length > MESSAGE_BODY_MAX) {
    throw unprocessable(`Message body exceeds ${MESSAGE_BODY_MAX} characters`);
  }
  if (!body && !input.mediaId && !input.sharedPostId) {
    throw unprocessable("A message needs a body, media_id, or shared_post_id");
  }
  if (input.mediaId) {
    const [row] = await db.select().from(media).where(eq(media.id, input.mediaId)).limit(1);
    if (!row) throw unprocessable("media_id: media not found");
    if (row.uploaderId !== me.id) throw forbidden("You can only send your own media");
    if (row.status !== "ready") {
      throw unprocessable(`Media is not ready (status: ${row.status})`);
    }
  }
  if (input.replyToMessageId) {
    const [target] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.id, input.replyToMessageId),
          eq(messages.conversationId, conversation.id),
        ),
      )
      .limit(1);
    if (!target) throw unprocessable("reply_to_message_id: message is not in this conversation");
  }
  if (input.sharedPostId) {
    const [post] = await db.select().from(posts).where(eq(posts.id, input.sharedPostId)).limit(1);
    if (!post || post.deletedAt) throw unprocessable("shared_post_id: post not found");
    if (post.scheduledFor && post.scheduledFor > new Date() && post.authorId !== me.id) {
      throw unprocessable("shared_post_id: post is not published yet");
    }
  }

  const isFirstMessage =
    (await db
      .select({ value: sql<number>`count(*)::int` })
      .from(messages)
      .where(eq(messages.conversationId, conversation.id)))[0]?.value === 0;

  const id = uuidv7();
  const [created] = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(messages)
      .values({
        id,
        conversationId: conversation.id,
        senderId: me.id,
        authorType: me.authorType,
        body,
        mediaId: input.mediaId ?? null,
        replyToMessageId: input.replyToMessageId ?? null,
        sharedPostId: input.sharedPostId ?? null,
      })
      .returning();
    await tx
      .update(conversations)
      .set({ lastMessageAt: row!.createdAt, updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));
    // Replying inside a request thread accepts it (recipient side).
    if (mine.status === "requested") {
      await tx
        .update(conversationParticipants)
        .set({ status: "active", updatedAt: new Date() })
        .where(
          and(
            eq(conversationParticipants.conversationId, conversation.id),
            eq(conversationParticipants.userId, me.id),
          ),
        );
    }
    if (conversation.kind === "dm") {
      // A new message resurfaces a DM the other side had hidden (left).
      await tx
        .update(conversationParticipants)
        .set({ leftAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(conversationParticipants.conversationId, conversation.id),
            ne(conversationParticipants.userId, me.id),
            sql`${conversationParticipants.leftAt} is not null`,
          ),
        );
    }
    return [row!];
  });

  const [wire] = await messageWires(db, [created!], me.id);
  const recipients = others.filter((p) => !p.leftAt).map((p) => p.userId);
  publishToUsers(recipients, {
    type: "message.created",
    conversation_id: conversation.id,
    message: wire,
  });

  // First message into a request inbox also raises a dm_request
  // notification (dedupe folds repeats inside the window).
  if (isFirstMessage) {
    for (const other of others) {
      if (other.status === "requested") {
        await notify(db, {
          recipientId: other.userId,
          type: "dm_request",
          actorId: me.id,
          subjectType: "conversation",
          subjectId: conversation.id,
          payload: { conversation_id: conversation.id, handle: me.handle },
        });
      }
    }
  }
  return wire!;
}

// ─── Read / request lifecycle / membership ───────────────────────────────────

export async function markConversationRead(
  db: Db,
  conversation: ConversationRow,
  me: UserRow,
  messageId: string,
): Promise<void> {
  const mine = await getParticipant(db, conversation.id, me.id);
  if (!mine) throw forbidden("You are not a participant in this conversation");
  const [message] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversation.id)))
    .limit(1);
  if (!message) throw unprocessable("message_id: message is not in this conversation");
  await db
    .update(conversationParticipants)
    .set({ lastReadMessageId: message.id, lastReadAt: message.createdAt, updatedAt: new Date() })
    .where(
      and(
        eq(conversationParticipants.conversationId, conversation.id),
        eq(conversationParticipants.userId, me.id),
      ),
    );
  const others = await activeParticipantIds(db, conversation.id);
  publishToUsers(others, {
    type: "message.read",
    conversation_id: conversation.id,
    message_id: message.id,
    handle: me.handle,
  }, me.id);
}

export async function setRequestStatus(
  db: Db,
  conversation: ConversationRow,
  me: UserRow,
  status: "active" | "declined",
): Promise<ConversationWire> {
  const mine = await getParticipant(db, conversation.id, me.id);
  if (!mine) throw forbidden("You are not a participant in this conversation");
  if (mine.status !== "requested") throw unprocessable("This conversation is not a pending request");
  await db
    .update(conversationParticipants)
    .set({
      status,
      leftAt: status === "declined" ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(conversationParticipants.conversationId, conversation.id),
        eq(conversationParticipants.userId, me.id),
      ),
    );
  return conversationWire(db, conversation, me.id);
}

export async function muteConversation(
  db: Db,
  conversation: ConversationRow,
  me: UserRow,
  mutedUntil: Date | null,
): Promise<ConversationWire> {
  const mine = await getParticipant(db, conversation.id, me.id);
  if (!mine) throw forbidden("You are not a participant in this conversation");
  await db
    .update(conversationParticipants)
    .set({ mutedUntil, updatedAt: new Date() })
    .where(
      and(
        eq(conversationParticipants.conversationId, conversation.id),
        eq(conversationParticipants.userId, me.id),
      ),
    );
  return conversationWire(db, conversation, me.id);
}

export async function leaveConversation(
  db: Db,
  conversation: ConversationRow,
  me: UserRow,
): Promise<void> {
  const mine = await getParticipant(db, conversation.id, me.id);
  if (!mine) throw forbidden("You are not a participant in this conversation");
  await db
    .update(conversationParticipants)
    .set({ leftAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(conversationParticipants.conversationId, conversation.id),
        eq(conversationParticipants.userId, me.id),
      ),
    );
}

export async function addParticipant(
  db: Db,
  conversation: ConversationRow,
  me: UserRow,
  handle: string,
): Promise<ConversationWire> {
  if (conversation.kind !== "group") throw unprocessable("Participants can only be added to group chats");
  const mine = await getParticipant(db, conversation.id, me.id);
  if (!mine || mine.leftAt) throw forbidden("You are not an active participant in this conversation");
  const user = await getUserByHandle(db, handle.replace(/^@/, "").toLowerCase());
  if (!user || user.deletedAt) throw notFound(`User @${handle} not found`);
  const participants = await participantsOf(db, conversation.id);
  const active = participants.filter((p) => !p.leftAt);
  const existing = participants.find((p) => p.userId === user.id);
  if (existing && !existing.leftAt) throw unprocessable("That user is already in this conversation");
  if (active.length + 1 > GROUP_MAX_PARTICIPANTS) {
    throw unprocessable(`Group chats are capped at ${GROUP_MAX_PARTICIPANTS} participants`);
  }
  await assertGroupMinorRule(db, [...active.map((p) => p.userId), user.id]);
  if (existing) {
    await db
      .update(conversationParticipants)
      .set({ leftAt: null, status: "active", updatedAt: new Date() })
      .where(
        and(
          eq(conversationParticipants.conversationId, conversation.id),
          eq(conversationParticipants.userId, user.id),
        ),
      );
  } else {
    await db.insert(conversationParticipants).values({
      conversationId: conversation.id,
      userId: user.id,
      role: "member",
      status: "active",
    });
  }
  return conversationWire(db, conversation, me.id);
}

export async function removeParticipant(
  db: Db,
  conversation: ConversationRow,
  me: UserRow,
  handle: string,
): Promise<void> {
  if (conversation.kind !== "group") throw unprocessable("Participants can only be removed from group chats");
  const mine = await getParticipant(db, conversation.id, me.id);
  if (!mine || mine.leftAt) throw forbidden("You are not an active participant in this conversation");
  const user = await getUserByHandle(db, handle.replace(/^@/, "").toLowerCase());
  if (!user) throw notFound(`User @${handle} not found`);
  const isSelf = user.id === me.id;
  if (!isSelf && mine.role !== "admin") {
    throw forbidden("Only a group admin can remove other participants");
  }
  await db
    .update(conversationParticipants)
    .set({ leftAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(conversationParticipants.conversationId, conversation.id),
        eq(conversationParticipants.userId, user.id),
      ),
    );
}

// ─── Message edit / delete / reactions ───────────────────────────────────────

export async function editMessage(
  db: Db,
  conversation: ConversationRow,
  me: UserRow,
  messageId: string,
  body: string,
): Promise<MessageWire> {
  const mine = await getParticipant(db, conversation.id, me.id);
  if (!mine) throw forbidden("You are not a participant in this conversation");
  const [message] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversation.id)))
    .limit(1);
  if (!message || message.deletedAt) throw notFound("Message not found");
  if (message.senderId !== me.id) throw forbidden("You can only edit your own messages");
  if (body.length > MESSAGE_BODY_MAX) {
    throw unprocessable(`Message body exceeds ${MESSAGE_BODY_MAX} characters`);
  }
  const [updated] = await db
    .update(messages)
    .set({ body, editedAt: new Date(), updatedAt: new Date() })
    .where(eq(messages.id, messageId))
    .returning();
  const [wire] = await messageWires(db, [updated!], me.id);
  const others = await activeParticipantIds(db, conversation.id);
  publishToUsers(others, {
    type: "message.updated",
    conversation_id: conversation.id,
    message: wire,
  }, me.id);
  return wire!;
}

export async function deleteMessage(
  db: Db,
  conversation: ConversationRow,
  me: UserRow,
  messageId: string,
): Promise<void> {
  const mine = await getParticipant(db, conversation.id, me.id);
  if (!mine) throw forbidden("You are not a participant in this conversation");
  const [message] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversation.id)))
    .limit(1);
  if (!message || message.deletedAt) throw notFound("Message not found");
  if (message.senderId !== me.id) throw forbidden("You can only delete your own messages");
  await db
    .update(messages)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(messages.id, messageId));
  const others = await activeParticipantIds(db, conversation.id);
  publishToUsers(others, {
    type: "message.deleted",
    conversation_id: conversation.id,
    message_id: messageId,
  }, me.id);
}

const EMOJI_RE = /^\S{1,16}$/u;

export async function setMessageReaction(
  db: Db,
  conversation: ConversationRow,
  me: UserRow,
  messageId: string,
  emoji: string,
  present: boolean,
): Promise<MessageWire> {
  if (!EMOJI_RE.test(emoji)) throw unprocessable("emoji: must be a single emoji (no spaces, ≤ 16 chars)");
  const mine = await getParticipant(db, conversation.id, me.id);
  if (!mine) throw forbidden("You are not a participant in this conversation");
  const [message] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversation.id)))
    .limit(1);
  if (!message || message.deletedAt) throw notFound("Message not found");
  if (present) {
    await db
      .insert(messageReactions)
      .values({ id: uuidv7(), messageId, userId: me.id, emoji })
      .onConflictDoNothing();
  } else {
    await db
      .delete(messageReactions)
      .where(
        and(
          eq(messageReactions.messageId, messageId),
          eq(messageReactions.userId, me.id),
          eq(messageReactions.emoji, emoji),
        ),
      );
  }
  const [wire] = await messageWires(db, [message], me.id);
  const others = await activeParticipantIds(db, conversation.id);
  publishToUsers(others, {
    type: "message.reaction",
    conversation_id: conversation.id,
    message_id: messageId,
    emoji,
    action: present ? "added" : "removed",
    handle: me.handle,
    reactions: wire!.reactions,
  }, me.id);
  return wire!;
}

/** Publish a realtime typing relay (never persisted, D-048). */
export async function relayTyping(
  db: Db,
  conversation: ConversationRow,
  me: UserRow,
): Promise<void> {
  const mine = await getParticipant(db, conversation.id, me.id);
  if (!mine || mine.leftAt) return;
  const others = await activeParticipantIds(db, conversation.id);
  publishToUsers(others, {
    type: "typing",
    conversation_id: conversation.id,
    handle: me.handle,
  }, me.id);
}
