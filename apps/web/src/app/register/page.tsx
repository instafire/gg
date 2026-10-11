"use client";

import { GGApiError } from "@gg/sdk";
import { MIN_AGE } from "@gg/shared";
import { Button } from "@gg/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { AuthCard, FieldError, inputClassName, labelClassName } from "../../components/AuthCard";
import { SocialButtons } from "../../components/SocialButtons";
import { useLocale } from "../../lib/i18n";
import { useSession } from "../../lib/session";
import {
  validateRegister,
  type RegisterFormErrors,
  type RegisterFormValues,
} from "../../lib/validation";

/** Map API wire field names (problem+json errors) onto form fields. */
const WIRE_FIELD_MAP: Record<string, keyof RegisterFormValues> = {
  handle: "handle",
  display_name: "displayName",
  email: "email",
  password: "password",
  date_of_birth: "dateOfBirth",
};

export default function RegisterPage() {
  const { t } = useLocale();
  const { status, user, register } = useSession();
  const router = useRouter();
  const [values, setValues] = useState<RegisterFormValues>({
    handle: "",
    displayName: "",
    email: "",
    password: "",
    dateOfBirth: "",
  });
  const [errors, setErrors] = useState<RegisterFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // After a successful register we show the "check your email" screen
  // instead of pushing straight into onboarding (D-035).
  const [pendingCheck, setPendingCheck] = useState<{
    email: string;
    devVerificationUrl: string | null;
  } | null>(null);

  useEffect(() => {
    if (pendingCheck) return;
    if (status !== "authenticated") return;
    // Fresh accounts go through onboarding; it bounces completed users home.
    router.replace(user?.onboardingCompletedAt ? "/home" : "/onboarding");
  }, [status, user, router, pendingCheck]);

  function set<K extends keyof RegisterFormValues>(key: K, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const validation = validateRegister(values);
    setErrors(validation);
    if (Object.keys(validation).length > 0) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const result = await register({
        handle: values.handle,
        email: values.email,
        password: values.password,
        displayName: values.displayName || undefined,
        dateOfBirth: values.dateOfBirth,
      });
      setPendingCheck({
        email: values.email,
        devVerificationUrl: result.devVerificationUrl,
      });
    } catch (cause) {
      if (cause instanceof GGApiError && cause.fieldErrors.length > 0) {
        const mapped: RegisterFormErrors = {};
        for (const fieldError of cause.fieldErrors) {
          const key = WIRE_FIELD_MAP[fieldError.field];
          if (key) mapped[key] = fieldError.message;
        }
        setErrors(mapped);
        setFormError(cause.detail);
      } else {
        setFormError(
          cause instanceof GGApiError
            ? cause.isNetworkError
              ? "Can't reach the GG API. Check that it's running, then try again."
              : cause.detail
            : "Couldn't create your account. Try again.",
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (pendingCheck) {
    return (
      <AuthCard
        title="Check your email"
        footer={
          <>
            Wrong address?{" "}
            <button
              type="button"
              onClick={() => setPendingCheck(null)}
              className="font-medium text-link hover:underline"
            >
              Back to sign up
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-4" data-testid="register-check-email">
          <p className="text-sm text-text">
            We sent a verification link to{" "}
            <span className="font-medium">{pendingCheck.email}</span>. Open it to
            verify your email — verified accounts can vote in polls and debates.
            The link works for 24 hours.
          </p>
          {pendingCheck.devVerificationUrl ? (
            <div className="rounded-md bg-surface-sunken px-3 py-2">
              <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
                Staging shortcut — no mailbox yet
              </p>
              <a
                href={pendingCheck.devVerificationUrl}
                className="mt-1 block break-all text-sm font-medium text-link hover:underline"
                data-testid="register-dev-verification-link"
              >
                Verify your email now
              </a>
              <p className="mt-1 text-xs text-text-muted">
                This link is shown on staging only, until real email delivery
                lands. It disappears in production.
              </p>
            </div>
          ) : null}
          <p className="text-sm text-text-muted">
            You can keep setting up your account now — verifying later is fine.
          </p>
          <Button
            type="button"
            onClick={() => router.replace("/onboarding")}
            data-testid="register-continue"
          >
            Continue to GG
          </Button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={t.auth.registerTitle}
      footer={
        <>
          {t.auth.haveAccount}{" "}
          <Link href="/login" className="font-medium text-link hover:underline">
            {t.auth.loginTitle}
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <div>
          <label htmlFor="register-handle" className={labelClassName}>
            {t.auth.handle}
          </label>
          <input
            id="register-handle"
            type="text"
            autoComplete="username"
            value={values.handle}
            onChange={(event) => set("handle", event.target.value)}
            aria-invalid={Boolean(errors.handle)}
            aria-describedby={errors.handle ? "register-handle-error" : "register-handle-hint"}
            className={inputClassName}
            placeholder="your_handle"
            data-testid="register-handle"
          />
          <p id="register-handle-hint" className="mt-1.5 text-sm text-text-muted">
            This is your public @name. Lowercase letters, numbers and underscores.
          </p>
          <FieldError id="register-handle-error" message={errors.handle} />
        </div>
        <div>
          <label htmlFor="register-display-name" className={labelClassName}>
            Display name <span className="font-normal text-text-muted">(optional)</span>
          </label>
          <input
            id="register-display-name"
            type="text"
            autoComplete="name"
            value={values.displayName}
            onChange={(event) => set("displayName", event.target.value)}
            aria-invalid={Boolean(errors.displayName)}
            aria-describedby={errors.displayName ? "register-display-name-error" : undefined}
            className={inputClassName}
            data-testid="register-display-name"
          />
          <FieldError id="register-display-name-error" message={errors.displayName} />
        </div>
        <div>
          <label htmlFor="register-email" className={labelClassName}>
            {t.auth.email}
          </label>
          <input
            id="register-email"
            type="email"
            autoComplete="email"
            value={values.email}
            onChange={(event) => set("email", event.target.value)}
            aria-invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? "register-email-error" : undefined}
            className={inputClassName}
            data-testid="register-email"
          />
          <FieldError id="register-email-error" message={errors.email} />
        </div>
        <div>
          <label htmlFor="register-password" className={labelClassName}>
            {t.auth.password}
          </label>
          <input
            id="register-password"
            type="password"
            autoComplete="new-password"
            value={values.password}
            onChange={(event) => set("password", event.target.value)}
            aria-invalid={Boolean(errors.password)}
            aria-describedby={errors.password ? "register-password-error" : undefined}
            className={inputClassName}
            data-testid="register-password"
          />
          <FieldError id="register-password-error" message={errors.password} />
        </div>
        <div>
          <label htmlFor="register-dob" className={labelClassName}>
            {t.auth.dateOfBirth}
          </label>
          <input
            id="register-dob"
            type="date"
            autoComplete="bday"
            value={values.dateOfBirth}
            onChange={(event) => set("dateOfBirth", event.target.value)}
            aria-invalid={Boolean(errors.dateOfBirth)}
            aria-describedby={errors.dateOfBirth ? "register-dob-error" : "register-dob-hint"}
            className={inputClassName}
            data-testid="register-dob"
          />
          <p id="register-dob-hint" className="mt-1.5 text-sm text-text-muted">
            You must be {MIN_AGE} or older to use GG. We check your age from this date and
            only keep your age bracket (like 13–17) on your account — your exact birthday
            isn't shown to anyone.
          </p>
          <FieldError id="register-dob-error" message={errors.dateOfBirth} />
        </div>
        {formError ? (
          <p role="alert" className="rounded-md bg-surface-sunken px-3 py-2 text-sm text-danger">
            {formError}
          </p>
        ) : null}
        <Button type="submit" disabled={submitting} data-testid="register-submit">
          {submitting ? "…" : t.auth.registerSubmit}
        </Button>
        <SocialButtons />
      </form>
    </AuthCard>
  );
}
