import { GGClient } from "@gg/sdk";

/**
 * Browser API base URL. `NEXT_PUBLIC_API_BASE_URL` wins; the repo's
 * .env.example name (`NEXT_PUBLIC_API_URL`) is honored as a fallback.
 * The backend runs at :4000 on the laptop in local dev.
 */
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:4000";

/** Singleton client — the access token lives in its memory only. */
export const api = new GGClient({ baseUrl: API_BASE_URL });

/**
 * Anonymous client for server components (Phase 2, D-024): the thread page
 * renders its first paint from a server-side fetch so the content is in the
 * HTML — no client waterfall before LCP. Viewer-specific state is patched
 * in by the client after mount.
 */
export function createServerClient(): GGClient {
  const base = process.env.API_BASE_URL ?? API_BASE_URL;
  return new GGClient({ baseUrl: base, credentials: "omit" });
}
