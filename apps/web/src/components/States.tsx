import { GGApiError } from "@gg/sdk";
import { Button } from "@gg/ui";

/** Honest, brief empty state (DESIGN_SYSTEM §1 voice). */
export function EmptyState({
  title,
  body,
  testId,
}: {
  title: string;
  body?: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId ?? "empty-state"}
      className="rounded-lg border border-border bg-surface px-5 py-10 text-center"
    >
      <p className="font-display text-lg font-semibold">{title}</p>
      {body ? <p className="mt-2 text-sm text-text-muted">{body}</p> : null}
    </div>
  );
}

/**
 * Error state for failed API loads. A network failure (backend not running)
 * gets the plain "can't reach the API" message instead of a raw error.
 */
export function ApiErrorState({
  error,
  onRetry,
  testId,
}: {
  error: unknown;
  onRetry?: () => void;
  testId?: string;
}) {
  const isNetwork = error instanceof GGApiError && error.isNetworkError;
  const title = isNetwork ? "Can't reach the GG API" : "Something went wrong";
  const body = isNetwork
    ? "The API isn't responding. Check that it's running, then try again."
    : error instanceof GGApiError
      ? error.detail
      : "The request failed. Try again.";
  return (
    <div
      data-testid={testId ?? "api-error-state"}
      role="alert"
      className="rounded-lg border border-border bg-surface px-5 py-10 text-center"
    >
      <p className="font-display text-lg font-semibold">{title}</p>
      <p className="mt-2 text-sm text-text-muted">{body}</p>
      {onRetry ? (
        <div className="mt-5">
          <Button onClick={onRetry} data-testid="retry-button">
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Skeleton cards that preserve post geometry while a feed loads (§6.4 CLS rule). */
export function PostSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-surface p-5" aria-hidden="true">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-full bg-[var(--skeleton)]" />
        <div className="flex flex-col gap-2">
          <div className="h-3 w-32 rounded bg-[var(--skeleton)]" />
          <div className="h-3 w-20 rounded bg-[var(--skeleton)]" />
        </div>
      </div>
      <div className="mt-4 flex flex-col gap-2">
        <div className="h-3 w-full rounded bg-[var(--skeleton)]" />
        <div className="h-3 w-2/3 rounded bg-[var(--skeleton)]" />
      </div>
    </div>
  );
}

export function FeedSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading posts">
      {Array.from({ length: count }, (_, i) => (
        <PostSkeleton key={i} />
      ))}
    </div>
  );
}
