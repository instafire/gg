"use client";

import { GGApiError } from "@gg/sdk";
import { Button } from "@gg/ui";
import { startAuthentication } from "@simplewebauthn/browser";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { AuthCard, FieldError, inputClassName, labelClassName } from "../../components/AuthCard";
import { SocialButtons } from "../../components/SocialButtons";
import { api } from "../../lib/api";
import { useLocale } from "../../lib/i18n";
import { useSession } from "../../lib/session";
import { validateLogin } from "../../lib/validation";

const SOCIAL_ERRORS: Record<string, string> = {
  social_unavailable: "That sign-in method isn't available right now.",
  social_failed: "Social sign-in didn't complete. Try again or use your password.",
  social_state: "Social sign-in expired. Try again.",
  social_unverified:
    "Your provider email isn't verified, so it can't be used to sign in to GG.",
  account_inactive: "This account is not active.",
};

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof GGApiError
    ? cause.isNetworkError
      ? "Can't reach the GG API. Check that it's running, then try again."
      : cause.detail
    : fallback;
}

function LoginInner() {
  const { t } = useLocale();
  const { status, login, refreshUser } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Second-factor step (D-067): set after a password login is gated, or
  // directly when arriving from a social login (?totp=1 — the challenge
  // then rides in the gg_login_challenge cookie instead of the body).
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [totpStep, setTotpStep] = useState(searchParams.get("totp") === "1");
  const [code, setCode] = useState("");

  // ?next= returns the user to an in-app destination (e.g. the OAuth
  // consent screen) after login; only same-origin paths are honored.
  const nextParam = searchParams.get("next");
  const nextPath =
    nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//")
      ? nextParam
      : "/home";

  useEffect(() => {
    if (status === "authenticated") router.replace(nextPath);
  }, [status, router, nextPath]);

  useEffect(() => {
    const error = searchParams.get("error");
    if (error && SOCIAL_ERRORS[error]) setFormError(SOCIAL_ERRORS[error]);
  }, [searchParams]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const validation = validateLogin({ email, password });
    setErrors(validation);
    if (validation.email || validation.password) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const result = await login({ email, password });
      if (result.totpRequired) {
        setChallengeToken(result.challengeToken);
        setTotpStep(true);
        return;
      }
      router.replace(nextPath);
    } catch (cause) {
      setFormError(errorMessage(cause, "Couldn't log you in. Try again."));
    } finally {
      setSubmitting(false);
    }
  }

  async function onVerifyTotp(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      await api.verifyTotp({
        code: code.trim(),
        ...(challengeToken ? { challengeToken } : {}),
      });
      await refreshUser().catch(() => undefined);
      router.replace(nextPath);
    } catch (cause) {
      setFormError(errorMessage(cause, "That code didn't work. Try again."));
    } finally {
      setSubmitting(false);
    }
  }

  async function onPasskeyLogin() {
    setSubmitting(true);
    setFormError(null);
    try {
      const options = await api.passkeyLoginOptions();
      const credential = await startAuthentication({
        optionsJSON: options as unknown as Parameters<
          typeof startAuthentication
        >[0]["optionsJSON"],
      });
      await api.passkeyLoginVerify(
        credential as unknown as Record<string, unknown>,
      );
      await refreshUser().catch(() => undefined);
      router.replace("/home");
    } catch (cause) {
      setFormError(errorMessage(cause, "Passkey sign-in was cancelled or failed."));
    } finally {
      setSubmitting(false);
    }
  }

  if (totpStep) {
    return (
      <AuthCard
        title={t.auth.totpTitle}
        footer={
          <button
            type="button"
            className="font-medium text-link hover:underline"
            onClick={() => {
              setTotpStep(false);
              setChallengeToken(null);
            }}
          >
            Back to log in
          </button>
        }
      >
        <form onSubmit={onVerifyTotp} className="flex flex-col gap-4">
          <p className="text-sm text-text-soft">{t.auth.totpPrompt}</p>
          <div>
            <label htmlFor="login-totp-code" className={labelClassName}>
              Code
            </label>
            <input
              id="login-totp-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              className={inputClassName}
              data-testid="login-totp-code"
            />
          </div>
          {formError ? (
            <p role="alert" className="rounded-md bg-surface-sunken px-3 py-2 text-sm text-danger">
              {formError}
            </p>
          ) : null}
          <Button type="submit" disabled={submitting || code.trim().length < 6} data-testid="login-totp-submit">
            {submitting ? "…" : t.auth.totpSubmit}
          </Button>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={t.auth.loginTitle}
      footer={
        <>
          {t.auth.needAccount}{" "}
          <Link href="/register" className="font-medium text-link hover:underline">
            {t.auth.createOne}
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <div>
          <label htmlFor="login-email" className={labelClassName}>
            {t.auth.email}
          </label>
          <input
            id="login-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? "login-email-error" : undefined}
            className={inputClassName}
            data-testid="login-email"
          />
          <FieldError id="login-email-error" message={errors.email} />
        </div>
        <div>
          <label htmlFor="login-password" className={labelClassName}>
            {t.auth.password}
          </label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={Boolean(errors.password)}
            aria-describedby={errors.password ? "login-password-error" : undefined}
            className={inputClassName}
            data-testid="login-password"
          />
          <FieldError id="login-password-error" message={errors.password} />
        </div>
        <div className="-mt-2 text-right">
          <Link href="/forgot-password" className="text-sm font-medium text-link hover:underline">
            {t.auth.forgotPassword}
          </Link>
        </div>
        {formError ? (
          <p role="alert" className="rounded-md bg-surface-sunken px-3 py-2 text-sm text-danger">
            {formError}
          </p>
        ) : null}
        <Button type="submit" disabled={submitting} data-testid="login-submit">
          {submitting ? "…" : t.auth.loginSubmit}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={submitting}
          onClick={() => void onPasskeyLogin()}
          data-testid="login-passkey"
        >
          {t.auth.passkeySubmit}
        </Button>
        <SocialButtons />
      </form>
    </AuthCard>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}
