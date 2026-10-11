"use client";

import { GGApiError } from "@gg/sdk";
import { Button } from "@gg/ui";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { AuthCard } from "../../components/AuthCard";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";

type Phase =
  | { kind: "verifying" }
  | { kind: "success" }
  | { kind: "error"; message: string };

const GENERIC_ERROR =
  "This verification link is invalid or has expired. Request a new one and try again.";

function VerifyEmailInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { status, user, refreshUser } = useSession();
  const token = searchParams.get("token");
  const [phase, setPhase] = useState<Phase>({ kind: "verifying" });
  const startedRef = useRef(false);

  useEffect(() => {
    // The token is single-use — never fire the call twice for one mount.
    if (startedRef.current) return;
    startedRef.current = true;
    if (!token) {
      setPhase({
        kind: "error",
        message:
          "This link is missing its verification token. Open the link from your email again, or request a new one.",
      });
      return;
    }
    void (async () => {
      try {
        await api.verifyEmail(token);
        // If we're logged in, pull the fresh user (verified + tier T1) so
        // the unverified banner and tier gates update immediately.
        await refreshUser().catch(() => undefined);
        setPhase({ kind: "success" });
      } catch (cause) {
        setPhase({
          kind: "error",
          message: cause instanceof GGApiError ? cause.detail : GENERIC_ERROR,
        });
      }
    })();
    // One-shot effect: refreshUser identity is stable; the ref guard above
    // is what prevents a second (token-burning) call.
  }, [token]);

  // A fresh account verifies BEFORE it ever sees onboarding — sending it
  // straight to /home skipped onboarding entirely (found in the 2026-10-11
  // UI pass: every verified signup landed on the feed with no topics,
  // communities, or follows). Route by onboarding state, same as the
  // login/register flows.
  const destination = user?.onboardingCompletedAt ? "/home" : "/onboarding";

  useEffect(() => {
    if (phase.kind !== "success" || status !== "authenticated") return;
    const timer = setTimeout(() => router.replace(destination), 1500);
    return () => clearTimeout(timer);
  }, [phase, status, router, destination]);

  return (
    <AuthCard
      title="Verify your email"
      footer={
        <Link href="/home" className="font-medium text-link hover:underline">
          Back to GG
        </Link>
      }
    >
      {phase.kind === "verifying" ? (
        <p className="text-sm text-text" aria-live="polite" data-testid="verify-email-pending">
          Verifying your email…
        </p>
      ) : null}

      {phase.kind === "success" ? (
        <div className="flex flex-col gap-4" data-testid="verify-email-success">
          <p className="text-sm text-text" role="status">
            Your email is verified. Your account is now trust tier T1 — you can
            vote in polls and debates.
          </p>
          {status === "authenticated" ? (
            <Button
              type="button"
              onClick={() => router.replace(destination)}
              data-testid="verify-email-continue"
            >
              {user?.onboardingCompletedAt ? "Go to GG home" : "Continue to setup"}
            </Button>
          ) : (
            <Link href="/login" className="text-sm font-medium text-link hover:underline">
              Log in to continue
            </Link>
          )}
        </div>
      ) : null}

      {phase.kind === "error" ? (
        <div className="flex flex-col gap-4" data-testid="verify-email-error">
          <p className="text-sm text-danger" role="alert">
            {phase.message}
          </p>
          {status === "authenticated" ? (
            <p className="text-sm text-text-muted">
              You can request a fresh link from the banner on any page, or from
              Settings → Account.
            </p>
          ) : (
            <p className="text-sm text-text-muted">
              Log in and request a fresh verification link from Settings →
              Account.
            </p>
          )}
        </div>
      ) : null}
    </AuthCard>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense
      fallback={
        <AuthCard title="Verify your email" footer={null}>
          <p className="text-sm text-text">Loading…</p>
        </AuthCard>
      }
    >
      <VerifyEmailInner />
    </Suspense>
  );
}
