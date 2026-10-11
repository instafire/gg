"use client";

import { GGApiError } from "@gg/sdk";
import { Button } from "@gg/ui";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { FieldError, inputClassName, labelClassName } from "../../../../components/AuthCard";
import { api } from "../../../../lib/api";
import { useSession } from "../../../../lib/session";

/**
 * Press-and-hold confirm for destructive actions (DESIGN_SYSTEM: destructive
 * actions confirm by hold, not by an extra dialog hop). Hold 1.5s to fire;
 * releasing early cancels. Keyboard: hold Enter or Space.
 */
function HoldToConfirm({
  label,
  holdingLabel,
  onConfirm,
  testId,
}: {
  label: string;
  holdingLabel: string;
  onConfirm: () => void;
  testId?: string;
}) {
  const [progress, setProgress] = useState(0);
  const frame = useRef<number | null>(null);
  const startedAt = useRef<number>(0);
  const HOLD_MS = 1500;

  function cancel() {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    setProgress(0);
  }

  function start() {
    startedAt.current = performance.now();
    const tick = (now: number) => {
      const ratio = Math.min(1, (now - startedAt.current) / HOLD_MS);
      setProgress(ratio);
      if (ratio >= 1) {
        frame.current = null;
        setProgress(0);
        onConfirm();
        return;
      }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }

  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={`${label}. Press and hold to confirm.`}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && frame.current === null) start();
      }}
      onKeyUp={cancel}
      className="relative min-h-12 overflow-hidden rounded-lg bg-danger px-5 font-semibold text-white"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 bg-black/25"
        style={{ width: `${progress * 100}%` }}
      />
      <span className="relative">{progress > 0 ? holdingLabel : label}</span>
    </button>
  );
}

