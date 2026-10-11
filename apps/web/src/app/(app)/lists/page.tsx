"use client";

import type { ListView } from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { EmptyState } from "../../../components/States";
import { api } from "../../../lib/api";
import { RequireAuth, useSession } from "../../../lib/session";

export default function ListsPage() {
  return (
    <RequireAuth>
      <ListsHome />
    </RequireAuth>
  );
}

function ListRow({ list }: { list: ListView }) {
  return (
    <li>
      <Link
        href={`/lists/${list.id}`}
        data-testid="list-row"
        className="block border-b border-border px-4 py-3 transition-colors hover:bg-surface-sunken"
      >
        <span className="flex items-baseline justify-between gap-2">
          <span className="font-semibold">{list.name}</span>
          <span className="text-xs text-text-muted">
            {list.isPublic ? "Public" : "Private"} · {list.memberCount} member
            {list.memberCount === 1 ? "" : "s"}
          </span>
        </span>
        {list.description ? (
          <span className="mt-0.5 block truncate text-sm text-text-muted">
            {list.description}
          </span>
        ) : null}
        <span className="text-xs text-text-muted">by @{list.owner.handle}</span>
      </Link>
    </li>
  );
}

function ListsHome() {
  const { user } = useSession();
  const [mine, setMine] = useState<ListView[]>([]);
  const [discovered, setDiscovered] = useState<ListView[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api
      .getUserLists(user.handle)
      .then((page) => {
        if (!cancelled) setMine(page.items);
      })
      .catch(() => undefined);
    api
      .discoverLists()
      .then((page) => {
        if (!cancelled) setDiscovered(page.items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const list = await api.createList({
        name: name.trim(),
        description: description.trim() || null,
        isPublic,
      });
      setMine((current) => [list, ...current]);
      setName("");
      setDescription("");
      setIsPublic(false);
    } catch (cause) {
      setError(cause instanceof GGApiError ? cause.detail : "Couldn't create that list.");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-bold">Lists</h1>

      <form
        onSubmit={create}
        className="rounded-lg border border-border bg-surface p-4"
        data-testid="list-create-form"
      >
        <h2 className="font-display text-base font-semibold">New list</h2>
        <div className="mt-2 flex flex-col gap-2">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="List name"
            aria-label="List name"
            data-testid="list-name-input"
            className="min-h-11 rounded-md border border-border bg-surface-sunken px-3"
          />
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Description (optional)"
            aria-label="List description"
            data-testid="list-description-input"
            className="min-h-11 rounded-md border border-border bg-surface-sunken px-3"
          />
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(event) => setIsPublic(event.target.checked)}
              data-testid="list-public-toggle"
              className="h-4 w-4 accent-[#ffbf47]"
            />
            Public — anyone can view this list and its timeline
          </label>
          <button
            type="submit"
            disabled={name.trim().length === 0}
            data-testid="list-create-submit"
            className="min-h-11 self-start rounded-full bg-accent px-4 font-semibold text-accent-ink disabled:opacity-40"
          >
            Create list
          </button>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </form>

      <section className="overflow-hidden rounded-lg border border-border bg-surface" aria-label="Your lists">
        <h2 className="border-b border-border px-4 py-3 font-display text-base font-semibold">
          Your lists
        </h2>
        {mine.length === 0 ? (
          <EmptyState
            title="No lists yet"
            body="Group accounts into a list and read just their posts."
            testId="lists-mine-empty"
          />
        ) : (
          <ol>
            {mine.map((list) => (
              <ListRow key={list.id} list={list} />
            ))}
          </ol>
        )}
      </section>

      <section className="overflow-hidden rounded-lg border border-border bg-surface" aria-label="Discover lists">
        <h2 className="border-b border-border px-4 py-3 font-display text-base font-semibold">
          Discover public lists
        </h2>
        {discovered.length === 0 ? (
          <EmptyState
            title="Nothing to discover yet"
            body="Public lists from the community will show up here."
            testId="lists-discover-empty"
          />
        ) : (
          <ol>
            {discovered.map((list) => (
              <ListRow key={list.id} list={list} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
