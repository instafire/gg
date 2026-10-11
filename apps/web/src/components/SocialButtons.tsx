"use client";

import type { SocialProvider } from "@gg/sdk";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useLocale } from "../lib/i18n";

/**
 * Social sign-in buttons (D-069). Renders only the providers the API
 * reports as configured — with no provider env set, this renders
 * nothing at all. Navigation is a plain anchor: the flow is a full
 * browser redirect through the provider and back.
 */
export function SocialButtons() {
  const { t } = useLocale();
  const [providers, setProviders] = useState<SocialProvider[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.socialProviders();
        if (!cancelled) setProviders(list);
      } catch {
        if (!cancelled) setProviders([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (providers.length === 0) return null;
  return (
    <div className="flex flex-col gap-3" data-testid="social-buttons">
      <div className="flex items-center gap-3 text-xs text-text-muted">
        <span className="h-px flex-1 bg-border" />
        {t.auth.orContinueWith}
        <span className="h-px flex-1 bg-border" />
      </div>
      {providers.map((provider) => (
        <a
          key={provider.id}
          href={api.socialAuthorizeUrl(provider.id)}
          className="flex min-h-11 items-center justify-center rounded-md border border-border bg-surface px-3 font-medium transition-colors hover:bg-surface-sunken"
          data-testid={`social-login-${provider.id}`}
        >
          Continue with {provider.name}
        </a>
      ))}
    </div>
  );
}
