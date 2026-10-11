"use client";

import type { ProfileView, StoryGroupView, StoryView } from "@gg/sdk";
import { Plus, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { Avatar } from "./Avatar";
import { MediaImage } from "./MediaImage";
import { MediaVideo } from "./MediaVideo";

/**
 * Stories rail (Phase 2): rings for followed accounts with active stories
 * (own ring first), plus a "Your story" upload entry. Opens the viewer.
 */
export function StoriesRail() {
  const { user } = useSession();
  const [groups, setGroups] = useState<StoryGroupView[]>([]);
  const [openGroup, setOpenGroup] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setGroups(await api.getStoriesFeed());
    } catch {
      setGroups([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function addStory(file: File | null) {
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const media = await api.uploadMedia(file);
      // The pipeline runs in the worker; wait until the frame can post.
      let ready = media;
      for (let attempt = 0; attempt < 80 && ready.status !== "ready"; attempt += 1) {
        if (ready.status === "failed" || ready.status === "rejected") break;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        ready = await api.getMedia(media.id);
      }
      if (ready.status !== "ready") {
        throw new Error("That file couldn't be processed for a story.");
      }
      await api.createStory({ mediaId: media.id });
      await refresh();
    } catch (cause) {
      setUploadError(
        cause instanceof Error ? cause.message : "Couldn't post your story.",
      );
    } finally {
      setUploading(false);
    }
  }

  const ownGroupIndex = groups.findIndex((g) => g.author.id === user?.id);

  return (
    <section aria-label="Stories" data-testid="stories-rail">
      <div className="flex gap-3 overflow-x-auto pb-1">
        <div className="flex w-[72px] shrink-0 flex-col items-center gap-1.5">
          <button
            type="button"
            onClick={() =>
              ownGroupIndex >= 0 ? setOpenGroup(ownGroupIndex) : fileRef.current?.click()
            }
            disabled={uploading}
            aria-label={ownGroupIndex >= 0 ? "View your story" : "Add to your story"}
            data-testid="story-add-button"
            data-story-state={ownGroupIndex >= 0 ? "has-story" : "empty"}
            className="relative flex h-16 w-16 items-center justify-center rounded-full bg-surface-sunken ring-2 ring-border transition hover:ring-accent disabled:opacity-50"
          >
            <Avatar name={user?.profile.displayName ?? "You"} avatarUrl={user?.profile.avatarUrl ?? null} size={56} />
            <span className="absolute right-0 bottom-0 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-accent-ink ring-2 ring-surface">
              <Plus size={12} aria-hidden="true" />
            </span>
          </button>
          <span className="w-full truncate text-center text-xs text-text-muted">Your story</span>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/avif,image/gif,video/mp4,video/webm"
            className="hidden"
            data-testid="story-file-input"
            onChange={(event) => {
              void addStory(event.target.files?.[0] ?? null);
              event.target.value = "";
            }}
          />
        </div>
        {groups
          .filter((group) => group.author.id !== user?.id)
          .map((group) => {
            const realIndex = groups.indexOf(group);
            return (
              <div
                key={group.author.id}
                className="flex w-[72px] shrink-0 flex-col items-center gap-1.5"
              >
                <button
                  type="button"
                  onClick={() => setOpenGroup(realIndex)}
                  aria-label={`View ${group.author.displayName}'s story`}
                  data-testid="story-ring"
                  className={`flex h-16 w-16 items-center justify-center rounded-full ring-2 transition ${
                    group.hasUnseen ? "ring-accent" : "ring-border"
                  }`}
                >
                  <Avatar
                    name={group.author.displayName}
                    avatarUrl={group.author.avatarUrl}
                    size={56}
                  />
                </button>
                <span className="w-full truncate text-center text-xs text-text-muted">
                  {group.author.handle}
                </span>
              </div>
            );
          })}
      </div>
      {uploading ? (
        <p className="mt-1 text-xs text-text-muted" role="status">
          Posting your story…
        </p>
      ) : null}
      {uploadError ? (
        <p className="mt-1 text-xs text-danger" role="alert">
          {uploadError}
        </p>
      ) : null}
      {openGroup !== null && groups[openGroup] ? (
        <StoryViewer
          groups={groups}
          startGroup={openGroup}
          onClose={() => {
            setOpenGroup(null);
            void refresh();
          }}
        />
      ) : null}
    </section>
  );
}

const IMAGE_FRAME_MS = 5000;

/**
 * Full-screen story viewer: progress bars per frame, auto-advance (5 s for
 * images, video duration for video), tap zones for prev/next, view
 * tracking, and a viewers list on the author's own frames.
 */
export function StoryViewer({
  groups,
  startGroup,
  onClose,
}: {
  groups: StoryGroupView[];
  startGroup: number;
  onClose: () => void;
}) {
  const { user } = useSession();
  const [groupIndex, setGroupIndex] = useState(startGroup);
  const [frameIndex, setFrameIndex] = useState(0);
  const [viewers, setViewers] = useState<ProfileView[] | null>(null);
  const timerRef = useRef<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const group = groups[groupIndex];
  const frame: StoryView | undefined = group?.stories[frameIndex];
  const isOwn = group?.author.id === user?.id;

  const goNext = useCallback(() => {
    if (!group) return;
    if (frameIndex + 1 < group.stories.length) {
      setFrameIndex(frameIndex + 1);
    } else if (groupIndex + 1 < groups.length) {
      setGroupIndex(groupIndex + 1);
      setFrameIndex(0);
    } else {
      onClose();
    }
  }, [group, frameIndex, groupIndex, groups.length, onClose]);

  const goPrev = useCallback(() => {
    if (frameIndex > 0) setFrameIndex(frameIndex - 1);
    else if (groupIndex > 0) {
      const prev = groups[groupIndex - 1]!;
      setGroupIndex(groupIndex - 1);
      setFrameIndex(prev.stories.length - 1);
    }
  }, [frameIndex, groupIndex, groups]);

  // Record the view + load viewers for own frames.
  useEffect(() => {
    if (!frame) return;
    setViewers(null);
    if (!isOwn) {
      void api.viewStory(frame.id).catch(() => undefined);
    } else {
      void api
        .listStoryViewers(frame.id, { limit: 50 })
        .then((page) => setViewers(page.items))
        .catch(() => setViewers([]));
    }
  }, [frame, isOwn]);

  // Auto-advance for image frames (video advances on `ended`).
  useEffect(() => {
    if (!frame || frame.media.kind === "video") return;
    timerRef.current = window.setTimeout(goNext, IMAGE_FRAME_MS);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [frame, goNext]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") goNext();
      if (event.key === "ArrowLeft") goPrev();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, goNext, goPrev]);

  if (!group || !frame) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Story by ${group.author.displayName}`}
      data-testid="story-viewer"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
    >
      <div className="relative flex max-h-full w-full max-w-md flex-col">
        <div className="mb-2 flex gap-1" aria-hidden="true">
          {group.stories.map((story, i) => (
            <span key={story.id} className="h-1 flex-1 overflow-hidden rounded-full bg-white/30">
              <span
                className={`block h-full bg-white ${i < frameIndex ? "w-full" : i === frameIndex ? "w-1/2" : "w-0"}`}
              />
            </span>
          ))}
        </div>
        <div className="mb-2 flex items-center gap-2 text-white">
          <Avatar name={group.author.displayName} avatarUrl={group.author.avatarUrl} size={32} />
          <span className="font-medium">{group.author.displayName}</span>
          <span className="text-sm text-white/70">@{group.author.handle}</span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close story viewer"
            className="flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-white/10"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-black">
          {frame.media.kind === "video" ? (
            <MediaVideo
              media={frame.media}
              autoPlay
              muted
              controls={false}
              videoRef={videoRef}
              onEnded={goNext}
              className="max-h-[70vh]"
            />
          ) : (
            <MediaImage media={frame.media} className="max-h-[70vh]" eager />
          )}
          <button
            type="button"
            aria-label="Previous story"
            onClick={goPrev}
            className="absolute inset-y-0 left-0 w-1/3 cursor-w-resize"
          />
          <button
            type="button"
            aria-label="Next story"
            onClick={goNext}
            className="absolute inset-y-0 right-0 w-1/3 cursor-e-resize"
          />
        </div>
        {isOwn ? (
          <div className="mt-2 rounded-md bg-white/10 px-3 py-2 text-sm text-white" data-testid="story-viewers">
            {viewers === null
              ? "Loading viewers…"
              : viewers.length === 0
                ? "No views yet"
                : `Seen by ${viewers.map((v) => `@${v.handle}`).join(", ")}`}
          </div>
        ) : null}
      </div>
    </div>
  );
}
