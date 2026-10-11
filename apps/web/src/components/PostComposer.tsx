"use client";

import type { MediaView, PostView } from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import { POST_CHAR_LIMIT, type PostType } from "@gg/shared";
import { Button, testIds } from "@gg/ui";
import { CalendarClock, ImagePlus, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { DebateComposer } from "./DebateComposer";
import { PollComposer } from "./PollComposer";

interface Attachment {
  key: string;
  name: string;
  kind: "image" | "video" | "gif";
  previewUrl: string;
  progress: number;
  status: "uploading" | "processing" | "ready" | "error";
  mediaId: string | null;
  error: string | null;
  /** When pipeline processing started (ms epoch) — drives the elapsed timer. */
  processingSince: number | null;
}

/**
 * Post composer with the 500-char counter ring (DESIGN_SYSTEM §8.2) and,
 * since Phase 2, media attachments: upload with progress, poll the
 * pipeline until ready, per-item alt text, and a Reel toggle for single
 * videos. The post type is derived from the attachments (1 image IMAGE,
 * 2+ CAROUSEL, 1 video VIDEO/REEL); body text is optional with media.
 */
export function PostComposer({
  parentId,
  communitySlug,
  placeholder = "Drop your take…",
  submitLabel = "Post",
  autoFocus = false,
  onPosted,
}: {
  parentId?: string;
  communitySlug?: string;
  placeholder?: string;
  submitLabel?: string;
  autoFocus?: boolean;
  onPosted?: (post: PostView) => void;
}) {
  const { requireAuth } = useSession();
  // Phase 3: top-level composers can switch to poll / debate modes.
  const [mode, setMode] = useState<"post" | "poll" | "debate">("post");
  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [asReel, setAsReel] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Phase 5A: schedule for later (top-level posts only, D-050).
  const [scheduleAt, setScheduleAt] = useState("");
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduledNote, setScheduledNote] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const aliveRef = useRef(true);
  // 1s ticker so "Processing…" can show a live elapsed time instead of
  // looking frozen (the old static label read as "stuck" within seconds).
  const [nowTick, setNowTick] = useState(() => Date.now());
  const anyProcessing = attachments.some((a) => a.status === "processing");
  useEffect(() => {
    if (!anyProcessing) return;
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyProcessing]);
  const errorId = useId();
  const fieldId = useId();

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const length = body.length;
  const overLimit = length > POST_CHAR_LIMIT;
  const remaining = POST_CHAR_LIMIT - length;
  const mediaBusy = attachments.some((a) => a.status === "uploading" || a.status === "processing");
  const mediaError = attachments.some((a) => a.status === "error");
  const hasMedia = attachments.length > 0;
  const disabled =
    overLimit || submitting || mediaBusy || mediaError || (length === 0 && !hasMedia);

  // Counter ring geometry (r=10 → circumference ≈ 62.83).
  const circumference = 2 * Math.PI * 10;
  const progress = Math.min(1, length / POST_CHAR_LIMIT);
  const showCount = remaining <= 100;

  const singleVideo =
    attachments.length === 1 && attachments[0]?.kind === "video" ? attachments[0] : null;

  function patchAttachment(key: string, patch: Partial<Attachment>) {
    setAttachments((current) =>
      current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  }

  async function pollUntilReady(key: string, mediaId: string) {
    // The pipeline runs on a small host: a 90s video can legitimately take
    // a minute or two to transcode, and big photos take real seconds too.
    // The old 120s cap declared files dead while they were still encoding,
    // which read as "stuck at processing". Poll patiently (10 min), keep
    // the elapsed timer visible, and only fail on a terminal media status.
    const deadline = Date.now() + 10 * 60 * 1000;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (!aliveRef.current) return;
      let media: MediaView;
      try {
        media = await api.getMedia(mediaId);
      } catch {
        if (Date.now() > deadline) break;
        continue;
      }
      if (media.status === "ready") {
        patchAttachment(key, { status: "ready" });
        return;
      }
      if (media.status === "failed" || media.status === "rejected" || media.status === "quarantined") {
        patchAttachment(key, {
          status: "error",
          error:
            media.status === "rejected"
              ? "That file was blocked by the media scanner."
              : "Processing failed for that file.",
        });
        return;
      }
      if (Date.now() > deadline) break;
    }
    patchAttachment(key, {
      status: "error",
      error: "Still processing after 10 minutes. Remove it and try again, or try a smaller file.",
    });
  }

  async function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (!requireAuth()) return;
    const room = 10 - attachments.length;
    const picked = Array.from(files).slice(0, room);
    for (const file of picked) {
      const kind = file.type.startsWith("video/")
        ? "video"
        : file.type === "image/gif"
          ? "gif"
          : "image";
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const attachment: Attachment = {
        key,
        name: file.name,
        kind,
        previewUrl: URL.createObjectURL(file),
        progress: 0,
        status: "uploading",
        mediaId: null,
        error: null,
        processingSince: null,
      };
      setAttachments((current) => [...current, attachment]);
      try {
        const media = await api.uploadMedia(file, {
          kind,
          onProgress: (fraction) => patchAttachment(key, { progress: fraction }),
        });
        patchAttachment(key, {
          mediaId: media.id,
          status: "processing",
          progress: 1,
          processingSince: Date.now(),
        });
        void pollUntilReady(key, media.id);
      } catch (cause) {
        patchAttachment(key, {
          status: "error",
          error:
            cause instanceof GGApiError ? cause.detail : "Upload failed. Try again.",
        });
      }
    }
  }

  function removeAttachment(key: string) {
    setAttachments((current) => {
      const target = current.find((item) => item.key === key);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter((item) => item.key !== key);
    });
  }

  async function saveAltText(attachment: Attachment, altText: string) {
    if (!attachment.mediaId) return;
    try {
      await api.updateMediaAlt(attachment.mediaId, altText.trim() ? altText : null);
    } catch {
      // Alt text is best-effort while composing; the post still submits.
    }
  }

  function derivedType(): PostType {
    if (attachments.length === 0) return "TEXT";
    if (singleVideo) return asReel ? "REEL" : "VIDEO";
    return attachments.length === 1 ? "IMAGE" : "CAROUSEL";
  }

  async function submit() {
    if (disabled) return;
    if (!requireAuth()) return;
    setSubmitting(true);
    setError(null);
    setScheduledNote(null);
    const scheduledFor =
      !parentId && showSchedule && scheduleAt
        ? new Date(scheduleAt).toISOString()
        : undefined;
    try {
      const post = await api.createPost({
        type: derivedType(),
        body: body.trim(),
        parentId,
        communitySlug,
        mediaIds: attachments
          .map((a) => a.mediaId)
          .filter((id): id is string => Boolean(id)),
        scheduledFor,
      });
      setBody("");
      setAttachments([]);
      setAsReel(false);
      if (scheduledFor) {
        setScheduledNote(
          `Scheduled for ${new Date(scheduledFor).toLocaleString()} — it publishes automatically then.`,
        );
        setScheduleAt("");
        setShowSchedule(false);
      } else {
        onPosted?.(post);
      }
    } catch (cause) {
      setError(
        cause instanceof GGApiError
          ? cause.isNetworkError
            ? "Can't reach the GG API — your post wasn't sent."
            : cause.detail
          : "Couldn't post. Try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      data-testid={testIds.composer}
      className="rounded-lg border border-border bg-surface p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {!parentId ? (
        <div className="mb-3 flex gap-1" role="tablist" aria-label="Composer mode">
          {(
            [
              { key: "post", label: "Post" },
              { key: "poll", label: "Poll" },
              { key: "debate", label: "Debate" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={mode === tab.key}
              data-testid={`composer-mode-${tab.key}`}
              onClick={() => setMode(tab.key)}
              className={`min-h-10 rounded-full px-4 text-sm font-medium transition-colors ${
                mode === tab.key
                  ? "bg-accent-tint text-text"
                  : "text-text-muted hover:bg-surface-sunken hover:text-text"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}
      {!parentId && mode === "poll" ? (
        <PollComposer communitySlug={communitySlug} onPosted={onPosted} />
      ) : !parentId && mode === "debate" ? (
        <DebateComposer communitySlug={communitySlug} onCreated={onPosted} />
      ) : (
        <>
      <label htmlFor={fieldId} className="sr-only">
        {parentId ? "Write a reply" : "Write a post"}
      </label>
      <textarea
        id={fieldId}
        ref={textareaRef}
        value={body}
        autoFocus={autoFocus}
        onChange={(event) => setBody(event.target.value)}
        placeholder={placeholder}
        rows={parentId ? 3 : 4}
        aria-invalid={overLimit}
        aria-describedby={error ? errorId : undefined}
        className="w-full resize-y rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-[1rem] leading-relaxed placeholder:text-text-muted"
      />
      {attachments.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-3" data-testid="composer-attachments">
          {attachments.map((attachment) => (
            <li
              key={attachment.key}
              className="flex gap-3 rounded-md border border-border bg-surface-sunken p-2"
            >
              {attachment.kind === "video" ? (
                <video
                  src={attachment.previewUrl}
                  className="h-20 w-20 shrink-0 rounded-sm object-cover"
                  muted
                  playsInline
                  preload="metadata"
                  aria-label={attachment.name}
                />
              ) : (
                <img
                  src={attachment.previewUrl}
                  alt=""
                  className="h-20 w-20 shrink-0 rounded-sm object-cover"
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{attachment.name}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(attachment.key)}
                    aria-label={`Remove ${attachment.name}`}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface hover:text-text"
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>
                {attachment.status === "uploading" ? (
                  <p className="mt-1 text-xs text-text-muted" role="status">
                    Uploading… {Math.round(attachment.progress * 100)}%
                  </p>
                ) : attachment.status === "processing" ? (
                  <p className="mt-1 text-xs text-text-muted" role="status">
                    Processing…{" "}
                    {attachment.processingSince
                      ? `${Math.max(0, Math.floor((nowTick - attachment.processingSince) / 1000))}s`
                      : ""}
                    <span className="block sm:inline">
                      {" "}
                      — {attachment.kind === "video"
                        ? "videos are transcoded before they can post; a short clip usually takes under a minute."
                        : "large photos can take a few seconds."}
                    </span>
                  </p>
                ) : attachment.status === "error" ? (
                  <p className="mt-1 text-xs text-danger" role="alert">
                    {attachment.error}
                  </p>
                ) : (
                  <label className="mt-1 block">
                    <span className="sr-only">Alt text for {attachment.name}</span>
                    <input
                      type="text"
                      placeholder="Alt text (describe it for screen readers)"
                      maxLength={1000}
                      data-testid="composer-alt-text"
                      onBlur={(event) => void saveAltText(attachment, event.target.value)}
                      className="w-full rounded-sm border border-border bg-surface px-2 py-1.5 text-sm placeholder:text-text-muted"
                    />
                  </label>
                )}
                {(attachment.status === "uploading" || attachment.status === "processing") && (
                  <div
                    className="mt-2 h-1.5 overflow-hidden rounded-full bg-border"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(attachment.progress * 100)}
                    aria-label={`Upload progress for ${attachment.name}`}
                  >
                    <div
                      className={`h-full bg-accent transition-all ${
                        attachment.status === "processing" ? "animate-pulse" : ""
                      }`}
                      style={{ width: `${Math.round(attachment.progress * 100)}%` }}
                    />
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {singleVideo ? (
        <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={asReel}
            onChange={(event) => setAsReel(event.target.checked)}
            data-testid="composer-reel-toggle"
            className="h-4 w-4 accent-[#ffbf47]"
          />
          Post as Reel (vertical feed, up to 3 minutes)
        </label>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/avif,image/gif,video/mp4,video/webm,video/quicktime"
          multiple
          className="hidden"
          data-testid="composer-file-input"
          onChange={(event) => {
            void addFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={attachments.length >= 10}
          aria-label="Add photos or video"
          data-testid="composer-attach-button"
          className="flex h-10 w-10 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-sunken hover:text-text disabled:opacity-40"
        >
          <ImagePlus size={20} aria-hidden="true" />
        </button>
        {!parentId ? (
          <button
            type="button"
            onClick={() => setShowSchedule((current) => !current)}
            aria-pressed={showSchedule}
            aria-label="Schedule this post"
            data-testid="composer-schedule-button"
            className={`flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-surface-sunken ${
              showSchedule ? "text-accent" : "text-text-muted hover:text-text"
            }`}
          >
            <CalendarClock size={20} aria-hidden="true" />
          </button>
        ) : null}
        <span className="flex-1" />
        {overLimit ? (
          <span role="alert" className="text-sm font-medium text-danger">
            {Math.abs(remaining)} over the limit
          </span>
        ) : null}
        {/* Hidden at rest: an empty composer showed an unexplained hollow
            circle next to the Post button. Appears once typing starts or
            the limit nears. */}
        {length > 0 || showCount ? (
        <span className="relative flex h-7 w-7 items-center justify-center" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 28 28" className="-rotate-90">
            <circle cx="14" cy="14" r="10" fill="none" stroke="var(--border)" strokeWidth="2.5" />
            <circle
              cx="14"
              cy="14"
              r="10"
              fill="none"
              stroke={overLimit ? "var(--danger)" : "var(--accent)"}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - progress)}
            />
          </svg>
        </span>
        ) : null}
        {showCount ? (
          <span
            className={`font-mono text-sm tabular-nums ${overLimit ? "text-danger" : "text-text-muted"}`}
            aria-live="polite"
          >
            {remaining}
          </span>
        ) : null}
        <span className="sr-only" aria-live="polite">
          {length} of {POST_CHAR_LIMIT} characters
        </span>
        <Button type="submit" disabled={disabled} data-testid={testIds.composerSubmit}>
          {submitting
            ? "Posting…"
            : showSchedule && scheduleAt
              ? "Schedule post"
              : submitLabel}
        </Button>
      </div>
      {!parentId && showSchedule ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label htmlFor="composer-schedule-at" className="text-sm text-text-muted">
            Publish at
          </label>
          <input
            id="composer-schedule-at"
            type="datetime-local"
            data-testid="composer-schedule-input"
            value={scheduleAt}
            onChange={(event) => setScheduleAt(event.target.value)}
            className="min-h-10 rounded-md border border-border bg-surface-sunken px-2 text-sm"
          />
        </div>
      ) : null}
      {scheduledNote ? (
        <p role="status" className="mt-2 text-sm" data-testid="composer-scheduled-note">
          {scheduledNote}{" "}
          <Link href="/scheduled" className="font-medium hover:underline">
            Manage scheduled posts
          </Link>
        </p>
      ) : null}
        </>
      )}
    </form>
  );
}
