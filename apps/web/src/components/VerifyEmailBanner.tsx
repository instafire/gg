"use client";

import { GGApiError } from "@gg/sdk";
import { MailWarning, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useSession } from "../lib/session";

const DISMISS_KEY = "gg-verify-banner-dismissed";

type ResendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; devVerificationUrl: string | null }
  | { kind: "error"; message: string };

/**
 * Dismissible banner for logged-in users whose email is not verified yet
 * (D-035). Polls and debate ballots require a verified email (tier T1,
 * D-014), so this is the persistent path back into the verification flow.
 * Dismissal is per-browser (sessionStorage) — it returns next session.
 */
export function VerifyEmailBanner() {
  const { status, user } = useSession();
  const [dismissed, setDismissed] = useState(true);
  const [resend, setResend] = useState<ResendState>({ kind: "idle" });

  useEffect(() => {
    try {
      setDismissed(window.sessionStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);

  if (status !== "authenticated" || !user || user.emailVerified || dismissed) {
    return null;
  }

  function dismiss() {
    try {
      window.sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Storage unavailable — dismiss for this render only.
    }
    setDismissed(true);
  }

  async function onResend() {
    setResend({ kind: "sending" });
    try {
      const result = await api.resendVerification();
      setResend({ kind: "sent", devVerificationUrl: result.devVerificationUrl });
    } catch (cause) {
      setResend({
        kind: "error",
        message:
          cause instanceof GGApiError
            ? cause.detail
            : "Couldn't send the email. Try again in a bit.",
      });
    }
  }

  return (
    <section
      aria-label="Verify your email"
      data-testid="verify-email-banner"
      className="mb-4 flex items-start gap-3 rounded-lg border border-border bg-surface-sunken px-4 py-3"
    >
      <MailWarning size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium text-text">Verify your email to unlock voting</p>
        <p className="mt-0.5 text-text-muted">
          Polls and debate ballots need a verified email. We sent a link to{" "}
          <span className="font-medium text-text">{user.email}</span> when you
          signed up.
        </p>
        {resend.kind === "sent" ? (
          <p className="mt-1.5 text-text" role="status" data-testid="verify-email-resent">
            New link sent — check your inbox.
            {resend.devVerificationUrl ? (
              <>
                {" "}
                <a
                  href={resend.devVerificationUrl}
                  className="font-medium text-link hover:underline"
                  data-testid="verify-email-dev-link"
                >
                  Staging shortcut: verify now
                </a>
              </>
            ) : null}
          </p>
        ) : null}
        {resend.kind === "error" ? (
          <p className="mt-1.5 text-danger" role="alert">
            {resend.message}
          </p>
        ) : null}
        {resend.kind !== "sent" ? (
          <button
            type="button"
            onClick={() => void onResend()}
            disabled={resend.kind === "sending"}
            data-testid="verify-email-resend"
            className="mt-1.5 font-medium text-link hover:underline disabled:opacity-60"
          >
            {resend.kind === "sending" ? "Sending…" : "Resend verification email"}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss verification reminder"
        data-testid="verify-email-dismiss"
        className="shrink-0 rounded-full p-1 text-text-muted transition-colors hover:bg-surface hover:text-text"
      >
        <X size={18} aria-hidden="true" />
      </button>
    </section>
  );
}
