"use client";

import { GGApiError } from "@gg/sdk";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ConversationList } from "../../../components/ConversationList";
import { api } from "../../../lib/api";
import { RequireAuth } from "../../../lib/session";

export default function MessagesPage() {
  return (
    <RequireAuth>
      <Inbox />
    </RequireAuth>
  );
}

function Inbox() {
  const router = useRouter();
  const [tab, setTab] = useState<"main" | "requests">("main");
  const [handles, setHandles] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  async function startConversation(event: FormEvent) {
    event.preventDefault();
    const parsed = handles
      .split(/[,\s]+/)
      .map((h) => h.trim().replace(/^@/, ""))
      .filter(Boolean);
    if (parsed.length === 0) return;
    setStarting(true);
    setError(null);
    try {
      const conversation = await api.createConversation(parsed);
      router.push(`/messages/${conversation.id}`);
    } catch (cause) {
      setError(
        cause instanceof GGApiError ? cause.detail : "Couldn't start that conversation.",
      );
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-bold">Messages</h1>

      <form
        onSubmit={startConversation}
        className="rounded-lg border border-border bg-surface p-4"
        data-testid="new-message-form"
      >
        <label htmlFor="new-message-handles" className="text-sm font-medium">
          New message — @handle (comma-separate for a group, up to 50)
        </label>
        <div className="mt-2 flex gap-2">
          <input
            id="new-message-handles"
            data-testid="new-message-handles"
            value={handles}
            onChange={(event) => setHandles(event.target.value)}
            placeholder="e.g. priya, aman"
            className="min-h-11 flex-1 rounded-md border border-border bg-surface-sunken px-3"
          />
          <button
            type="submit"
            disabled={starting || handles.trim().length === 0}
            data-testid="new-message-submit"
            className="min-h-11 rounded-full bg-accent px-4 font-semibold text-accent-ink disabled:opacity-40"
          >
            {starting ? "Starting…" : "Start"}
          </button>
        </div>
        {error ? (
          <p role="alert" className="mt-2 text-sm text-danger" data-testid="new-message-error">
            {error}
          </p>
        ) : null}
      </form>

      <div role="tablist" aria-label="Message boxes" className="flex gap-2">
        {(
          [
            { value: "main", label: "Inbox" },
            { value: "requests", label: "Requests" },
          ] as const
        ).map((option) => (
          <button
            key={option.value}
            role="tab"
            aria-selected={tab === option.value}
            data-testid={`messages-tab-${option.value}`}
            onClick={() => setTab(option.value)}
            className={`min-h-11 rounded-full px-4 font-medium transition-colors ${
              tab === option.value
                ? "bg-accent text-accent-ink"
                : "bg-surface-sunken text-text-soft hover:text-text"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <section className="overflow-hidden rounded-lg border border-border bg-surface">
        <ConversationList box={tab} key={tab} />
      </section>
    </div>
  );
}
