"use client";

import { GGApiError } from "@gg/sdk";
import { Mic, Square, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

/**
 * Voice-note recorder (Phase 5A): MediaRecorder → audio upload → ready
 * media id. Falls back to a plain audio file picker where MediaRecorder
 * is unavailable (older browsers / non-secure contexts).
 */
export function VoiceNoteRecorder({
  onReady,
  onError,
}: {
  onReady: (mediaId: string) => void;
  onError?: (message: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [supported] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.MediaRecorder !== "undefined" &&
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia),
  );
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  async function upload(blob: Blob, filename: string) {
    setUploading(true);
    try {
      const file = new File([blob], filename, {
        type: blob.type || "audio/webm",
      });
      const media = await api.uploadMedia(file, { kind: "audio" });
      // The pipeline marks audio ready after the scan; poll briefly.
      let current = media;
      for (let attempt = 0; attempt < 20 && current.status !== "ready"; attempt += 1) {
        if (current.status === "failed" || current.status === "rejected" || current.status === "quarantined") {
          throw new Error("That recording was blocked by the media scanner.");
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        current = await api.getMedia(media.id);
      }
      if (current.status !== "ready") throw new Error("Recording is still processing — try again in a moment.");
      onReady(current.id);
    } catch (cause) {
      onError?.(
        cause instanceof GGApiError
          ? cause.detail
          : cause instanceof Error
            ? cause.message
            : "Voice note upload failed.",
      );
    } finally {
      setUploading(false);
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        void upload(blob, "voice-note.webm");
      };
      recorder.start();
      setRecording(true);
    } catch {
      onError?.("Microphone access was denied.");
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    setRecording(false);
  }

  if (uploading) {
    return (
      <span className="flex h-10 items-center px-2 text-sm text-text-muted" role="status">
        Uploading voice note…
      </span>
    );
  }

  if (!supported) {
    return (
      <>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          className="hidden"
          data-testid="voice-note-file-input"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file, file.name);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          aria-label="Upload a voice note"
          data-testid="voice-note-upload-button"
          className="flex h-10 w-10 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-sunken hover:text-text"
        >
          <Upload size={20} aria-hidden="true" />
        </button>
      </>
    );
  }

  return (
    <button
      type="button"
      onClick={() => (recording ? stopRecording() : void startRecording())}
      aria-label={recording ? "Stop recording" : "Record a voice note"}
      aria-pressed={recording}
      data-testid="voice-note-record-button"
      className={`flex h-10 w-10 items-center justify-center rounded-full transition-colors ${
        recording
          ? "bg-danger text-white"
          : "text-text-muted hover:bg-surface-sunken hover:text-text"
      }`}
    >
      {recording ? (
        <Square size={18} aria-hidden="true" />
      ) : (
        <Mic size={20} aria-hidden="true" />
      )}
    </button>
  );
}