/** /settings/account — email verification, change password, change email, deactivate. */
export default function SettingsAccountPage() {
  const router = useRouter();
  const { user, logout } = useSession();

  const [resendState, setResendState] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "sent"; devVerificationUrl: string | null }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSaving, setPwSaving] = useState(false);
  const [pwSaved, setPwSaved] = useState(false);

  const [newEmail, setNewEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailSaved, setEmailSaved] = useState(false);

  const [deactivating, setDeactivating] = useState(false);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);

  async function onChangePassword(event: FormEvent) {
    event.preventDefault();
    setPwError(null);
    setPwSaved(false);
    if (newPw.length < 10 || newPw.length > 128) {
      setPwError("New password must be 10–128 characters.");
      return;
    }
    if (newPw !== confirmPw) {
      setPwError("New password and confirmation don't match.");
      return;
    }
    setPwSaving(true);
    try {
      await api.changePassword({
        ["currentPassword"]: currentPw,
        ["newPassword"]: newPw,
      });
      setPwSaved(true);
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
    } catch (cause) {
      setPwError(
        cause instanceof GGApiError
          ? cause.isNetworkError
            ? "Can't reach the GG API. Try again."
            : cause.detail
          : "Couldn't change your password.",
      );
    } finally {
      setPwSaving(false);
    }
  }

  async function onEmailChange(event: FormEvent) {
    event.preventDefault();
    setEmailError(null);
    setEmailSaved(false);
    setEmailSaving(true);
    try {
      await api.requestEmailChange(newEmail.trim());
      setEmailSaved(true);
    } catch (cause) {
      setEmailError(
        cause instanceof GGApiError ? cause.detail : "Couldn't record that request.",
      );
    } finally {
      setEmailSaving(false);
    }
  }

  async function onDeactivate() {
    setDeactivating(true);
    setDeactivateError(null);
    try {
      await api.deactivateAccount();
      // The session is dead server-side; clear local state and leave.
      await logout().catch(() => undefined);
      router.replace("/login");
    } catch (cause) {
      setDeactivateError(
        cause instanceof GGApiError ? cause.detail : "Couldn't deactivate the account.",
      );
      setDeactivating(false);
    }
  }

  async function onResendVerification() {
    setResendState({ kind: "sending" });
    try {
      const result = await api.resendVerification();
      setResendState({ kind: "sent", devVerificationUrl: result.devVerificationUrl });
    } catch (cause) {
      setResendState({
        kind: "error",
        message:
          cause instanceof GGApiError
            ? cause.detail
            : "Couldn't send the verification email. Try again in a bit.",
      });
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <section
        className="rounded-lg border border-border bg-surface p-5"
        aria-label="Email verification"
        data-testid="account-email-verification"
      >
        <h2 className="font-display text-lg font-semibold">Email verification</h2>
        {user ? (
          <>
            <p className="mt-1 text-sm text-text-muted">
              Your account email is <span className="font-medium text-text">{user.email}</span>.
            </p>
            <p className="mt-2 text-sm" data-testid="account-email-verified-status">
              {user.emailVerified ? (
                <span className="font-medium text-text">
                  Verified ✓ — trust tier {user.trustTier}, polls and debate ballots unlocked.
                </span>
              ) : (
                <span className="font-medium text-text">
                  Not verified yet — polls and debate ballots stay locked until you verify.
                </span>
              )}
            </p>
            {!user.emailVerified ? (
              <div className="mt-3 flex flex-col gap-2">
                <div>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={resendState.kind === "sending"}
                    onClick={() => void onResendVerification()}
                    data-testid="account-resend-verification"
                  >
                    {resendState.kind === "sending"
                      ? "Sending…"
                      : "Resend verification email"}
                  </Button>
                </div>
                {resendState.kind === "sent" ? (
                  <p role="status" className="text-sm text-text-soft">
                    New link sent — check your inbox.
                    {resendState.devVerificationUrl ? (
                      <>
                        {" "}
                        <a
                          href={resendState.devVerificationUrl}
                          className="font-medium text-link hover:underline"
                          data-testid="account-dev-verification-link"
                        >
                          Staging shortcut: verify now
                        </a>
                      </>
                    ) : null}
                  </p>
                ) : null}
                {resendState.kind === "error" ? (
                  <p role="alert" className="text-sm text-danger">
                    {resendState.message}
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          <p className="mt-1 text-sm text-text-muted">Loading your account…</p>
        )}
      </section>

      <section
        className="rounded-lg border border-border bg-surface p-5"
        aria-label="Change password"
      >
        <h2 className="font-display text-lg font-semibold">Change password</h2>
        <p className="mt-1 text-sm text-text-muted">
          Changing your password signs out every other device. This device stays signed in.
        </p>
        <form onSubmit={onChangePassword} className="mt-4 flex flex-col gap-4">
          <div>
            <label htmlFor="account-current-password" className={labelClassName}>
              Current password
            </label>
            <input
              id="account-current-password"
              type="password"
              autoComplete="current-password"
              value={currentPw}
              onChange={(event) => setCurrentPw(event.target.value)}
              className={inputClassName}
              data-testid="account-current-password"
            />
          </div>
          <div>
            <label htmlFor="account-new-password" className={labelClassName}>
              New password
            </label>
            <input
              id="account-new-password"
              type="password"
              autoComplete="new-password"
              value={newPw}
              onChange={(event) => setNewPw(event.target.value)}
              className={inputClassName}
              data-testid="account-new-password"
            />
          </div>
          <div>
            <label htmlFor="account-confirm-password" className={labelClassName}>
              Confirm new password
            </label>
            <input
              id="account-confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPw}
              onChange={(event) => setConfirmPw(event.target.value)}
              className={inputClassName}
              data-testid="account-confirm-password"
            />
          </div>
          <FieldError id="account-password-error" message={pwError ?? undefined} />
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pwSaving} data-testid="account-password-save">
              {pwSaving ? "Changing…" : "Change password"}
            </Button>
            {pwSaved ? (
              <span role="status" className="text-sm font-medium text-text-soft">
                Password changed ✓ Other devices were signed out.
              </span>
            ) : null}
          </div>
        </form>
      </section>

      <section
        className="rounded-lg border border-border bg-surface p-5"
        aria-label="Change email"
      >
        <h2 className="font-display text-lg font-semibold">Change email</h2>
        <p className="mt-1 text-sm text-text-muted">
          We'll record the request now; the confirmation step arrives with the email
          delivery update.
        </p>
        <form onSubmit={onEmailChange} className="mt-4 flex flex-col gap-4">
          <div>
            <label htmlFor="account-new-email" className={labelClassName}>
              New email
            </label>
            <input
              id="account-new-email"
              type="email"
              autoComplete="email"
              value={newEmail}
              onChange={(event) => setNewEmail(event.target.value)}
              className={inputClassName}
              data-testid="account-new-email"
            />
          </div>
          <FieldError id="account-email-error" message={emailError ?? undefined} />
          <div className="flex items-center gap-3">
            <Button
              type="submit"
              variant="ghost"
              disabled={emailSaving || !newEmail.trim()}
              data-testid="account-email-save"
            >
              {emailSaving ? "Recording…" : "Request email change"}
            </Button>
            {emailSaved ? (
              <span role="status" className="text-sm font-medium text-text-soft">
                Request recorded ✓
              </span>
            ) : null}
          </div>
        </form>
      </section>

      <section
        className="rounded-lg border border-danger/60 bg-surface p-5"
        aria-label="Deactivate account"
      >
        <h2 className="font-display text-lg font-semibold text-danger">Deactivate account</h2>
        <p className="mt-1 text-sm text-text-muted">
          Your profile and posts disappear, you're signed out everywhere, and signing in
          is blocked while the account is deactivated. This is reversible by the GG team
          for now — a self-serve reactivate flow lands later.
        </p>
        {deactivateError ? (
          <p role="alert" className="mt-3 rounded-md bg-surface-sunken px-3 py-2 text-sm text-danger">
            {deactivateError}
          </p>
        ) : null}
        <div className="mt-4">
          <HoldToConfirm
            label={deactivating ? "Deactivating…" : "Hold to deactivate"}
            holdingLabel="Keep holding…"
            onConfirm={() => void onDeactivate()}
            testId="account-deactivate-hold"
          />
        </div>
      </section>
    </div>
  );
}
