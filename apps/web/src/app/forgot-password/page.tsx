"use client";

import { GGApiError } from "@gg/sdk";
import { Button } from "@gg/ui";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { AuthCard, inputClassName, labelClassName } from "../../components/AuthCard";
import { api } from "../../lib/api";

/**
 * /forgot-password (D-070). Always answers as if the email exists
 * (the API is enumeration-safe). On staging — while the log mailer is
 * active — the API hands back the reset link and we show it, mirroring
 * the D-035 verification affordance; with SMTP configured, the link
 * only exists in the inbox.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [devResetUrl, setDevResetUrl] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      const result = await api.forgotPassword(email.trim());
      setDevResetUrl(result.devResetUrl);
      setSent(true);
    } catch (cause) {
      setFormError(
        cause instanceof GGApiError
          ? cause.isNetworkError
            ? "Can't reach the GG API. Check that it's running, then try again."
            : cause.detail
          : "Couldn't start the reset. Try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard
      title="Reset your password"
      footer={
        <Link href="/login" className="font-medium text-link hover:underline">
          Back to log in
        </Link>
      }
    >
      {sent ? (
        <div className="flex flex-col gap-4" data-testid="forgot-sent">
          <p className="text-sm text-text-soft">
            If an account exists for that email, a reset link is on its way.
            It expires in 1 hour.
          </p>
          {devResetUrl ? (
            <p className="rounded-md bg-surface-sunken px-3 py-2 text-sm">
              Staging shortcut (log mailer):{" "}
              <a href={devResetUrl} className="font-medium text-link hover:underline" data-testid="forgot-dev-reset-link">
                open the reset link
              </a>
            </p>
          ) : null}
        </div>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="forgot-email" className={labelClassName}>
              Email
            </label>
            <input
              id="forgot-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={inputClassName}
              data-testid="forgot-email"
            />
          </div>
          {formError ? (
            <p role="alert" className="rounded-md bg-surface-sunken px-3 py-2 text-sm text-danger">
              {formError}
            </p>
          ) : null}
          <Button type="submit" disabled={submitting || !email.trim()} data-testid="forgot-submit">
            {submitting ? "…" : "Send reset link"}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
