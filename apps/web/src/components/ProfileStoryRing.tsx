"use client";

import type { StoryGroupView } from "@gg/sdk";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { Avatar } from "./Avatar";
import { StoryViewer } from "./Stories";

/**
 * Profile header avatar with a story ring. When the user has an active
 * story, the avatar gets the accent ring (muted once everything is seen)
 * and tapping it opens the story viewer — the visible imprint a posted
 * story leaves on the profile. Without an active story it renders the
 * plain avatar, exactly as before.
 */
export function ProfileStoryRing({
  handle,
  displayName,
  avatarUrl,
  size = 72,
}: {
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  size?: number;
}) {
  const [group, setGroup] = useState<StoryGroupView | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setGroup(await api.getUserStories(handle));
    } catch {
      setGroup(null);
    }
  }, [handle]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!group) {
    return <Avatar name={displayName} avatarUrl={avatarUrl} size={size} />;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`View ${displayName}'s story`}
        data-testid="profile-story-ring"
        data-story-state={group.hasUnseen ? "unseen" : "seen"}
        className={`shrink-0 rounded-full p-[3px] ring-2 transition ${
          group.hasUnseen
            ? "ring-accent hover:ring-accent-hover"
            : "ring-border hover:ring-border-strong"
        }`}
      >
        <Avatar name={displayName} avatarUrl={avatarUrl} size={size} />
      </button>
      {open ? (
        <StoryViewer
          groups={[group]}
          startGroup={0}
          onClose={() => {
            setOpen(false);
            void load();
          }}
        />
      ) : null}
    </>
  );
}
