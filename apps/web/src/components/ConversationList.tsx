"use client";

import type { ConversationView } from "@gg/sdk";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import { MESSAGES_CHANGED_EVENT } from "../lib/realtime";
import { useSession } from "../lib/session";
import { Avatar } from "./Avatar";
import { EmptyState } from "./States";

export function conversationDisplayTitle(
  conversation: ConversationView,
  myId: string,
): string {
  if (conversation.title) return conversation.title;
  const others = conversation.participants.filter((p) => p.id !== myId);
  if (conversation.kind === "dm") {
    return others[0] ? others[0].displayName : "Conversation";
  }
  return others.map((p) => p.displayName).join(", ") || "Group";
}

function avatarFor(conversation: ConversationView, myId: string) {
  const other = conversation.participants.find((p) => p.id !== myId);
  return other ?? conversation.participants[0];
}

/**
 * Conversation list (Phase 5A): one box (main inbox or requests).
 * Refetches on realtime message events so new DMs surface without a
 * manual refresh; the badge poll keeps it honest if WS is down.
 */
export function ConversationList({ box }: { box: "main" | "requests" }) {
  const { user } = useSession();
  const myId = user?.id ?? "";
  const [items, setItems] = useState<ConversationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api
        .listConversations(box, { limit: 50 })
        .then((page) => {
          if (!cancelled) {
            setItems(page.items);
            setError(null);
          }
        })
        .catch(() => {
          if (!cancelled) setError("Couldn't load conversations.");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    window.addEventListener(MESSAGES_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(MESSAGES_CHANGED_EVENT, load);
    };
  }, [box]);

  if (loading) {
    return <p className="p-4 text-sm text-text-muted" role="status">Loading…</p>;
  }
  if (error) {
    return (
      <p role="alert" className="p-4 text-sm text-danger">
        {error}
      </p>
    );
  }
  if (items.length === 0) {
    return box === "requests" ? (
      <EmptyState
        title="No message requests"
        body="When someone you don't follow writes first, their message lands here for review."
        testId="requests-empty"
      />
    ) : (
      <EmptyState
        title="No conversations yet"
        body="Start one from a profile — tap Message on anyone's page."
        testId="inbox-empty"
      />
    );
  }

  return (
    <ol className="flex flex-col" data-testid={`conversation-list-${box}`}>
      {items.map((conversation) => {
        const avatarUser = avatarFor(conversation, myId);
        const last = conversation.lastMessage;
        return (
          <li key={conversation.id}>
            <Link
              href={`/messages/${conversation.id}`}
              data-testid="conversation-row"
              className="flex items-center gap-3 border-b border-border px-4 py-3 transition-colors hover:bg-surface-sunken"
            >
              {avatarUser ? (
                <Avatar
                  name={avatarUser.displayName}
                  avatarUrl={avatarUser.avatarUrl}
                  size={44}
                />
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-semibold">
                    {conversationDisplayTitle(conversation, myId)}
                  </span>
                  {conversation.lastMessageAt ? (
                    <time className="shrink-0 text-xs text-text-muted">
                      {formatRelativeTime(conversation.lastMessageAt)}
                    </time>
                  ) : null}
                </span>
                <span className="mt-0.5 flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-text-muted">
                    {last
                      ? last.deletedAt
                        ? "Message deleted"
                        : (last.body ??
                          (last.media
                            ? last.media.kind === "audio"
                              ? "🎙 Voice note"
                              : "📎 Attachment"
                            : ""))
                      : "No messages yet"}
                  </span>
                  {conversation.unreadCount > 0 ? (
                    <span
                      data-testid="conversation-unread"
                      className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[0.625rem] font-bold text-accent-ink"
                    >
                      {conversation.unreadCount}
                    </span>
                  ) : null}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
