"use client";

import type { PostView, ThreadView } from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import { Button } from "@gg/ui";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PostCard } from "../../../../components/PostCard";
import { PostComposer } from "../../../../components/PostComposer";
import { ApiErrorState, EmptyState, FeedSkeleton } from "../../../../components/States";
import { api } from "../../../../lib/api";
import { useSession } from "../../../../lib/session";

/**
 * Thread view. Receives the server-rendered thread (D-024) and renders it
 * immediately; once the session resolves to an authenticated user it
 * refetches in the background to patch viewer-specific state. Falls back
 * to the classic client fetch when the server render failed.
 */
export function ThreadClient({
  id,
  initialThread,
  initialErrorStatus,
}: {
  id: string;
  initialThread: ThreadView | null;
  initialErrorStatus: number | null;
}) {
  const { status } = useSession();
  const [thread, setThread] = useState<ThreadView | null>(initialThread);
  const [error, setError] = useState<unknown>(
    initialThread
      ? null
      : new GGApiError(initialErrorStatus ?? 0, "Couldn't load this thread", {
          isNetworkError: (initialErrorStatus ?? 0) === 0,
        }),
  );
  const [loading, setLoading] = useState(!initialThread && initialErrorStatus === null);
  const [reloadKey, setReloadKey] = useState(0);
  const viewerPatchedFor = useRef<string | null>(null);

  // No server payload (server fetch failed): classic client fetch, and the
  // retry path for the error state.
  useEffect(() => {
    if (initialThread && reloadKey === 0) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getThread(id)
      .then((result) => {
        if (!cancelled) setThread(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, reloadKey, initialThread]);

  // Patch viewer state once the session is known-authenticated.
  useEffect(() => {
    if (!initialThread || status !== "authenticated") return;
    if (viewerPatchedFor.current === id) return;
    viewerPatchedFor.current = id;
    let cancelled = false;
    api
      .getThread(id)
      .then((result) => {
        if (!cancelled) setThread(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id, status, initialThread]);

  const onReplyPosted = useCallback((post: PostView) => {
    setThread((current) =>
      current
        ? {
            ...current,
            replies: {
              items: [post, ...current.replies.items],
              nextCursor: current.replies.nextCursor,
            },
          }
        : current,
    );
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <FeedSkeleton count={2} />
      </div>
    );
  }

  if (error || !thread) {
    const notFound = error instanceof GGApiError && error.status === 404;
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        {notFound ? (
          <EmptyState
            title="Post not found"
            body="It may have been deleted, or the link is wrong."
            testId="post-not-found"
          />
        ) : (
          <ApiErrorState error={error} onRetry={() => setReloadKey((key) => key + 1)} />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <BackLink />
      {thread.ancestors.map((ancestor) => (
        <PostCard key={ancestor.id} post={ancestor} />
      ))}
      <div data-testid="thread-focus">
        <PostCard post={thread.focus} />
      </div>
      <PostComposer
        parentId={thread.focus.id}
        placeholder="Add your reply…"
        submitLabel="Reply"
        onPosted={onReplyPosted}
      />
      <section aria-label="Replies" className="flex flex-col gap-3">
        <h2 className="font-display text-lg font-semibold">Replies</h2>
        {thread.replies.items.length === 0 ? (
          <EmptyState title="No replies yet" body="Start the argument." testId="replies-empty" />
        ) : (
          thread.replies.items.map((reply) => (
            <ThreadNode key={reply.id} post={reply} depth={0} />
          ))
        )}
      </section>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/home"
      className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-text-soft hover:text-text"
    >
      <ArrowLeft size={18} aria-hidden="true" />
      Back
    </Link>
  );
}

/**
 * One reply plus its lazily loaded branch. "Load replies" pages the direct
 * children of this post; nesting is shown by indentation (depth-capped).
 */
function ThreadNode({ post, depth }: { post: PostView; depth: number }) {
  const [children, setChildren] = useState<PostView[]>([]);
  const [childCursor, setChildCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [childError, setChildError] = useState<string | null>(null);

  const loadChildren = useCallback(async () => {
    setLoading(true);
    setChildError(null);
    try {
      const page = await api.listReplies(post.id, {
        cursor: loaded && childCursor ? childCursor : undefined,
        limit: 10,
      });
      setChildren((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !seen.has(item.id))];
      });
      setChildCursor(page.nextCursor);
      setLoaded(true);
    } catch {
      setChildError("Couldn't load replies.");
    } finally {
      setLoading(false);
    }
  }, [post.id, loaded, childCursor]);

  const hasMore = !loaded || childCursor !== null;
  const indent = Math.min(depth, 6) * 16;

  return (
    <div style={{ marginInlineStart: indent }} className="flex flex-col gap-3">
      <PostCard post={post} />
      {children.map((child) => (
        <ThreadNode key={child.id} post={child} depth={depth + 1} />
      ))}
      {post.replyCount > 0 && hasMore ? (
        <div>
          <Button
            variant="ghost"
            onClick={() => void loadChildren()}
            disabled={loading}
            data-testid="load-more-replies"
          >
            {loading
              ? "Loading…"
              : loaded
                ? "Load more replies"
                : `Load replies (${post.replyCount})`}
          </Button>
          {childError ? (
            <p role="alert" className="mt-1 text-xs text-danger">
              {childError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
