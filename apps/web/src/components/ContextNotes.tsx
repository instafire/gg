"use client";

import type { ContextNoteView } from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import { Info, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useSession } from "../lib/session";

/**
 * Community context notes under a post (Phase 3, D-033). A note becomes
 * publicly visible only when raters from BOTH sides of the stance spectrum
 * rate it helpful — the bridging rule is explained in the UI copy so the
 * mechanism is transparent, not magic.
 */
export function ContextNotes({ postId }: { postId: string }) {
  const { status, requireAuth } = useSession();
  const [notes, setNotes] = useState<ContextNoteView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [body, setBody] = useState("");
  const [sources, setSources] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    try {
      const page = await api.listNotes(postId);
      setNotes(page.items);
    } catch {
      setNotes([]);
    } finally {
      setLoaded(true);
    }
  }, [postId]);

  // Feed cards mount dozens of posts: fetch notes only when the card is
  // about to be seen, not on mount.
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      void load();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          void load();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [load]);

  async function propose() {
    if (!requireAuth()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createNote(postId, {
        body: body.trim(),
        sources: sources
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      });
      setBody("");
      setSources("");
      setFormOpen(false);
      await load();
    } catch (cause) {
      setError(cause instanceof GGApiError ? cause.detail : "Couldn't propose that note.");
    } finally {
      setBusy(false);
    }
  }

  async function rate(noteId: string, rating: "helpful" | "not_helpful") {
    if (!requireAuth()) return;
    try {
      await api.rateNote(noteId, rating);
      await load();
    } catch (cause) {
      setError(cause instanceof GGApiError ? cause.detail : "Couldn't save that rating.");
    }
  }

  if (!loaded) {
    return <div ref={rootRef} aria-hidden="true" />;
  }

  return (
    <div ref={rootRef} className="mt-3" data-testid="context-notes">
      {notes.map((note) => (
        <article
          key={note.id}
          className={`rounded-md border p-3 ${
            note.status === "helpful"
              ? "border-accent bg-accent-tint"
              : "border-border bg-surface-sunken"
          }`}
        >
          <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase">
            <Info size={13} aria-hidden="true" />
            Context note
            {note.status !== "helpful" ? (
              <span className="font-normal normal-case text-text-muted">
                · {note.status.replaceAll("_", " ")} — visible to you while it's rated
              </span>
            ) : null}
          </p>
          <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap">{note.body}</p>
          {note.sources.length > 0 ? (
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {note.sources.map((source) => (
                <li key={source} className="truncate text-xs">
                  <a href={source} target="_blank" rel="noreferrer noopener" className="text-link underline underline-offset-2">
                    {source}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-1 text-xs text-text-muted">by @{note.author.handle}</p>
          {status === "authenticated" ? (
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => void rate(note.id, "helpful")}
                className="min-h-8 rounded-full border border-border bg-surface px-3 text-xs font-medium hover:border-border-strong"
              >
                Helpful
              </button>
              <button
                type="button"
                onClick={() => void rate(note.id, "not_helpful")}
                className="min-h-8 rounded-full border border-border bg-surface px-3 text-xs font-medium hover:border-border-strong"
              >
                Not helpful
              </button>
            </div>
          ) : null}
        </article>
      ))}

      {status === "authenticated" ? (
        formOpen ? (
          <div className="mt-2 rounded-md border border-border bg-surface-sunken p-3">
            <label className="block text-sm font-medium" htmlFor={`note-body-${postId}`}>
              Propose a context note
            </label>
            <textarea
              id={`note-body-${postId}`}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={3}
              maxLength={500}
              placeholder="Add missing context — neutrally, with sources. Notes appear publicly when people across viewpoints rate them helpful."
              className="mt-1 w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm placeholder:text-text-muted"
            />
            <label className="mt-2 block text-sm font-medium" htmlFor={`note-sources-${postId}`}>
              Source URLs (one per line)
            </label>
            <textarea
              id={`note-sources-${postId}`}
              value={sources}
              onChange={(event) => setSources(event.target.value)}
              rows={2}
              placeholder="https://…"
              className="mt-1 w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm placeholder:text-text-muted"
            />
            {error ? (
              <p role="alert" className="mt-1 text-xs text-danger">
                {error}
              </p>
            ) : null}
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={busy || body.trim().length < 10}
                onClick={() => void propose()}
                className="min-h-10 rounded-md bg-accent px-4 text-sm font-semibold text-black disabled:opacity-40"
              >
                Propose note
              </button>
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="min-h-10 rounded-md px-3 text-sm text-text-muted hover:text-text"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setFormOpen(true)}
            className="mt-1 inline-flex min-h-8 items-center gap-1 text-xs font-medium text-text-muted hover:text-text"
          >
            <Plus size={13} aria-hidden="true" /> Add context
          </button>
        )
      ) : null}
      {error && !formOpen ? (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
