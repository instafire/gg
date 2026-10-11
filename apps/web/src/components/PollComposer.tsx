"use client";

import type { PollType, PostView } from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import { Button } from "@gg/ui";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { useSession } from "../lib/session";

const TYPE_OPTIONS: Array<{ value: PollType; label: string; hint: string }> = [
  { value: "single", label: "Single choice", hint: "Pick one option" },
  { value: "multiple", label: "Multiple choice", hint: "Pick up to a set number" },
  { value: "ranked", label: "Ranked choice", hint: "Voters rank; IRV tabulates" },
  { value: "stance_slider", label: "Stance slider", hint: "Strongly against → strongly for" },
  { value: "image", label: "Image poll", hint: "Each option is one of your photos" },
  { value: "hot_take", label: "Hot take", hint: "Agree / Nuanced / Disagree" },
];

const DURATIONS: Array<{ label: string; hours: number | null }> = [
  { label: "No closing date", hours: null },
  { label: "1 hour", hours: 1 },
  { label: "24 hours", hours: 24 },
  { label: "7 days", hours: 24 * 7 },
];

interface ImageOption {
  mediaId: string | null;
  previewUrl: string | null;
  status: "empty" | "uploading" | "processing" | "ready" | "error";
  caption: string;
}

/**
 * Poll composer (Phase 3): type picker, options editor, duration and
 * result-mode controls. Image options upload through the Phase 2 media
 * pipeline and must reach `ready` before the poll can be created.
 */
