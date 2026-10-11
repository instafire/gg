"use client";

import { GGApiError } from "@gg/sdk";
import { Button, testIds } from "@gg/ui";
import { useState } from "react";
import { api } from "../lib/api";
import { useSession } from "../lib/session";

/** Follow/Unfollow toggle with optimistic state and rollback on error. */
export function FollowButton({
  handle,
  initialFollowing,
  onChange,
}: {
  handle: string;
  initialFollowing: boolean;
  onChange?: (following: boolean) => void;
}) {
  const { requireAuth } = useSession();
  const [following, setFollowing] = useState(initialFollowing);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (pending) return;
    if (!requireAuth()) return;
    const previous = following;
    setFollowing(!previous);
    setPending(true);
    setError(null);
    try {
      if (previous) {
        await api.unfollowUser(handle);
        onChange?.(false);
      } else {
        const result = await api.followUser(handle);
        const nowFollowing = result.state === "following";
        setFollowing(nowFollowing);
        onChange?.(nowFollowing);
      }
    } catch (cause) {
      setFollowing(previous);
      setError(cause instanceof GGApiError ? cause.detail : "Couldn't update the follow.");
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        data-testid={testIds.followButton}
        variant={following ? "ghost" : "primary"}
        aria-pressed={following}
        disabled={pending}
        onClick={() => void toggle()}
      >
        {following ? "Following" : "Follow"}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/** Join/Leave toggle for a community, same optimistic pattern. */
export function JoinButton({
  slug,
  initialMember,
  onChange,
}: {
  slug: string;
  initialMember: boolean;
  onChange?: (member: boolean) => void;
}) {
  const { requireAuth } = useSession();
  const [member, setMember] = useState(initialMember);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (pending) return;
    if (!requireAuth()) return;
    const previous = member;
    setMember(!previous);
    setPending(true);
    setError(null);
    try {
      if (previous) {
        await api.leaveCommunity(slug);
        onChange?.(false);
      } else {
        const membership = await api.joinCommunity(slug);
        const nowMember = membership.status === "active";
        setMember(nowMember);
        onChange?.(nowMember);
      }
    } catch (cause) {
      setMember(previous);
      setError(cause instanceof GGApiError ? cause.detail : "Couldn't update membership.");
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        data-testid="join-button"
        variant={member ? "ghost" : "primary"}
        aria-pressed={member}
        disabled={pending}
        onClick={() => void toggle()}
      >
        {member ? "Joined" : "Join"}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}
