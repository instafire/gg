"use client";

import type { CollectionView, PostView } from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import { useEffect, useState, type FormEvent } from "react";
import { PostCard } from "../../../components/PostCard";
import { EmptyState } from "../../../components/States";
import { api } from "../../../lib/api";
import { RequireAuth } from "../../../lib/session";

export default function BookmarksPage() {
  return (
    <RequireAuth>
      <Bookmarks />
    </RequireAuth>
  );
}

/**
 * Bookmarks + collections (Phase 5A): the saved-posts list with a
 * collection sidebar — filter by folder, create/rename/delete folders,
 * and move each bookmark between folders.
 */
function Bookmarks() {
  const [collections, setCollections] = useState<CollectionView[]>([]);
  const [selected, setSelected] = useState<string | "all">("all");
  const [posts, setPosts] = useState<PostView[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listCollections()
      .then((page) => {
        if (!cancelled) setCollections(page.items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const load =
      selected === "all" ? api.listBookmarks({ limit: 50 }) : api.getCollectionPosts(selected, { limit: 50 });
    load
      .then((page) => {
        if (!cancelled) setPosts(page.items);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load bookmarks.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  async function createCollection(event: FormEvent) {
    event.preventDefault();
    if (!newName.trim()) return;
    try {
      const created = await api.createCollection({ name: newName.trim() });
      setCollections((current) => [...current, created]);
      setNewName("");
    } catch (cause) {
      setError(cause instanceof GGApiError ? cause.detail : "Couldn't create that collection.");
    }
  }

  async function moveBookmark(post: PostView, collectionId: string) {
    try {
      await api.bookmarkPost(post.id, collectionId || undefined);
      if (selected !== "all") {
        setPosts((current) => current.filter((p) => p.id !== post.id));
      }
      const page = await api.listCollections();
      setCollections(page.items);
    } catch {
      setError("Couldn't move that bookmark.");
    }
  }

  async function deleteCollection(collection: CollectionView) {
    try {
      await api.deleteCollection(collection.id);
      setCollections((current) => current.filter((c) => c.id !== collection.id));
      if (selected === collection.id) setSelected("all");
    } catch {
      setError("Couldn't delete that collection.");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-bold">Bookmarks</h1>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <form
        onSubmit={createCollection}
        className="flex gap-2"
        data-testid="collection-create-form"
      >
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="New collection name"
          aria-label="New collection name"
          data-testid="collection-name-input"
          className="min-h-11 flex-1 rounded-md border border-border bg-surface-sunken px-3"
        />
        <button
          type="submit"
          disabled={newName.trim().length === 0}
          data-testid="collection-create-submit"
          className="min-h-11 rounded-full bg-accent px-4 font-semibold text-accent-ink disabled:opacity-40"
        >
          Create
        </button>
      </form>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Collections">
        <button
          type="button"
          role="tab"
          aria-selected={selected === "all"}
          data-testid="collection-tab-all"
          onClick={() => setSelected("all")}
          className={`min-h-10 rounded-full px-3 text-sm font-medium ${
            selected === "all"
              ? "bg-accent text-accent-ink"
              : "bg-surface-sunken text-text-soft hover:text-text"
          }`}
        >
          All bookmarks
        </button>
        {collections.map((collection) => (
          <span key={collection.id} className="flex items-center gap-1">
            <button
              type="button"
              role="tab"
              aria-selected={selected === collection.id}
              data-testid="collection-tab"
              onClick={() => setSelected(collection.id)}
              className={`min-h-10 rounded-full px-3 text-sm font-medium ${
                selected === collection.id
                  ? "bg-accent text-accent-ink"
                  : "bg-surface-sunken text-text-soft hover:text-text"
              }`}
            >
              {collection.name} ({collection.itemCount})
            </button>
            <button
              type="button"
              onClick={() => void deleteCollection(collection)}
              aria-label={`Delete collection ${collection.name}`}
              data-testid="collection-delete"
              className="flex h-8 w-8 items-center justify-center rounded-full text-text-muted hover:bg-surface-sunken hover:text-danger"
            >
              ×
            </button>
          </span>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-text-muted" role="status">
          Loading bookmarks…
        </p>
      ) : posts.length === 0 ? (
        <EmptyState
          title="Nothing saved here"
          body="Tap the bookmark icon on any post to save it. Collections keep them sorted."
          testId="bookmarks-empty"
        />
      ) : (
        <ol className="flex flex-col gap-3" data-testid="bookmarks-list">
          {posts.map((post) => (
            <li key={post.id}>
              <PostCard post={post} />
              <label className="mt-1 flex items-center gap-2 text-sm text-text-muted">
                Move to
                <select
                  data-testid="bookmark-move-select"
                  defaultValue={selected === "all" ? "" : selected}
                  onChange={(event) => void moveBookmark(post, event.target.value)}
                  className="min-h-9 rounded-md border border-border bg-surface px-2 text-text"
                >
                  <option value="">No collection</option>
                  {collections.map((collection) => (
                    <option key={collection.id} value={collection.id}>
                      {collection.name}
                    </option>
                  ))}
                </select>
              </label>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