export function PollComposer({
  communitySlug,
  onPosted,
}: {
  communitySlug?: string;
  onPosted?: (post: PostView) => void;
}) {
  const { requireAuth } = useSession();
  const [question, setQuestion] = useState("");
  const [type, setType] = useState<PollType>("single");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [imageOptions, setImageOptions] = useState<ImageOption[]>([
    { mediaId: null, previewUrl: null, status: "empty", caption: "" },
    { mediaId: null, previewUrl: null, status: "empty", caption: "" },
  ]);
  const [maxChoices, setMaxChoices] = useState(2);
  const [resultMode, setResultMode] = useState<"live" | "after_vote" | "after_close">("live");
  const [durationHours, setDurationHours] = useState<number | null>(24);
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsOptions = type !== "stance_slider" && type !== "hot_take";
  const textOptions = options.map((text) => text.trim()).filter(Boolean);
  const imagesReady =
    type !== "image" || imageOptions.every((option) => option.status === "ready");
  const valid =
    question.trim().length > 0 &&
    (!needsOptions || type === "image" || textOptions.length >= 2) &&
    imagesReady &&
    !submitting;

  async function pollImageReady(index: number, mediaId: string) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        const media = await api.getMedia(mediaId);
        if (media.status === "ready") {
          setImageOptions((current) =>
            current.map((option, i) => (i === index ? { ...option, status: "ready" } : option)),
          );
          return;
        }
        if (media.status === "failed" || media.status === "rejected") break;
      } catch {
        // keep polling
      }
    }
    setImageOptions((current) =>
      current.map((option, i) => (i === index ? { ...option, status: "error" } : option)),
    );
  }

  async function pickImage(index: number, file: File | null) {
    if (!file) return;
    setImageOptions((current) =>
      current.map((option, i) =>
        i === index
          ? { ...option, status: "uploading", previewUrl: URL.createObjectURL(file) }
          : option,
      ),
    );
    try {
      const media = await api.uploadMedia(file, { kind: "image" });
      setImageOptions((current) =>
        current.map((option, i) =>
          i === index ? { ...option, mediaId: media.id, status: "processing" } : option,
        ),
      );
      void pollImageReady(index, media.id);
    } catch {
      setImageOptions((current) =>
        current.map((option, i) => (i === index ? { ...option, status: "error" } : option)),
      );
    }
  }

  async function submit() {
    if (!valid || !requireAuth()) return;
    setSubmitting(true);
    setError(null);
    try {
      const poll = await api.createPoll({
        question: question.trim(),
        type,
        options:
          type === "image"
            ? imageOptions.map((option) => ({
                mediaId: option.mediaId ?? undefined,
                text: option.caption.trim() || undefined,
              }))
            : needsOptions
              ? textOptions.map((text) => ({ text }))
              : undefined,
        maxChoices: type === "multiple" ? maxChoices : undefined,
        resultMode,
        isAnonymous,
        closesAt:
          durationHours === null
            ? undefined
            : new Date(Date.now() + durationHours * 3_600_000).toISOString(),
        communitySlug,
      });
      const post = await api.getPost(poll.postId);
      onPosted?.(post);
    } catch (cause) {
      setError(cause instanceof GGApiError ? cause.detail : "Couldn't create the poll.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div data-testid="poll-composer" className="flex flex-col gap-3">
      <div>
        <label htmlFor="poll-question" className="text-sm font-medium">
          Question <span className="text-text-muted">(max 200 characters)</span>
        </label>
        <input
          id="poll-question"
          value={question}
          maxLength={200}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="What should the floor decide?"
          className="mt-1 w-full rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-[1rem] placeholder:text-text-muted"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="poll-type" className="text-sm font-medium">
            Poll type
          </label>
          <select
            id="poll-type"
            value={type}
            onChange={(event) => setType(event.target.value as PollType)}
            className="mt-1 min-h-11 w-full rounded-md border border-border bg-surface-sunken px-3 text-sm"
          >
            {TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} — {option.hint}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="poll-results-mode" className="text-sm font-medium">
            Results
          </label>
          <select
            id="poll-results-mode"
            value={resultMode}
            onChange={(event) =>
              setResultMode(event.target.value as "live" | "after_vote" | "after_close")
            }
            className="mt-1 min-h-11 w-full rounded-md border border-border bg-surface-sunken px-3 text-sm"
          >
            <option value="live">Live — everyone sees results</option>
            <option value="after_vote">Hidden until you vote</option>
            <option value="after_close">Hidden until the poll closes</option>
          </select>
        </div>
        <div>
          <label htmlFor="poll-duration" className="text-sm font-medium">
            Duration
          </label>
          <select
            id="poll-duration"
            value={durationHours === null ? "none" : String(durationHours)}
            onChange={(event) =>
              setDurationHours(event.target.value === "none" ? null : Number(event.target.value))
            }
            className="mt-1 min-h-11 w-full rounded-md border border-border bg-surface-sunken px-3 text-sm"
          >
            {DURATIONS.map((duration) => (
              <option
                key={duration.label}
                value={duration.hours === null ? "none" : String(duration.hours)}
              >
                {duration.label}
              </option>
            ))}
          </select>
        </div>
        {type === "multiple" ? (
          <div>
            <label htmlFor="poll-max-choices" className="text-sm font-medium">
              Max choices per voter
            </label>
            <input
              id="poll-max-choices"
              type="number"
              min={1}
              max={10}
              value={maxChoices}
              onChange={(event) => setMaxChoices(Number(event.target.value))}
              className="mt-1 min-h-11 w-full rounded-md border border-border bg-surface-sunken px-3 text-sm"
            />
          </div>
        ) : null}
      </div>

      {needsOptions && type !== "image" ? (
        <fieldset>
          <legend className="text-sm font-medium">Options (2–10, max 80 characters each)</legend>
          <div className="mt-1 flex flex-col gap-2">
            {options.map((option, index) => (
              <div key={index} className="flex gap-2">
                <input
                  value={option}
                  maxLength={80}
                  onChange={(event) =>
                    setOptions((current) =>
                      current.map((value, i) => (i === index ? event.target.value : value)),
                    )
                  }
                  placeholder={`Option ${index + 1}`}
                  aria-label={`Option ${index + 1}`}
                  data-testid={index === 0 ? "poll-option-input-1" : undefined}
                  className="min-h-11 flex-1 rounded-md border border-border bg-surface-sunken px-3 text-sm placeholder:text-text-muted"
                />
                {options.length > 2 ? (
                  <button
                    type="button"
                    aria-label={`Remove option ${index + 1}`}
                    onClick={() =>
                      setOptions((current) => current.filter((_, i) => i !== index))
                    }
                    className="flex h-11 w-11 items-center justify-center rounded-md text-text-muted hover:bg-surface-sunken hover:text-text"
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ))}
            {options.length < 10 ? (
              <button
                type="button"
                onClick={() => setOptions((current) => [...current, ""])}
                className="inline-flex min-h-10 items-center gap-1 self-start rounded-md px-2 text-sm font-medium text-text-muted hover:text-text"
              >
                <Plus size={15} aria-hidden="true" /> Add option
              </button>
            ) : null}
          </div>
        </fieldset>
      ) : null}

      {type === "image" ? (
        <fieldset>
          <legend className="text-sm font-medium">Image options (upload 2–4 photos)</legend>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {imageOptions.map((option, index) => (
              <div key={index} className="rounded-md border border-border bg-surface-sunken p-2">
                {option.previewUrl ? (
                  <img src={option.previewUrl} alt="" className="aspect-square w-full rounded-sm object-cover" />
                ) : (
                  <label className="flex aspect-square w-full cursor-pointer items-center justify-center rounded-sm bg-surface text-sm text-text-muted hover:text-text">
                    Choose photo
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/avif"
                      className="hidden"
                      onChange={(event) => void pickImage(index, event.target.files?.[0] ?? null)}
                    />
                  </label>
                )}
                <p className="mt-1 text-xs text-text-muted" role="status">
                  {option.status === "ready"
                    ? "Ready"
                    : option.status === "error"
                      ? "Upload failed — pick another photo"
                      : option.status === "empty"
                        ? "No photo yet"
                        : "Processing…"}
                </p>
                <input
                  value={option.caption}
                  maxLength={80}
                  onChange={(event) =>
                    setImageOptions((current) =>
                      current.map((value, i) =>
                        i === index ? { ...value, caption: event.target.value } : value,
                      ),
                    )
                  }
                  placeholder="Caption (optional)"
                  aria-label={`Caption for image ${index + 1}`}
                  className="mt-1 min-h-9 w-full rounded-sm border border-border bg-surface px-2 text-sm placeholder:text-text-muted"
                />
              </div>
            ))}
          </div>
          {imageOptions.length < 4 ? (
            <button
              type="button"
              onClick={() =>
                setImageOptions((current) => [
                  ...current,
                  { mediaId: null, previewUrl: null, status: "empty", caption: "" },
                ])
              }
              className="mt-2 inline-flex min-h-10 items-center gap-1 rounded-md px-2 text-sm font-medium text-text-muted hover:text-text"
            >
              <Plus size={15} aria-hidden="true" /> Add image
            </button>
          ) : null}
        </fieldset>
      ) : null}

      {type === "hot_take" ? (
        <p className="text-sm text-text-muted">Options are fixed: Agree · Nuanced · Disagree.</p>
      ) : null}
      {type === "stance_slider" ? (
        <p className="text-sm text-text-muted">
          Voters place themselves from Strongly against to Strongly for.
        </p>
      ) : null}

      <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isAnonymous}
          onChange={(event) => setIsAnonymous(event.target.checked)}
          className="h-4 w-4 accent-[#ffbf47]"
        />
        Anonymous ballot (individual votes are never shown, only totals)
      </label>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="button" disabled={!valid} onClick={() => void submit()} data-testid="poll-submit">
          {submitting ? "Creating…" : "Create poll"}
        </Button>
      </div>
    </div>
  );
}
