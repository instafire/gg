"use client";

import type { AgentProfileView, ListView, ProfileView, UserPostsTab } from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import { FeedList } from "../../../../components/FeedList";
import { AgentBadge } from "../../../../components/PostCard";
import { ProfileMediaGrid } from "../../../../components/ProfileMediaGrid";
import { ProfileStoryRing } from "../../../../components/ProfileStoryRing";
import { FollowButton } from "../../../../components/FollowButton";
import { ReportDialog } from "../../../../components/ReportDialog";
import { ApiErrorState, EmptyState, FeedSkeleton } from "../../../../components/States";
import { api } from "../../../../lib/api";
import { formatCount } from "../../../../lib/format";
import { useSession } from "../../../../lib/session";

type TabId = "posts" | "replies" | "media" | "likes" | "lists";

const TABS: { id: TabId; label: string }[] = [
  { id: "posts", label: "Posts" },
  { id: "replies", label: "Replies" },
  { id: "media", label: "Media" },
  { id: "likes", label: "Likes" },
  { id: "lists", label: "Lists" },
];

export default function ProfilePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = use(params);
  const router = useRouter();
  const { user: sessionUser, requireAuth } = useSession();
  const [reportOpen, setReportOpen] = useState(false);
  const [dmError, setDmError] = useState<string | null>(null);
  const [userLists, setUserLists] = useState<ListView[]>([]);
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [agentInfo, setAgentInfo] = useState<AgentProfileView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabId>("posts");
  const [followerCount, setFollowerCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getUserByHandle(handle)
      .then((result) => {
        if (cancelled) return;
        setProfile(result);
        setFollowerCount(result.followerCount);
        if (result.authorType === "agent") {
          api
            .getAgent(handle)
            .then((agent) => {
              if (!cancelled) setAgentInfo(agent);
            })
            .catch(() => undefined);
        }
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
  }, [handle]);

  const fetchPosts = useCallback(
    (cursor: string | undefined) =>
      api.listUserPosts(handle, {
        cursor,
        limit: 20,
        tab: (tab === "likes" || tab === "lists" ? "posts" : tab) as UserPostsTab,
      }),
    [handle, tab],
  );

  useEffect(() => {
    if (tab !== "lists") return;
    let cancelled = false;
    api
      .getUserLists(handle)
      .then((page) => {
        if (!cancelled) setUserLists(page.items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tab, handle]);

  async function startMessage() {
    if (!requireAuth()) return;
    setDmError(null);
    try {
      const conversation = await api.createConversation([handle]);
      router.push(`/messages/${conversation.id}`);
    } catch (cause) {
      setDmError(
        cause instanceof GGApiError
          ? cause.detail
          : "You can't message this account right now.",
      );
    }
  }

  if (loading) {
    return <FeedSkeleton count={2} />;
  }

  if (error || !profile) {
    const notFound = error instanceof GGApiError && error.status === 404;
    return notFound ? (
      <EmptyState
        title="Account not found"
        body={`@${handle} doesn't exist (yet).`}
        testId="profile-not-found"
      />
    ) : (
      <ApiErrorState error={error} />
    );
  }

  const isSelf = profile.viewerState?.isSelf ?? sessionUser?.handle === profile.handle;

  return (
    <div className="flex flex-col gap-4">
      <section
        data-testid="profile-header"
        className="rounded-lg border border-border bg-surface p-5"
        aria-label={`Profile of ${profile.displayName}`}
      >
        <div className="flex items-start gap-4">
          <ProfileStoryRing
            handle={profile.handle}
            displayName={profile.displayName}
            avatarUrl={profile.avatarUrl}
            size={72}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display text-2xl font-bold">{profile.displayName}</h1>
              {profile.authorType === "agent" ? <AgentBadge /> : null}
            </div>
            <p className="text-sm text-text-muted">@{profile.handle}</p>
            {profile.bio ? <p className="mt-2 leading-relaxed">{profile.bio}</p> : null}
            {profile.authorType === "agent" && agentInfo ? (
              <div
                className="mt-3 rounded-lg border border-border bg-surface-sunken p-3 text-sm"
                data-testid="agent-disclosure"
              >
                {agentInfo.killSwitchEngaged ? (
                  <p className="font-semibold text-danger">
                    This agent is suspended (kill switch engaged).
                  </p>
                ) : null}
                <p>{agentInfo.autoDisclosure}</p>
                {agentInfo.purpose ? (
                  <p className="mt-1">
                    <span className="font-medium">Purpose:</span> {agentInfo.purpose}
                  </p>
                ) : null}
                <p className="mt-1 text-text-muted">
                  Owned by{" "}
                  <Link href={`/u/${agentInfo.owner.handle}`} className="font-medium hover:underline">
                    @{agentInfo.owner.handle}
                  </Link>
                  {agentInfo.modelProvider || agentInfo.modelName
                    ? ` · Model: ${[agentInfo.modelProvider, agentInfo.modelName].filter(Boolean).join(" · ")}`
                    : ""}
                  {agentInfo.homepageUrl ? (
                    <>
                      {" · "}
                      <a href={agentInfo.homepageUrl} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                        Homepage
                      </a>
                    </>
                  ) : null}
                </p>
              </div>
            ) : null}
            <p className="mt-3 flex gap-4 text-sm">
              <span>
                <strong className="font-mono tabular-nums">{formatCount(followerCount)}</strong>{" "}
                <span className="text-text-muted">followers</span>
              </span>
              <span>
                <strong className="font-mono tabular-nums">
                  {formatCount(profile.followingCount)}
                </strong>{" "}
                <span className="text-text-muted">following</span>
              </span>
            </p>
            {profile.debateRating !== null && profile.debateRecord ? (
              <p className="mt-2 text-sm" data-testid="profile-debate-record">
                <span className="font-semibold">Debate rating {profile.debateRating}</span>{" "}
                <span className="text-text-muted">
                  · {profile.debateRecord.wins}W – {profile.debateRecord.losses}L –{" "}
                  {profile.debateRecord.draws}D in rated 1v1/team debates
                </span>
              </p>
            ) : null}
          </div>
          {!isSelf ? (
            <div className="flex shrink-0 flex-wrap items-start gap-2">
              <FollowButton
                handle={profile.handle}
                initialFollowing={profile.viewerState?.isFollowing ?? false}
                onChange={(following) =>
                  setFollowerCount((count) => count + (following ? 1 : -1))
                }
              />
              <button
                type="button"
                data-testid="profile-message-button"
                onClick={() => void startMessage()}
                className="flex min-h-11 items-center rounded-full border border-border px-4 font-semibold transition-colors hover:bg-surface-sunken"
              >
                Message
              </button>
              <button
                type="button"
                data-testid="profile-report-button"
                onClick={() => {
                  if (!requireAuth()) return;
                  setReportOpen(true);
                }}
                className="flex min-h-11 items-center rounded-full border border-border px-4 font-semibold transition-colors hover:bg-surface-sunken"
              >
                Report
              </button>
            </div>
          ) : (
            <Link
              href="/settings"
              data-testid="profile-edit-button"
              className="flex min-h-11 items-center rounded-full border border-border px-4 font-semibold transition-colors hover:bg-surface-sunken"
            >
              Edit profile
            </Link>
          )}
        </div>
      </section>
      {dmError ? (
        <p
          role="alert"
          className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-danger"
          data-testid="profile-message-blocked"
        >
          {dmError}
        </p>
      ) : null}
      {!isSelf ? (
        <ReportDialog
          targetType="user"
          targetId={profile.userId}
          targetLabel={`@${profile.handle}`}
          open={reportOpen}
          onClose={() => setReportOpen(false)}
        />
      ) : null}

      <div role="tablist" aria-label="Profile sections" className="flex gap-1 border-b border-border">
        {TABS.map((option) => (
          <button
            key={option.id}
            role="tab"
            aria-selected={tab === option.id}
            data-testid={`profile-tab-${option.id}`}
            onClick={() => setTab(option.id)}
            className={`min-h-12 border-b-2 px-4 font-medium transition-colors ${
              tab === option.id
                ? "border-accent text-text"
                : "border-transparent text-text-muted hover:text-text"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {tab === "likes" ? (
        // Likes have no public endpoint in the API spec — honest placeholder
        // rather than a fake list. Bookmarks (private) are the wired surface.
        <EmptyState
          title="Likes aren't public"
          body="GG doesn't publish a public likes list. Your saved posts stay in your bookmarks."
          testId="profile-likes-placeholder"
        />
      ) : tab === "lists" ? (
        <div role="tabpanel" aria-label="Lists">
          {userLists.length === 0 ? (
            <EmptyState
              title="No public lists"
              body={`@${profile.handle} hasn't published a list yet.`}
              testId="profile-lists-empty"
            />
          ) : (
            <ol className="overflow-hidden rounded-lg border border-border bg-surface">
              {userLists.map((list) => (
                <li key={list.id}>
                  <Link
                    href={`/lists/${list.id}`}
                    data-testid="profile-list-row"
                    className="block border-b border-border px-4 py-3 hover:bg-surface-sunken"
                  >
                    <span className="font-semibold">{list.name}</span>{" "}
                    <span className="text-sm text-text-muted">
                      · {list.memberCount} members
                    </span>
                    {list.description ? (
                      <span className="block truncate text-sm text-text-muted">
                        {list.description}
                      </span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : tab === "media" ? (
        <div role="tabpanel" aria-label="Media">
          <ProfileMediaGrid handle={handle} />
        </div>
      ) : (
        <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label}>
          <FeedList
            fetchPage={fetchPosts}
            resetKey={`${handle}:${tab}`}
            emptyTitle="Nothing here yet"
            emptyBody={
              tab === "posts"
                ? `@${profile.handle} hasn't posted yet.`
                : tab === "replies"
                  ? `@${profile.handle} hasn't replied yet.`
                  : `@${profile.handle} hasn't posted media yet.`
            }
          />
        </div>
      )}
    </div>
  );
}
