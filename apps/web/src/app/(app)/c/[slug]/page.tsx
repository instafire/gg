"use client";

import type { CommunityPostSort, CommunityView } from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import { Button } from "@gg/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import { FeedList } from "../../../../components/FeedList";
import { JoinButton } from "../../../../components/FollowButton";
import { ApiErrorState, EmptyState, FeedSkeleton } from "../../../../components/States";
import { api } from "../../../../lib/api";
import { formatCount } from "../../../../lib/format";

const SORTS: { id: CommunityPostSort; label: string }[] = [
  { id: "hot", label: "Hot" },
  { id: "new", label: "New" },
  { id: "top", label: "Top" },
];

export default function CommunityPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const router = useRouter();
  const [community, setCommunity] = useState<CommunityView | null>(null);
  const [mailOpen, setMailOpen] = useState(false);
  const [mailBody, setMailBody] = useState("");
  const [mailError, setMailError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<CommunityPostSort>("hot");
  const [memberCount, setMemberCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getCommunity(slug)
      .then((result) => {
        if (cancelled) return;
        setCommunity(result);
        setMemberCount(result.memberCount);
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
  }, [slug]);

  const fetchPosts = useCallback(
    (cursor: string | undefined) => api.listCommunityPosts(slug, { cursor, limit: 20, sort }),
    [slug, sort],
  );

  if (loading) return <FeedSkeleton count={2} />;

  if (error || !community) {
    const notFound = error instanceof GGApiError && error.status === 404;
    return notFound ? (
      <EmptyState
        title="Community not found"
        body={`c/${slug} doesn't exist (yet).`}
        testId="community-not-found"
      />
    ) : (
      <ApiErrorState error={error} />
    );
  }

  const isMember = community.viewerMembership?.status === "active";
  const viewerRole = community.viewerMembership?.role;
  const isMod =
    viewerRole === "owner" || viewerRole === "admin" || viewerRole === "moderator";

  async function sendModMail() {
    setMailError(null);
    try {
      const thread = await api.sendModMail(slug, { body: mailBody.trim() });
      router.push(`/messages/${thread.id}`);
    } catch (cause) {
      setMailError(
        cause instanceof GGApiError ? cause.detail : "Couldn't send mod mail.",
      );
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section
        data-testid="community-header"
        className="rounded-lg border border-border bg-surface p-5"
        aria-label={`Community ${community.name}`}
      >
        <div className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-accent-tint font-display text-2xl font-bold"
          >
            {community.name.trim()[0]?.toUpperCase() ?? "?"}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-2xl font-bold">{community.name}</h1>
            <p className="text-sm text-text-muted">c/{community.slug}</p>
            {community.description ? (
              <p className="mt-2 leading-relaxed">{community.description}</p>
            ) : null}
            <p className="mt-3 text-sm">
              <strong className="font-mono tabular-nums">{formatCount(memberCount)}</strong>{" "}
              <span className="text-text-muted">members</span>
              <span aria-hidden="true" className="mx-2 text-text-muted">
                ·
              </span>
              <strong className="font-mono tabular-nums">
                {formatCount(community.postCount)}
              </strong>{" "}
              <span className="text-text-muted">posts</span>
            </p>
          </div>
          <JoinButton
            slug={community.slug}
            initialMember={isMember}
            onChange={(member) => setMemberCount((count) => count + (member ? 1 : -1))}
          />
        </div>
        {community.lockdownActive ? (
          <p
            data-testid="community-lockdown-banner"
            className="mt-3 rounded-md bg-surface-sunken px-3 py-2 text-sm"
          >
            This community is in lockdown — only moderators and members who
            joined before the lockdown can post.
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          {isMod ? (
            <Link
              href={`/c/${community.slug}/mod`}
              data-testid="community-mod-link"
              className="inline-flex min-h-11 items-center rounded-full bg-surface-sunken px-4 font-medium hover:text-text"
            >
              Moderate
            </Link>
          ) : null}
          {isMember ? (
            <button
              type="button"
              data-testid="community-modmail-open"
              onClick={() => setMailOpen((open) => !open)}
              className="inline-flex min-h-11 items-center rounded-full bg-surface-sunken px-4 font-medium hover:text-text"
            >
              Message the mods
            </button>
          ) : null}
        </div>
        {mailOpen ? (
          <div className="mt-3 flex flex-col gap-2">
            <label htmlFor="modmail-body" className="sr-only">
              Message to the moderators
            </label>
            <textarea
              id="modmail-body"
              value={mailBody}
              onChange={(event) => setMailBody(event.target.value)}
              rows={3}
              maxLength={4000}
              className="w-full rounded-md border border-border bg-surface-sunken px-3 py-2"
              placeholder="Ask the mod team about this community…"
              data-testid="community-modmail-body"
            />
            {mailError ? (
              <p role="alert" className="text-sm text-danger">
                {mailError}
              </p>
            ) : null}
            <div>
              <Button
                disabled={!mailBody.trim()}
                onClick={() => void sendModMail()}
                data-testid="community-modmail-send"
              >
                Send to mods
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <div role="tablist" aria-label="Community sort" className="flex gap-2">
        {SORTS.map((option) => (
          <button
            key={option.id}
            role="tab"
            aria-selected={sort === option.id}
            data-testid={`community-sort-${option.id}`}
            onClick={() => setSort(option.id)}
            className={`min-h-11 rounded-full px-4 font-medium transition-colors ${
              sort === option.id
                ? "bg-accent text-accent-ink"
                : "bg-surface-sunken text-text-soft hover:text-text"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <FeedList
        fetchPage={fetchPosts}
        resetKey={`${slug}:${sort}`}
        emptyTitle="Nothing here yet"
        emptyBody={`Be the first take in c/${community.slug}.`}
      />
    </div>
  );
}
