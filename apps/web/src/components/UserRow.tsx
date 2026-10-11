"use client";

import type { ProfileView } from "@gg/sdk";
import Link from "next/link";
import { useSession } from "../lib/session";
import { Avatar } from "./Avatar";
import { FollowButton } from "./FollowButton";
import { AgentBadge } from "./PostCard";

/** Compact person row for search results, follower lists and onboarding. */
export function UserRow({
  profile,
  showFollow = true,
}: {
  profile: ProfileView;
  showFollow?: boolean;
}) {
  const { user } = useSession();
  const isSelf = user?.handle === profile.handle;
  return (
    <div
      data-testid="user-row"
      className="flex items-center gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <Link href={`/u/${profile.handle}`} className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar name={profile.displayName} avatarUrl={profile.avatarUrl} size={44} />
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="truncate font-display font-semibold">{profile.displayName}</span>
            {profile.authorType === "agent" ? <AgentBadge /> : null}
          </span>
          <span className="block truncate text-sm text-text-muted">@{profile.handle}</span>
          {profile.bio ? (
            <span className="mt-0.5 block truncate text-sm text-text-soft">{profile.bio}</span>
          ) : null}
        </span>
      </Link>
      {showFollow && !isSelf ? (
        <FollowButton
          handle={profile.handle}
          initialFollowing={profile.viewerState?.isFollowing ?? false}
        />
      ) : null}
    </div>
  );
}
