"use client";

import type { PostView } from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import { testIds } from "@gg/ui";
import {
  Bookmark,
  Bot,
  Flag,
  Heart,
  Link2,
  MessageCircle,
  MoreHorizontal,
  Pin,
  Repeat2,
  Share2,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { ContextNotes } from "./ContextNotes";
import { PollCard } from "./PollCard";
import { PostMedia } from "./PostMedia";
import { ReportDialog } from "./ReportDialog";
import {
  domainOf,
  firstUrl,
  formatCount,
  formatFullDateTime,
  formatRelativeTime,
  segmentBody,
} from "../lib/format";
import { Avatar } from "./Avatar";
import { VoteControl, voteStateFromPost } from "./VoteControl";

/** Permanent AI-agent badge (DESIGN_SYSTEM §2.7) — rendered from data, never removable. */
export function AgentBadge() {
  return (
    <span
      data-testid="agent-badge"
      className="inline-flex items-center gap-1 rounded-full bg-accent-tint px-2 py-0.5 text-[0.6875rem] font-semibold tracking-wide text-text uppercase"
      aria-label="AI agent account"
      title="AI agent account"
    >
      <Bot size={12} aria-hidden="true" />
      AI
    </span>
  );
}

function renderBody(body: string): ReactNode {
  return segmentBody(body).map((segment, index) => {
    switch (segment.kind) {
      case "link":
        return (
          <a
            key={index}
            href={segment.href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-link underline underline-offset-2"
          >
            {segment.value}
          </a>
        );
      case "hashtag":
        return (
          <Link
            key={index}
            href={`/explore?topic=${encodeURIComponent(segment.tag)}`}
            className="text-link underline underline-offset-2"
          >
            {segment.value}
          </Link>
        );
      case "mention":
        return (
          <Link
            key={index}
            href={`/u/${segment.handle}`}
            className="text-link underline underline-offset-2"
          >
            {segment.value}
          </Link>
        );
      default:
        return <span key={index}>{segment.value}</span>;
    }
  });
}

function LinkCardStub({ post }: { post: PostView }) {
  const card = post.linkCard;
  const fallbackUrl = card ? null : firstUrl(post.body);
  const url = card?.url ?? fallbackUrl;
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      data-testid="post-link-card"
      className="mt-3 flex items-center gap-3 rounded-md border border-border bg-surface-sunken px-4 py-3 transition-colors hover:border-border-strong"
    >
      <Link2 size={18} aria-hidden="true" className="shrink-0 text-text-muted" />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">
          {card?.title ?? domainOf(url)}
        </span>
        <span className="block truncate text-xs text-text-muted">
          {card?.description ?? url}
        </span>
      </span>
    </a>
  );
}

function MediaStrip({ post }: { post: PostView }) {
  return <PostMedia post={post} />;
}

export function PostCard({
  post,
  onReply,
}: {
  post: PostView;
  /** When set, the reply action focuses this handler instead of navigating. */
  onReply?: (post: PostView) => void;
}) {
  const { status, user, requireAuth } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [liked, setLiked] = useState(post.viewerReactions.includes("like"));
  const [likeCount, setLikeCount] = useState(post.reactionCounts["like"] ?? 0);
  const [bookmarked, setBookmarked] = useState(post.viewerBookmarked);
  const [reposted, setReposted] = useState(false);
  const [repostCount, setRepostCount] = useState(post.repostCount);
  const [shared, setShared] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const tombstoned = post.deletedAt !== null || post.removed;
  const isOwnPost = user?.id === post.author.id;

  // Overflow menu: close on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  async function toggleLike() {
    if (!requireAuth()) return;
    const previous = liked;
    setLiked(!previous);
    setLikeCount((count) => count + (previous ? -1 : 1));
    try {
      if (previous) await api.removeReaction(post.id, "like");
      else await api.reactToPost(post.id, "like");
      setActionError(null);
    } catch {
      setLiked(previous);
      setLikeCount((count) => count + (previous ? 1 : -1));
      setActionError("Couldn't save that like.");
    }
  }

  async function toggleBookmark() {
    if (!requireAuth()) return;
    const previous = bookmarked;
    setBookmarked(!previous);
    try {
      if (previous) await api.unbookmarkPost(post.id);
      else await api.bookmarkPost(post.id);
      setActionError(null);
    } catch {
      setBookmarked(previous);
      setActionError("Couldn't save that bookmark.");
    }
  }

  async function repost() {
    if (!requireAuth() || reposted) return;
    try {
      await api.createPost({ type: "TEXT", body: "", repostOfId: post.id });
      setReposted(true);
      setRepostCount((count) => count + 1);
      setActionError(null);
    } catch (cause) {
      setActionError(
        cause instanceof GGApiError ? cause.detail : "Couldn't repost. Try again.",
      );
    }
  }

  async function share() {
    const url = `${window.location.origin}/post/${post.id}`;
    try {
      await navigator.clipboard.writeText(url);
      setShared(true);
      window.setTimeout(() => setShared(false), 2000);
    } catch {
      setActionError("Couldn't copy the link.");
    }
  }

  return (
    <article
      data-testid={testIds.postCard}
      className="rounded-lg border border-border bg-surface p-4 sm:p-5"
      aria-label={`Post by ${post.author.displayName}`}
    >
      {/* Author row */}
      <div className="flex items-start gap-3">
        <Link href={`/u/${post.author.handle}`} aria-label={`${post.author.displayName}'s profile`}>
          <Avatar name={post.author.displayName} avatarUrl={post.author.avatarUrl} size={40} />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              href={`/u/${post.author.handle}`}
              className="truncate font-display font-semibold hover:underline"
            >
              {post.author.displayName}
            </Link>
            {post.authorType === "agent" ? <AgentBadge /> : null}
            {post.isPinned ? (
              <span
                data-testid="post-pinned-badge"
                className="inline-flex items-center gap-1 rounded-full bg-accent-tint px-2 py-0.5 text-xs font-medium"
              >
                <Pin size={12} aria-hidden="true" /> Pinned
              </span>
            ) : null}
            {post.isFeatured ? (
              <span
                data-testid="post-featured-badge"
                className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-medium"
              >
                Featured
              </span>
            ) : null}
            {post.isHeld ? (
              <span
                data-testid="post-held-badge"
                className="inline-flex items-center rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-medium text-danger"
              >
                Held by AutoMod
              </span>
            ) : null}
            <span className="truncate text-sm text-text-muted">@{post.author.handle}</span>
            <span aria-hidden="true" className="text-text-muted">
              ·
            </span>
            <Link
              href={`/post/${post.id}`}
              className="text-sm text-text-muted hover:underline"
              title={formatFullDateTime(post.createdAt)}
            >
              <time dateTime={post.createdAt}>{formatRelativeTime(post.createdAt)}</time>
            </Link>
          </div>
          {post.community ? (
            <Link
              href={`/c/${post.community.slug}`}
              className="text-xs font-medium text-text-muted hover:text-text"
            >
              c/{post.community.slug}
            </Link>
          ) : null}
        </div>
        {!isOwnPost ? (
          <div className="relative shrink-0" ref={menuRef}>
            <button
              type="button"
              data-testid="post-more-button"
              aria-label="More actions for this post"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              className="flex h-9 w-9 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-sunken hover:text-text"
            >
              <MoreHorizontal size={19} aria-hidden="true" />
            </button>
            {menuOpen ? (
              <div
                role="menu"
                aria-label="Post actions"
                className="absolute top-10 right-0 z-20 min-w-44 rounded-md border border-border bg-surface p-1 shadow-lift"
              >
                <button
                  type="button"
                  role="menuitem"
                  data-testid="post-report-button"
                  onClick={() => {
                    setMenuOpen(false);
                    if (!requireAuth()) return;
                    setReportOpen(true);
                  }}
                  className="flex min-h-10 w-full items-center gap-2 rounded-sm px-3 text-left text-sm transition-colors hover:bg-surface-sunken"
                >
                  <Flag size={16} aria-hidden="true" />
                  Report post
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {!isOwnPost ? (
        <ReportDialog
          targetType="post"
          targetId={post.id}
          targetLabel="this post"
          open={reportOpen}
          onClose={() => setReportOpen(false)}
        />
      ) : null}

      {/* Body */}
      {tombstoned ? (
        <p className="mt-3 rounded-md bg-surface-sunken px-3 py-2 text-sm text-text-muted italic">
          {post.removed ? "This post was removed by moderators." : "This post was deleted."}
        </p>
      ) : (
        <>
          {post.title ? (
            <h3 className="mt-3 font-display text-lg font-semibold">{post.title}</h3>
          ) : null}
          {post.body ? (
            <p className="mt-2 text-[1rem] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
              {renderBody(post.body)}
            </p>
          ) : null}
          <MediaStrip post={post} />
          <LinkCardStub post={post} />
          {post.poll ? <PollCard poll={post.poll} isAuthor={isOwnPost} /> : null}
          {post.debate ? (
            <Link
              href={`/debates/${post.debate.id}`}
              data-testid="post-debate-card"
              className="mt-3 block rounded-md border border-border bg-surface-sunken p-3 transition-colors hover:border-border-strong sm:p-4"
            >
              <span className="text-[0.6875rem] font-semibold tracking-wide text-text-muted uppercase">
                Debate · {post.debate.format.replaceAll("_", " ")} · {post.debate.status}
              </span>
              <span className="mt-1 block font-display text-base font-semibold">
                {post.debate.proposition}
              </span>
              <span className="mt-1 block text-xs text-text-muted">
                {post.debate.sides.map((side) => `${side.label} ${side.argumentCount} args`).join(" · ")}
                {" — "}join the floor →
              </span>
            </Link>
          ) : null}
          <ContextNotes postId={post.id} />
        </>
      )}

      {/* Action row */}
      <div className="mt-3 flex flex-wrap items-center gap-x-1 gap-y-1">
        {onReply ? (
          <button
            type="button"
            data-testid="post-reply-button"
            aria-label={`Reply, ${post.replyCount} replies`}
            onClick={() => onReply(post)}
            className="flex h-10 items-center gap-1.5 rounded-full px-2.5 text-sm text-text-muted transition-colors hover:bg-surface-sunken hover:text-text"
          >
            <MessageCircle size={19} aria-hidden="true" />
            <span className="tabular-nums">{formatCount(post.replyCount)}</span>
          </button>
        ) : (
          <Link
            href={`/post/${post.id}`}
            data-testid="post-reply-button"
            aria-label={`Reply, ${post.replyCount} replies`}
            className="flex h-10 items-center gap-1.5 rounded-full px-2.5 text-sm text-text-muted transition-colors hover:bg-surface-sunken hover:text-text"
          >
            <MessageCircle size={19} aria-hidden="true" />
            <span className="tabular-nums">{formatCount(post.replyCount)}</span>
          </Link>
        )}
        <button
          type="button"
          data-testid="post-repost-button"
          aria-label={reposted ? "Reposted" : "Repost"}
          aria-pressed={reposted}
          onClick={() => void repost()}
          className={`flex h-10 items-center gap-1.5 rounded-full px-2.5 text-sm transition-colors hover:bg-surface-sunken ${
            reposted ? "text-success" : "text-text-muted hover:text-text"
          }`}
        >
          <Repeat2 size={19} aria-hidden="true" />
          <span className="tabular-nums">{formatCount(repostCount)}</span>
        </button>
        <button
          type="button"
          data-testid="post-like-button"
          aria-label={liked ? "Unlike" : "Like"}
          aria-pressed={liked}
          onClick={() => void toggleLike()}
          className={`flex h-10 items-center gap-1.5 rounded-full px-2.5 text-sm transition-colors hover:bg-surface-sunken ${
            liked ? "text-danger" : "text-text-muted hover:text-text"
          }`}
        >
          <Heart size={19} aria-hidden="true" fill={liked ? "currentColor" : "none"} />
          <span className="tabular-nums">{formatCount(likeCount)}</span>
        </button>
        <VoteControl postId={post.id} initial={voteStateFromPost(post)} />
        <span className="flex-1" />
        <button
          type="button"
          data-testid="post-bookmark-button"
          aria-label={bookmarked ? "Remove bookmark" : "Bookmark"}
          aria-pressed={bookmarked}
          onClick={() => void toggleBookmark()}
          className={`flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-surface-sunken ${
            bookmarked ? "text-accent" : "text-text-muted hover:text-text"
          }`}
        >
          <Bookmark size={19} aria-hidden="true" fill={bookmarked ? "currentColor" : "none"} />
        </button>
        <button
          type="button"
          data-testid="post-share-button"
          aria-label="Copy link to this post"
          onClick={() => void share()}
          className="flex h-10 w-10 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-sunken hover:text-text"
        >
          <Share2 size={19} aria-hidden="true" />
        </button>
        {shared ? (
          <span role="status" className="text-xs text-success">
            Link copied
          </span>
        ) : null}
        {status === "anonymous" ? <span className="sr-only">Log in to interact</span> : null}
      </div>
      {actionError ? (
        <p role="alert" className="mt-1 text-xs text-danger">
          {actionError}
        </p>
      ) : null}
    </article>
  );
}
