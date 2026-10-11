import type { CommunityView } from "@gg/sdk";
import Link from "next/link";
import { formatCount } from "../lib/format";

/** Community summary card (communities index, search results, onboarding). */
export function CommunityCard({ community }: { community: CommunityView }) {
  return (
    <Link
      href={`/c/${community.slug}`}
      data-testid="community-card"
      className="flex items-center gap-4 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-border-strong"
    >
      <span
        aria-hidden="true"
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-accent-tint font-display text-lg font-bold"
      >
        {community.name.trim()[0]?.toUpperCase() ?? "?"}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-display font-semibold">{community.name}</span>
        <span className="block truncate text-sm text-text-muted">
          c/{community.slug} · {formatCount(community.memberCount)} members
        </span>
        {community.description ? (
          <span className="mt-0.5 block truncate text-sm text-text-soft">
            {community.description}
          </span>
        ) : null}
      </span>
    </Link>
  );
}
