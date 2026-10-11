"use client";

import { GGApiError, type OAuthAuthorizeInfo } from "@gg/sdk";
import { Button } from "@gg/ui";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AuthCard } from "../../../components/AuthCard";
import { api } from "../../../lib/api";
import { useSession } from "../../../lib/session";

/**
 * /oauth/authorize (D-066) — the consent screen for third-party GG
 * clients using the authorization-code grant. The client sends the
 * user here with client_id/redirect_uri/scope/state/code_challenge;
 * the API validates everything again at decision time, so this page
 * only renders what the API confirms.
 */
function ConsentInner() {
  const searchParams = useSearchParams();
  const { status, user } = useSession();
  const [info, setInfo] = useState<OAuthAuthorizeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const clientId = searchParams.get("client_id") ?? "";
  const redirectUri = searchParams.get("redirect_uri") ?? "";
  const scope = searchParams.get("scope") ?? undefined;
  const state = searchParams.get("state") ?? undefined;
  const codeChallenge = searchParams.get("code_challenge") ?? "";

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.oauthAuthorizeInfo({
          clientId,
          redirectUri,
          scope,
          state,
        });
        if (!cancelled) setInfo(data);
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof GGApiError ? cause.detail : "This authorization request isn't valid.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, clientId, redirectUri, scope, state]);

  async function decide(decision: "approve" | "deny") {
    setBusy(true);
    setError(null);
    try {
      const { redirectTo } = await api.oauthAuthorizeDecision({
        clientId,
        redirectUri,
        scope,
        state,
        codeChallenge,
        decision,
      });
      window.location.href = redirectTo;
    } catch (cause) {
      setError(cause instanceof GGApiError ? cause.detail : "Couldn't record your decision.");
      setBusy(false);
    }
  }

  if (status === "loading") {
    return (
      <AuthCard title="Authorize app" footer={null}>
        <p className="text-sm text-text-soft">Loading…</p>
      </AuthCard>
    );
  }

  if (status !== "authenticated") {
    const next = `/oauth/authorize?${searchParams.toString()}`;
    return (
      <AuthCard title="Authorize app" footer={null}>
        <p className="text-sm text-text-soft">
          Sign in to GG first, then you'll come back here to approve this app.
        </p>
        <Link
          href={`/login?next=${encodeURIComponent(next)}`}
          className="mt-4 flex min-h-11 items-center justify-center rounded-md bg-accent px-3 font-medium text-accent-ink"
          data-testid="consent-login"
        >
          Log in
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Authorize app" footer={null}>
      {error ? (
        <p role="alert" className="rounded-md bg-surface-sunken px-3 py-2 text-sm text-danger" data-testid="consent-error">
          {error}
        </p>
      ) : !info ? (
        <p className="text-sm text-text-soft">Loading the app's request…</p>
      ) : (
        <div className="flex flex-col gap-4" data-testid="consent-screen">
          <p className="text-sm text-text-soft">
            <strong className="text-text">{info.clientName}</strong> wants to access your GG
            account (@{user?.handle}) with these permissions:
          </p>
          <ul className="list-disc rounded-md bg-surface-sunken px-6 py-3 text-sm">
            {info.scopes.map((granted) => (
              <li key={granted} className="py-0.5 font-mono text-[0.8125rem]">
                {granted}
              </li>
            ))}
          </ul>
          <p className="text-sm text-text-muted">
            You'll be sent back to {info.redirectUri} after you choose.
          </p>
          <div className="flex gap-3">
            <Button type="button" disabled={busy} onClick={() => void decide("approve")} data-testid="consent-approve">
              Authorize
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => void decide("deny")} data-testid="consent-deny">
              Deny
            </Button>
          </div>
        </div>
      )}
    </AuthCard>
  );
}

export default function OAuthAuthorizePage() {
  return (
    <Suspense>
      <ConsentInner />
    </Suspense>
  );
}
