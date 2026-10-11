"use client";

import type { ConversationView, MessageView } from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import { Ban, BellOff, Flag, LogOut, Pencil, Reply, SmilePlus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { notifyBadgeChanged } from "../lib/badge";
import { formatRelativeTime } from "../lib/format";
import { MESSAGES_CHANGED_EVENT, TYPING_EVENT } from "../lib/realtime";
import { useSession } from "../lib/session";
import { Avatar } from "./Avatar";
import { MessageComposer } from "./MessageComposer";
import { PostCard } from "./PostCard";
import { ReportDialog } from "./ReportDialog";

const QUICK_EMOJI = ["👍", "❤️", "😂", "🔥"];

function conversationTitle(conversation: ConversationView, myId: string): string {
  if (conversation.title) return conversation.title;
  const others = conversation.participants.filter((p) => p.id !== myId);
  if (conversation.kind === "dm") {
    return others[0] ? `@${others[0].handle}` : "Conversation";
  }
  return others.map((p) => `@${p.handle}`).join(", ") || "Group";
}

function MessageMedia({ message }: { message: MessageView }) {
  const media = message.media;
  if (!media?.url) return null;
  if (media.kind === "audio") {
    return (
      <audio
        controls
        src={media.url}
        data-testid="message-audio"
        aria-label="Voice note"
        className="mt-1 w-full max-w-xs"
      />
    );
  }
  if (media.kind === "video") {
    return (
      <video
        controls
        src={media.hlsUrl ?? media.url}
        poster={media.thumbnailUrl ?? undefined}
        data-testid="message-video"
        className="mt-1 max-h-64 w-full max-w-sm rounded-md"
      />
    );
  }
  return (
    <img
      src={media.variants?.medium?.url ?? media.url}
      alt={media.altText ?? ""}
      data-testid="message-image"
      className="mt-1 max-h-64 w-auto max-w-full rounded-md object-cover"
    />
  );
}

/**
 * Thread view (Phase 5A): history + live updates (WS events with a
 * refetch merge), read receipts, reply quotes, emoji reactions,
 * edit/delete own, typing indicator, and the safety actions (block,
 * report, mute, leave) in the header.
 */
export function MessageThread({ conversationId }: { conversationId: string }) {
  const { user } = useSession();
  const myId = user?.id ?? "";
  const [conversation, setConversation] = useState<ConversationView | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<MessageView | null>(null);
  const [typingHandle, setTypingHandle] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [reportMessage, setReportMessage] = useState<MessageView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const mergeMessages = useCallback((incoming: MessageView[]) => {
    setMessages((current) => {
      const byId = new Map(current.map((m) => [m.id, m]));
      for (const message of incoming) byId.set(message.id, message);
      return [...byId.values()].sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
    });
  }, []);

  const markRead = useCallback(
    (list: MessageView[]) => {
      const last = list[list.length - 1];
      if (last && last.sender.id !== myId) {
        void api
          .markConversationRead(conversationId, last.id)
          .then(() => notifyBadgeChanged())
          .catch(() => undefined);
      }
    },
    [conversationId, myId],
  );

  const loadLatest = useCallback(async () => {
    const [convo, page] = await Promise.all([
      api.getConversation(conversationId),
      api.listMessages(conversationId, { limit: 50 }),
    ]);
    setConversation(convo);
    const ascending = [...page.items].reverse();
    mergeMessages(ascending);
    setNextCursor(page.nextCursor);
    markRead(ascending);
  }, [conversationId, markRead, mergeMessages]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadLatest()
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(
            cause instanceof GGApiError ? cause.detail : "Couldn't load this conversation.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadLatest]);

  // Live updates: the realtime bridge dispatches window events.
  useEffect(() => {
    const onMessages = (event: Event) => {
      const detail = (event as CustomEvent<{ conversationId?: string }>).detail;
      if (detail?.conversationId && detail.conversationId !== conversationId) return;
      void loadLatest().catch(() => undefined);
    };
    const onTyping = (event: Event) => {
      const detail = (event as CustomEvent<{ conversationId?: string; handle?: string }>).detail;
      if (!detail || detail.conversationId !== conversationId || !detail.handle) return;
      setTypingHandle(detail.handle);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => setTypingHandle(null), 4000);
    };
    window.addEventListener(MESSAGES_CHANGED_EVENT, onMessages);
    window.addEventListener(TYPING_EVENT, onTyping);
    return () => {
      window.removeEventListener(MESSAGES_CHANGED_EVENT, onMessages);
      window.removeEventListener(TYPING_EVENT, onTyping);
      if (typingTimer.current) clearTimeout(typingTimer.current);
    };
  }, [conversationId, loadLatest]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length]);

  async function loadEarlier() {
    if (!nextCursor) return;
    const page = await api.listMessages(conversationId, { cursor: nextCursor, limit: 50 });
    mergeMessages([...page.items].reverse());
    setNextCursor(page.nextCursor);
  }

  async function toggleReaction(message: MessageView, emoji: string) {
    try {
      const updated = message.viewerReactions.includes(emoji)
        ? await api.unreactToMessage(conversationId, message.id, emoji)
        : await api.reactToMessage(conversationId, message.id, emoji);
      mergeMessages([updated]);
    } catch {
      setNotice("Couldn't save that reaction.");
    }
  }

  async function saveEdit(message: MessageView) {
    try {
      const updated = await api.editMessage(conversationId, message.id, editBody);
      mergeMessages([updated]);
      setEditingId(null);
    } catch (cause) {
      setNotice(cause instanceof GGApiError ? cause.detail : "Couldn't edit that message.");
    }
  }

  async function removeMessage(message: MessageView) {
    try {
      await api.deleteMessage(conversationId, message.id);
      mergeMessages([{ ...message, body: null, media: null, deletedAt: new Date().toISOString() }]);
    } catch {
      setNotice("Couldn't delete that message.");
    }
  }

  const other =
    conversation?.kind === "dm"
      ? conversation.participants.find((p) => p.id !== myId)
      : undefined;

  async function blockOther() {
    if (!other) return;
    try {
      await api.blockUser(other.handle);
      setNotice(`Blocked @${other.handle}. They can't message you anymore.`);
    } catch (cause) {
      setNotice(cause instanceof GGApiError ? cause.detail : "Couldn't block that account.");
    }
  }

  async function toggleMute() {
    if (!conversation) return;
    try {
      const updated = await api.muteConversation(
        conversationId,
        conversation.mutedUntil ? null : new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      );
      setConversation(updated);
      setNotice(updated.mutedUntil ? "Muted for 7 days." : "Unmuted.");
    } catch {
      setNotice("Couldn't update mute.");
    }
  }

  async function leave() {
    try {
      await api.leaveConversation(conversationId);
      window.location.href = "/messages";
    } catch {
      setNotice("Couldn't leave this conversation.");
    }
  }

  if (loading) {
    return <p className="p-4 text-sm text-text-muted" role="status">Loading conversation…</p>;
  }
  if (error || !conversation) {
    return (
      <p role="alert" className="p-4 text-sm text-danger" data-testid="thread-error">
        {error ?? "Conversation not found."}
      </p>
    );
  }

  const lastOwnMessage = [...messages].reverse().find((m) => m.sender.id === myId && !m.deletedAt);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="message-thread">
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-3">
        <Link href="/messages" className="text-sm text-text-muted hover:text-text" aria-label="Back to inbox">
          ←
        </Link>
        <h1 className="min-w-0 flex-1 truncate font-display text-lg font-semibold">
          {conversationTitle(conversation, myId)}
        </h1>
        <button
          type="button"
          onClick={() => void toggleMute()}
          data-testid="conversation-mute-button"
          className="flex min-h-10 items-center gap-1 rounded-full border border-border px-3 text-sm transition-colors hover:bg-surface-sunken"
        >
          <BellOff size={14} aria-hidden="true" />
          {conversation.mutedUntil ? "Unmute" : "Mute"}
        </button>
        {other ? (
          <button
            type="button"
            onClick={() => void blockOther()}
            data-testid="conversation-block-button"
            className="flex min-h-10 items-center gap-1 rounded-full border border-border px-3 text-sm transition-colors hover:bg-surface-sunken"
          >
            <Ban size={14} aria-hidden="true" /> Block
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void leave()}
          data-testid="conversation-leave-button"
          className="flex min-h-10 items-center gap-1 rounded-full border border-border px-3 text-sm transition-colors hover:bg-surface-sunken"
        >
          <LogOut size={14} aria-hidden="true" /> Leave
        </button>
      </header>

      {conversation.status === "requested" ? (
        <div
          className="flex flex-wrap items-center gap-2 bg-accent-tint px-4 py-2 text-sm"
          data-testid="request-banner"
        >
          <span className="flex-1">
            This is a message request. Accept to reply and move it to your inbox.
          </span>
          <button
            type="button"
            data-testid="request-accept"
            onClick={() =>
              void api.acceptConversation(conversationId).then((updated) => {
                setConversation(updated);
                notifyBadgeChanged();
              })
            }
            className="min-h-9 rounded-full bg-accent px-3 font-semibold text-accent-ink"
          >
            Accept
          </button>
          <button
            type="button"
            data-testid="request-decline"
            onClick={() =>
              void api.declineConversation(conversationId).then(() => {
                window.location.href = "/messages";
              })
            }
            className="min-h-9 rounded-full border border-border px-3"
          >
            Decline
          </button>
        </div>
      ) : null}

      {notice ? (
        <p role="status" className="bg-surface-sunken px-4 py-2 text-sm" data-testid="thread-notice">
          {notice}
        </p>
      ) : null}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {nextCursor ? (
          <button
            type="button"
            onClick={() => void loadEarlier()}
            data-testid="messages-load-earlier"
            className="mb-3 w-full rounded-full border border-border py-2 text-sm text-text-muted hover:text-text"
          >
            Load earlier messages
          </button>
        ) : null}
        <ol className="flex flex-col gap-4">
          {messages.map((message) => {
            const own = message.sender.id === myId;
            return (
              <li key={message.id} data-testid="message-row" className="group flex gap-2">
                <Avatar
                  name={message.sender.displayName}
                  avatarUrl={message.sender.avatarUrl}
                  size={32}
                />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-2 text-sm">
                    <Link href={`/u/${message.sender.handle}`} className="font-semibold hover:underline">
                      {message.sender.displayName}
                    </Link>
                    <span className="text-text-muted">@{message.sender.handle}</span>
                    <time className="text-xs text-text-muted">
                      {formatRelativeTime(message.createdAt)}
                    </time>
                    {message.editedAt ? (
                      <span className="text-xs text-text-muted">(edited)</span>
                    ) : null}
                  </p>
                  {message.deletedAt ? (
                    <p className="text-sm text-text-muted italic" data-testid="message-deleted">
                      This message was deleted.
                    </p>
                  ) : (
                    <>
                      {message.replyTo ? (
                        <blockquote className="mt-1 border-l-2 border-border pl-2 text-sm text-text-muted">
                          @{message.replyTo.senderHandle ?? "unknown"}
                          {message.replyTo.body ? `: ${message.replyTo.body}` : ""}
                        </blockquote>
                      ) : null}
                      {message.body ? (
                        <p className="mt-0.5 leading-relaxed whitespace-pre-wrap">{message.body}</p>
                      ) : null}
                      <MessageMedia message={message} />
                      {message.sharedPost ? (
                        <div className="mt-2 max-w-md">
                          <PostCard post={message.sharedPost} />
                        </div>
                      ) : null}
                      {editingId === message.id ? (
                        <form
                          onSubmit={(event) => {
                            event.preventDefault();
                            void saveEdit(message);
                          }}
                          className="mt-1 flex gap-2"
                        >
                          <input
                            value={editBody}
                            onChange={(event) => setEditBody(event.target.value)}
                            data-testid="message-edit-input"
                            aria-label="Edit message"
                            className="min-h-10 flex-1 rounded-md border border-border bg-surface-sunken px-2"
                          />
                          <button type="submit" data-testid="message-edit-save" className="min-h-10 rounded-full bg-accent px-3 font-semibold text-accent-ink">
                            Save
                          </button>
                          <button type="button" onClick={() => setEditingId(null)} className="min-h-10 rounded-full border border-border px-3">
                            Cancel
                          </button>
                        </form>
                      ) : null}
                      {Object.keys(message.reactions).length > 0 ? (
                        <ul className="mt-1 flex flex-wrap gap-1" data-testid="message-reactions">
                          {Object.entries(message.reactions).map(([emoji, count]) => (
                            <li key={emoji}>
                              <button
                                type="button"
                                onClick={() => void toggleReaction(message, emoji)}
                                aria-pressed={message.viewerReactions.includes(emoji)}
                                className={`rounded-full border px-2 py-0.5 text-sm ${
                                  message.viewerReactions.includes(emoji)
                                    ? "border-accent bg-accent-tint"
                                    : "border-border bg-surface-sunken"
                                }`}
                              >
                                {emoji} {count}
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {own && lastOwnMessage?.id === message.id && message.readBy.length > 0 ? (
                        <p className="mt-1 text-xs text-text-muted" data-testid="message-read-by">
                          Read by {message.readBy.map((handle) => `@${handle}`).join(", ")}
                        </p>
                      ) : null}
                    </>
                  )}
                  {!message.deletedAt ? (
                    <div className="mt-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <button
                        type="button"
                        onClick={() => setReplyTo(message)}
                        aria-label="Reply"
                        data-testid="message-reply-button"
                        className="flex h-8 w-8 items-center justify-center rounded-full text-text-muted hover:bg-surface-sunken hover:text-text"
                      >
                        <Reply size={14} aria-hidden="true" />
                      </button>
                      {QUICK_EMOJI.map((emoji) => (
                        <button
                          key={emoji}
                          type="button"
                          onClick={() => void toggleReaction(message, emoji)}
                          aria-label={`React ${emoji}`}
                          data-testid="message-react-button"
                          className="flex h-8 w-8 items-center justify-center rounded-full text-text-muted hover:bg-surface-sunken"
                        >
                          {emoji}
                        </button>
                      ))}
                      <span className="flex h-8 w-8 items-center justify-center text-text-muted">
                        <SmilePlus size={14} aria-hidden="true" />
                      </span>
                      {own ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(message.id);
                              setEditBody(message.body ?? "");
                            }}
                            aria-label="Edit message"
                            data-testid="message-edit-button"
                            className="flex h-8 w-8 items-center justify-center rounded-full text-text-muted hover:bg-surface-sunken hover:text-text"
                          >
                            <Pencil size={14} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void removeMessage(message)}
                            aria-label="Delete message"
                            data-testid="message-delete-button"
                            className="flex h-8 w-8 items-center justify-center rounded-full text-text-muted hover:bg-surface-sunken hover:text-text"
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setReportMessage(message)}
                          aria-label="Report message"
                          data-testid="message-report-button"
                          className="flex h-8 w-8 items-center justify-center rounded-full text-text-muted hover:bg-surface-sunken hover:text-text"
                        >
                          <Flag size={14} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
        {typingHandle ? (
          <p className="mt-2 text-sm text-text-muted" role="status" data-testid="typing-indicator">
            @{typingHandle} is typing…
          </p>
        ) : null}
      </div>

      <MessageComposer
        conversationId={conversationId}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        onSent={(message) => {
          mergeMessages([message]);
          void api.getConversation(conversationId).then(setConversation).catch(() => undefined);
        }}
      />
      {reportMessage ? (
        <ReportDialog
          targetType="message"
          targetId={reportMessage.id}
          targetLabel="this message"
          open={Boolean(reportMessage)}
          onClose={() => setReportMessage(null)}
        />
      ) : null}
    </div>
  );
}
