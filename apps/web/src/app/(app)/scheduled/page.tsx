"use client";

import type { PostView } from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import { useEffect, useState } from "react";
import { PostCard } from "../../../components/PostCard";
import { EmptyState } from "../../../components/States";
import { api } from "../../../lib/api";
import { formatFullDateTime } from "../../../lib/format";
import { RequireAuth } from "../../../lib/session";

export default function ScheduledPage() {
  return (
    <RequireAuth>
      <Scheduled />
    </RequireAuth>
  );
}

/**
 * Scheduled posts (Phase 5A, D-050): everything queued, with edit-time,
 * publish-now, and delete. Published by the worker within a minute of
 * the scheduled time.
 */
function Scheduled() {
  const [posts, setPosts] = useState<PostView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [times, setTimes] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    api
      .getScheduledPosts()
      .then((page) => {
        if (!cancelled) setPosts(page.items);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load scheduled posts.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function publishNow(post: PostView) {
    try {
      await api.updatePost(post.id, { scheduledFor: null });
      setPosts((current) => current.filter((p) => p.id !== post.id));
    } catch (cause) {
      setError(cause instanceof GGApiError ? cause.detail : "Couldn't publish that post.");
    }
  }

  async function reschedule(post: PostView) {
    const value = times[post.id];
    if (!value) return;
    try {
      const updated = await api.updatePost(post.id, {
        scheduledFor: new Date(value).toISOString(),
      });
      setPosts((current) => current.map((p) => (p.id === post.id ? updated : p)));
    } catch (cause) {
      setError(cause instanceof GGApiError ? cause.detail : "Couldn't reschedule that post.");
    }
  }

  async function remove(post: PostView) {
    try {
      await api.deletePost(post.id);
      setPosts((current) => current.filter((p) => p.id !== post.id));
    } catch {
      setError("Couldn't delete that post.");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-bold">Scheduled posts</h1>
      <p className="text-sm text-text-muted">
        Queued posts publish automatically at their time — nobody else can see them until then.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p className="text-sm text-text-muted" role="status">
          Loading…
        </p>
      ) : posts.length === 0 ? (
        <EmptyState
          title="Nothing scheduled"
          body="Use the Schedule option in the composer to queue a post for later."
          testId="scheduled-empty"
        />
      ) : (
        <ol className="flex flex-col gap-3" data-testid="scheduled-list">
          {posts.map((post) => (
            <li key={post.id} className="rounded-lg border border-border bg-surface">
              <PostCard post={post} />
              <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
                <span className="text-sm text-text-muted" data-testid="scheduled-for-label">
                  Publishes {post.scheduledFor ? formatFullDateTime(post.scheduledFor) : ""}
                </span>
                <span className="flex-1" />
                <input
                  type="datetime-local"
                  aria-label={`New time for post ${post.id}`}
                  data-testid="scheduled-time-input"
                  value={times[post.id] ?? ""}
                  onChange={(event) =>
                    setTimes((current) => ({ ...current, [post.id]: event.target.value }))
                  }
                  className="min-h-10 rounded-md border border-border bg-surface-sunken px-2 text-sm"
                />
                <button
                  type="button"
                  onClick={() => void reschedule(post)}
                  disabled={!times[post.id]}
                  data-testid="scheduled-reschedule"
                  className="min-h-10 rounded-full border border-border px-3 text-sm disabled:opacity-40"
                >
                  Reschedule
                </button>
                <button
                  type="button"
                  onClick={() => void publishNow(post)}
                  data-testid="scheduled-publish-now"
                  className="min-h-10 rounded-full bg-accent px-3 text-sm font-semibold text-accent-ink"
                >
                  Publish now
                </button>
                <button
                  type="button"
                  onClick={() => void remove(post)}
                  data-testid="scheduled-delete"
                  className="min-h-10 rounded-full border border-border px-3 text-sm text-danger"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
