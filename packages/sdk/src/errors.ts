/**
 * Error type for the GG API client.
 *
 * Carries the RFC 9457 problem+json fields the API returns (docs/API_SPEC.yaml
 * components/schemas/Problem) so callers can render `detail` directly and
 * branch on the machine-readable `code`. Network-level failures (API
 * unreachable — DNS, connection refused, offline) surface with `status: 0`
 * and `isNetworkError: true` so UIs can show a "can't reach the API" state
 * instead of a misleading HTTP error.
 */
export interface ProblemFieldError {
  field: string;
  message: string;
}

export class GGApiError extends Error {
  /** HTTP status, or 0 for a network-level failure. */
  readonly status: number;
  /** Machine-readable problem code, e.g. `vote.duplicate` (when provided). */
  readonly code: string | null;
  /** Human-readable problem detail (falls back to the title/status text). */
  readonly detail: string;
  /** Per-field validation errors (422 responses). */
  readonly fieldErrors: ProblemFieldError[];
  readonly requestId: string | null;
  readonly isNetworkError: boolean;

  constructor(
    status: number,
    detail: string,
    options: {
      code?: string | null;
      fieldErrors?: ProblemFieldError[];
      requestId?: string | null;
      isNetworkError?: boolean;
    } = {},
  ) {
    super(`GG API ${status}: ${detail}`);
    this.name = "GGApiError";
    this.status = status;
    this.detail = detail;
    this.code = options.code ?? null;
    this.fieldErrors = options.fieldErrors ?? [];
    this.requestId = options.requestId ?? null;
    this.isNetworkError = options.isNetworkError ?? false;
  }
}
