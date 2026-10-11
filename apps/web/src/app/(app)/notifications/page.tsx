"use client";

import type { NotificationType, NotificationView } from "@gg/sdk";
import { Button } from "@gg/ui";
import {
  AtSign,
  Bell,
  Info,
  Mail,
  MessageCircle,
  Shield,
  Swords,
  TrendingUp,
  UserPlus,
  Vote,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Avatar } from "../../../components/Avatar";
import { ApiErrorState, EmptyState, FeedSkeleton } from "../../../components/States";
import { api } from "../../../lib/api";
import { notifyBadgeChanged } from "../../../lib/badge";
import { formatRelativeTime } from "../../../lib/format";
import { RequireAuth, useSession } from "../../../lib/session";

type IconComponent = typeof Bell;

const TYPE_ICONS: Record<NotificationType, IconComponent> = {
  reply: MessageCircle,
  mention: AtSign,
  follow: UserPlus,
  vote_digest: TrendingUp,
  debate_challenge: Swords,
  debate_turn: Swords,
  poll_closing: Vote,
  mod_action: Shield,
  dm_request: Mail,
  system: Info,
};

function describe(notification: NotificationView): string {
  const actor = notification.actor ? `@${notification.actor.handle}` : "Someone";
  const payload = notification.payload;
  switch (notification.type) {
    case "follow":
      return `${actor} followed you`;
    case "reply":
      return `${actor} replied to your post`;
    case "mention":
      return `${actor} mentioned you`;
    case "vote_digest":
      return `Your post reached ${String(payload.milestone ?? "")} upvotes`;
    case "debate_challenge":
      return `${actor} challenged you to a debate`;
    case "debate_turn":
      return "It's your turn in a debate";
    case "poll_closing":
      return "A poll you voted on is closing";
    case "mod_action":
      return "A moderator took an action on your content";
    case "dm_request":
      return `${actor} wants to message you`;
    case "system":
      if (payload.kind === "join_request") {
        return `${actor} asked to join ${String(payload.community_name ?? "a community")}`;
      }
      return "System notification";
    default:
      return "Notification";
  }
}

/** Where a notification click lands (null = not navigable). */
function targetHref(notification: NotificationView): string | null {
  const payload = notification.payload;
  if (notification.type === "follow" && notification.actor) {
    return `/u/${notification.actor.handle}`;
  }
  if (notification.subjectType === "post" && notification.subjectId) {
    return `/post/${notification.subjectId}`;
  }
  if (notification.subjectType === "community" && typeof payload.community_slug === "string") {
    return `/c/${payload.community_slug}`;
  }
  if (notification.subjectType === "user" && notification.actor) {
    return `/u/${notification.actor.handle}`;
  }
  return null;
}

export default function NotificationsPage() {
  return (
    <RequireAuth>
      <NotificationsList />
    </RequireAuth>
  );
}

function NotificationsList() {
  const router = useRouter();
  const { status } = useSession();
  const [items, setItems] = useState<NotificationView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.listNotifications({ limit: 30 });
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setUnreadCount(page.unreadCount);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === "authenticated") void loadFirst();
  }, [status, loadFirst]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.listNotifications({ cursor: nextCursor, limit: 30 });
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
      setUnreadCount(page.unreadCount);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoadingMore(false);
    }
  }

  async function markAllRead() {
    try {
      await api.markNotificationsRead();
      setItems((current) =>
        current.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })),
      );
      setUnreadCount(0);
      notifyBadgeChanged();
    } catch (cause) {
      setError(cause);
    }
  }

  async function open(notification: NotificationView) {
    if (!notification.readAt) {
      try {
        await api.markNotificationsRead({ ids: [notification.id] });
        setItems((current) =>
          current.map((n) =>
            n.id === notification.id ? { ...n, readAt: new Date().toISOString() } : n,
          ),
        );
        setUnreadCount((count) => Math.max(0, count - 1));
        notifyBadgeChanged();
      } catch {
        // Navigation matters more than the read flag; carry on.
      }
    }
    const href = targetHref(notification);
    if (href) router.push(href);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">Notifications</h1>
        <Button
          variant="ghost"
          onClick={() => void markAllRead()}
          disabled={unreadCount === 0}
          data-testid="notifications-mark-all-read"
        >
          Mark all read
        </Button>
      </div>

      {loading ? (
        <FeedSkeleton count={3} />
      ) : error && items.length === 0 ? (
        <ApiErrorState error={error} onRetry={() => void loadFirst()} />
      ) : items.length === 0 ? (
        <EmptyState
          title="Nothing yet"
          body="Replies, mentions, follows and debate turns will collect here."
          testId="notifications-empty"
        />
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {items.map((notification) => {
              const Icon = TYPE_ICONS[notification.type] ?? Bell;
              const unread = notification.readAt === null;
              const excerpt =
                typeof notification.payload.excerpt === "string"
                  ? notification.payload.excerpt
                  : null;
              return (
                <li key={notification.id}>
                  <button
                    type="button"
                    onClick={() => void open(notification)}
                    data-testid="notification-item"
                    aria-label={`${describe(notification)}${unread ? " (unread)" : ""}`}
                    className={`flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors ${
                      unread
                        ? "border-accent/50 bg-accent-tint/40"
                        : "border-border bg-surface hover:border-border-strong"
                    }`}
                  >
                    <span className="relative shrink-0">
                      {notification.actor ? (
                        <Avatar
                          name={notification.actor.displayName}
                          avatarUrl={notification.actor.avatarUrl}
                          size={40}
                        />
                      ) : (
                        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-sunken">
                          <Icon size={18} aria-hidden="true" />
                        </span>
                      )}
                      {unread ? (
                        <span
                          aria-hidden="true"
                          className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-accent"
                        />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <Icon
                          size={14}
                          aria-hidden="true"
                          className="shrink-0 text-text-muted"
                        />
                        <span className="truncate font-medium">{describe(notification)}</span>
                        {notification.groupCount > 1 ? (
                          <span className="shrink-0 rounded-full bg-surface-sunken px-1.5 py-0.5 text-xs font-semibold">
                            ×{notification.groupCount}
                          </span>
                        ) : null}
                      </span>
                      {excerpt ? (
                        <span className="mt-1 line-clamp-2 block text-sm text-text-soft">
                          {excerpt}
                        </span>
                      ) : null}
                      <span className="mt-1 block text-xs text-text-muted">
                        {formatRelativeTime(notification.createdAt)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {error ? <ApiErrorState error={error} onRetry={() => void loadMore()} /> : null}
          {nextCursor ? (
            <div className="flex justify-center">
              <Button
                variant="ghost"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                data-testid="notifications-load-more"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
