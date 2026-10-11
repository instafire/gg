"use client";

import type { MessageView } from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import { ImagePlus, SendHorizontal, X } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "../lib/api";
import { VoiceNoteRecorder } from "./VoiceNoteRecorder";

interface PendingMedia {
  mediaId: string;
  kind: string;
  name: string;
}

/**
 * Message composer (Phase 5A): text + image/video/audio attachments +
 * voice notes + reply-quote chip. Typing pings are throttled (one per
 * 3 s of active typing) and are fire-and-forget.
 */
export function MessageComposer({
  conversationId,
  replyTo,
  onCancelReply,
  onSent,
}: {
  conversationId: string;
  replyTo: MessageView | null;
  onCancelReply: () => void;
  onSent: (message: MessageView) => void;
}) {
  const [body, setBody] = useState("");
  const [media, setMedia] = useState<PendingMedia[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastTypingRef = useRef(0);

  const disabled = sending || (body.trim().length === 0 && media.length === 0);

  function pingTyping() {
    const now = Date.now();
    if (now - lastTypingRef.current < 3000) return;
    lastTypingRef.current = now;
    void api.sendTyping(conversationId).catch(() => undefined);
  }

  async function attachFile(file: File) {
    setError(null);
    try {
      const kind = file.type.startsWith("video/")
        ? "video"
        : file.type.startsWith("audio/")
          ? "audio"
          : "image";
      const uploaded = await api.uploadMedia(file, { kind });
      let current = uploaded;
      for (let attempt = 0; attempt < 20 && current.status !== "ready"; attempt += 1) {
        if (current.status === "failed" || current.status === "rejected" || current.status === "quarantined") {
          throw new Error("That file was blocked by the media scanner.");
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        current = await api.getMedia(uploaded.id);
      }
      if (current.status !== "ready") throw new Error("That file is still processing.");
      setMedia((current) => [...current, { mediaId: uploaded.id, kind, name: file.name }]);
    } catch (cause) {
      setError(
        cause instanceof GGApiError
          ? cause.detail
          : cause instanceof Error
            ? cause.message
            : "Upload failed.",
      );
    }
  }

  async function send() {
    if (disabled) return;
    setSending(true);
    setError(null);
    try {
      // The API attaches one media per message: extra attachments go as
      // follow-up messages so nothing the user picked is dropped.
      const [first, ...rest] = media;
      const message = await api.sendMessage(conversationId, {
        body: body.trim() ? body.trim() : undefined,
        mediaId: first?.mediaId,
        replyToMessageId: replyTo?.id,
      });
      onSent(message);
      for (const extra of rest) {
        const followUp = await api.sendMessage(conversationId, { mediaId: extra.mediaId });
        onSent(followUp);
      }
      setBody("");
      setMedia([]);
      onCancelReply();
    } catch (cause) {
      setError(
        cause instanceof GGApiError ? cause.detail : "Couldn't send that message.",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="border-t border-border bg-surface p-3">
      {replyTo ? (
        <div
          className="mb-2 flex items-center gap-2 rounded-md bg-surface-sunken px-3 py-2 text-sm"
          data-testid="message-reply-chip"
        >
          <span className="min-w-0 flex-1 truncate">
            Replying to{" "}
            <strong>@{replyTo.sender.handle}</strong>
            {replyTo.body ? `: ${replyTo.body}` : ""}
          </span>
          <button
            type="button"
            onClick={onCancelReply}
            aria-label="Cancel reply"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full hover:bg-surface"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {media.length > 0 ? (
        <ul className="mb-2 flex flex-wrap gap-2" data-testid="message-pending-media">
          {media.map((item) => (
            <li
              key={item.mediaId}
              className="flex items-center gap-2 rounded-full bg-surface-sunken py-1 pr-1 pl-3 text-sm"
            >
              <span className="max-w-40 truncate">{item.name}</span>
              <button
                type="button"
                aria-label={`Remove ${item.name}`}
                onClick={() =>
                  setMedia((current) => current.filter((m) => m.mediaId !== item.mediaId))
                }
                className="flex h-6 w-6 items-center justify-center rounded-full hover:bg-surface"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        className="flex items-end gap-1"
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*,audio/*"
          className="hidden"
          data-testid="message-file-input"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void attachFile(file);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          aria-label="Attach a file"
          data-testid="message-attach-button"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-sunken hover:text-text"
        >
          <ImagePlus size={20} aria-hidden="true" />
        </button>
        <VoiceNoteRecorder
          onReady={(mediaId) => {
            void (async () => {
              try {
                const message = await api.sendMessage(conversationId, { mediaId });
                onSent(message);
              } catch (cause) {
                setError(
                  cause instanceof GGApiError ? cause.detail : "Couldn't send the voice note.",
                );
              }
            })();
          }}
          onError={setError}
        />
        <label htmlFor="message-composer-input" className="sr-only">
          Write a message
        </label>
        <textarea
          id="message-composer-input"
          data-testid="message-composer-input"
          value={body}
          rows={1}
          onChange={(event) => {
            setBody(event.target.value);
            pingTyping();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="Message…"
          className="max-h-32 min-h-10 flex-1 resize-y rounded-md border border-border bg-surface-sunken px-3 py-2 text-[1rem] placeholder:text-text-muted"
        />
        <button
          type="submit"
          disabled={disabled}
          aria-label="Send message"
          data-testid="message-send-button"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink transition-opacity disabled:opacity-40"
        >
          <SendHorizontal size={18} aria-hidden="true" />
        </button>
      </form>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger" data-testid="message-composer-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
