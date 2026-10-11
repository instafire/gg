"use client";

import type { AuthorView, ListView } from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import Link from "next/link";
import { use, useCallback, useEffect, useState, type FormEvent } from "react";
import { Avatar } from "../../../../components/Avatar";
import { FeedList } from "../../../../components/FeedList";
import { EmptyState } from "../../../../components/States";
import { api } from "../../../../lib/api";
import { useSession } from "../../../../lib/session";

export default function ListDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { user } = useSession();
  const [list, setList] = useState<ListView | null>(null);
  const [members, setMembers] = useState<AuthorView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newMember, setNewMember] = useState("");
  const [memberError, setMemberError] = useState<string | null>(null);

  const isOwner = Boolean(list && user && list.owner.id === user.id);

  const reload = useCallback(async () => {
    const [freshList, freshMembers] = await Promise.all([
      api.getList(id),
      api.getListMembers(id),
    ]);
    setList(freshList);
    setMembers(freshMembers);
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    reload().catch((cause: unknown) => {
      if (!cancelled) {
        setError(cause instanceof GGApiError ? cause.detail : "Couldn't load this list.");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const fetchTimeline = useCallback(
    (cursor: string | undefined) => api.getListTimeline(id, { cursor, limit: 20 }),
    [id],
  );

  async function addMember(event: FormEvent) {
    event.preventDefault();
    const handle = newMember.trim().replace(/^@/, "");
    if (!handle) return;
    setMemberError(null);
    try {
      const updated = await api.addListMember(id, handle);
      setList(updated);
      setNewMember("");
      setMembers(await api.getListMembers(id));
    } catch (cause) {
      setMemberError(cause instanceof GGApiError ? cause.detail : "Couldn't add that member.");
    }
  }

  async function removeMember(handle: string) {
    try {
      await api.removeListMember(id, handle);
      await reload();
    } catch (cause) {
      setMemberError(cause instanceof GGApiError ? cause.detail : "Couldn't remove that member.");
    }
  }

  async function togglePublic() {
    if (!list) return;
    try {
      setList(await api.updateList(id, { isPublic: !list.isPublic }));
    } catch {
      setMemberError("Couldn't update visibility.");
    }
  }

  async function deleteList() {
    try {
      await api.deleteList(id);
      window.location.href = "/lists";
    } catch {
      setMemberError("Couldn't delete this list.");
    }
  }

  if (error) {
    return (
      <EmptyState
        title="List unavailable"
        body={error}
        testId="list-not-found"
      />
    );
  }
  if (!list) {
    return <p className="p-4 text-sm text-text-muted" role="status">Loading list…</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border border-border bg-surface p-5" data-testid="list-header">
        <h1 className="font-display text-2xl font-bold">{list.name}</h1>
        <p className="text-sm text-text-muted">
          by{" "}
          <Link href={`/u/${list.owner.handle}`} className="hover:underline">
            @{list.owner.handle}
          </Link>{" "}
          · {list.isPublic ? "Public" : "Private"} · {list.memberCount} member
          {list.memberCount === 1 ? "" : "s"}
        </p>
        {list.description ? <p className="mt-2 leading-relaxed">{list.description}</p> : null}
        {isOwner ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void togglePublic()}
              data-testid="list-toggle-public"
              className="min-h-10 rounded-full border border-border px-3 text-sm transition-colors hover:bg-surface-sunken"
            >
              Make {list.isPublic ? "private" : "public"}
            </button>
            <button
              type="button"
              onClick={() => void deleteList()}
              data-testid="list-delete"
              className="min-h-10 rounded-full border border-border px-3 text-sm text-danger transition-colors hover:bg-surface-sunken"
            >
              Delete list
            </button>
          </div>
        ) : null}
      </section>

      <section className="rounded-lg border border-border bg-surface p-4" aria-label="Members">
        <h2 className="font-display text-base font-semibold">Members</h2>
        {members.length === 0 ? (
          <p className="mt-1 text-sm text-text-muted">No members yet.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {members.map((member) => (
              <li key={member.id} className="flex items-center gap-2" data-testid="list-member-row">
                <Avatar name={member.displayName} avatarUrl={member.avatarUrl} size={32} />
                <Link href={`/u/${member.handle}`} className="flex-1 font-medium hover:underline">
                  {member.displayName}{" "}
                  <span className="text-sm text-text-muted">@{member.handle}</span>
                </Link>
                {isOwner ? (
                  <button
                    type="button"
                    onClick={() => void removeMember(member.handle)}
                    data-testid="list-member-remove"
                    className="min-h-9 rounded-full border border-border px-3 text-sm hover:bg-surface-sunken"
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {isOwner ? (
          <form onSubmit={addMember} className="mt-3 flex gap-2" data-testid="list-member-form">
            <input
              value={newMember}
              onChange={(event) => setNewMember(event.target.value)}
              placeholder="@handle to add"
              aria-label="Handle to add"
              data-testid="list-member-input"
              className="min-h-11 flex-1 rounded-md border border-border bg-surface-sunken px-3"
            />
            <button
              type="submit"
              disabled={newMember.trim().length === 0}
              data-testid="list-member-add"
              className="min-h-11 rounded-full bg-accent px-4 font-semibold text-accent-ink disabled:opacity-40"
            >
              Add
            </button>
          </form>
        ) : null}
        {memberError ? (
          <p role="alert" className="mt-2 text-sm text-danger">
            {memberError}
          </p>
        ) : null}
      </section>

      <section aria-label="List timeline">
        <h2 className="mb-2 font-display text-lg font-semibold">Timeline</h2>
        <FeedList
          fetchPage={fetchTimeline}
          resetKey={members.map((m) => m.id).join(",")}
          emptyTitle="No posts from members yet"
          emptyBody="When list members post, their takes land here."
        />
      </section>
    </div>
  );
}
