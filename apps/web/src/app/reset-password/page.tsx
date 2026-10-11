"use client";

import { GGApiError } from "@gg/sdk";
import { Button } from "@gg/ui";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { AuthCard, FieldError, inputClassName, labelClassName } from "../../components/AuthCard";
import { api } from "../../lib/api";

/**
 * /reset-password?token=… (D-070) — the landing page for the emailed
 * reset link. Success revokes every other session (API-side), so the
 * user signs in fresh with the new password.
 */
function ResetPasswordInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFieldError(undefined);
    if (password.length < 10 || password.length > 128) {
      setFieldError("Password must be 10–128 characters.");
      return;
    }
    if (password !== confirm) {
      setFieldError("Passwords don't match.");
      return;
    }
    if (!token) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (cause) {
      setFormError(
        cause instanceof GGApiError ? cause.detail : "Couldn't reset your password. Try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <AuthCard title="Reset your password" footer={null}>
        <p role="alert" className="rounded-md bg-surface-sunken px-3 py-2 text-sm text-danger">
          This link is missing its reset token. Open the link from your email again, or{" "}
          <Link href="/forgot-password" className="font-medium text-link hover:underline">
            request a new one
          </Link>
          .
        </p>
      </AuthCard>
    );
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
      {done ? (
        <div className="flex flex-col gap-4" data-testid="reset-done">
          <p className="text-sm text-text-soft">
            Your password has been reset, and every other session was signed out.
          </p>
          <Link
            href="/login"
            className="flex min-h-11 items-center justify-center rounded-md bg-accent px-3 font-medium text-accent-ink"
          >
            Log in with your new password
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="reset-password" className={labelClassName}>
              New password
            </label>
            <input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={Boolean(fieldError)}
              aria-describedby={fieldError ? "reset-password-error" : undefined}
              className={inputClassName}
              data-testid="reset-password"
            />
            <FieldError id="reset-password-error" message={fieldError} />
          </div>
          <div>
            <label htmlFor="reset-confirm" className={labelClassName}>
              Confirm new password
            </label>
            <input
              id="reset-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              className={inputClassName}
              data-testid="reset-confirm"
            />
          </div>
          {formError ? (
            <p role="alert" className="rounded-md bg-surface-sunken px-3 py-2 text-sm text-danger">
              {formError}
            </p>
          ) : null}
          <Button type="submit" disabled={submitting} data-testid="reset-submit">
            {submitting ? "…" : "Reset password"}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordInner />
    </Suspense>
  );
}
