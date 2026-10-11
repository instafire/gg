import type { Metadata } from "next";
import Link from "next/link";
import { createServerClient } from "../../../../lib/api";
import { StanceBar } from "../../../../components/StanceSlider";

export const metadata: Metadata = {
  title: "GG Debate — embed",
  robots: { index: false },
};

/**
 * Embeddable debate widget (Phase 3): minimal chrome for iframes on
 * genznewz.com and anywhere else — proposition, live stance bar, top
 * argument, and a door back to the full debate. Server-rendered so the
 * numbers are in the first paint; hosts can refresh by reloading the frame.
 */
export default async function DebateEmbed({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = createServerClient();
  let content: React.ReactNode;
  try {
    const [debate, state] = await Promise.all([client.getDebate(id), client.getDebateState(id)]);
    const topPage = await client.listArguments(id, { sort: "top" });
    const top = topPage.items[0] ?? null;
    const winner = debate.sides.find((side) => side.key === debate.winnerSideKey);
    content = (
      <div className="flex min-h-dvh flex-col gap-3 p-4">
        <p className="text-[0.6875rem] font-semibold tracking-wide text-text-muted uppercase">
          GG Debate · {debate.status.replaceAll("_", " ")}
          {debate.status === "closed" || debate.status === "archived"
            ? debate.isDraw
              ? " · draw"
              : winner
                ? ` · ${winner.label} won`
                : ""
            : ""}
        </p>
        <h1 className="font-display text-xl leading-snug font-bold">{debate.proposition}</h1>
        <StanceBar distribution={state.stanceDistribution.pre} label="Audience stance" />
        {top ? (
          <figure className="rounded-md bg-surface-sunken p-3">
            <blockquote className="text-sm leading-relaxed">
              “{top.bodyMd.slice(0, 220)}
              {top.bodyMd.length > 220 ? "…" : ""}”
            </blockquote>
            <figcaption className="mt-1 text-xs text-text-muted">
              Top argument · @{top.author.handle} · score {top.score}
            </figcaption>
          </figure>
        ) : (
          <p className="text-sm text-text-muted">No arguments yet — be the first voice.</p>
        )}
        <p className="text-xs text-text-muted">
          {state.mindChangedCount} minds changed so far
        </p>
        <Link
          href={`/debates/${debate.id}`}
          target="_top"
          className="mt-auto inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-4 text-sm font-semibold text-black"
        >
          Join the debate on GG
        </Link>
      </div>
    );
  } catch {
    content = (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <p className="text-sm text-text-muted">This debate could not be loaded.</p>
      </div>
    );
  }
  return <main className="mx-auto max-w-[560px] bg-surface text-text">{content}</main>;
}
