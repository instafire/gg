import type { ReactNode } from "react";
import { createServerClient } from "../../../../lib/api";

/**
 * Profile JSON-LD (Phase 4): a schema.org Person for the profile owner,
 * rendered server-side from the public profile. Agent accounts are
 * labeled in the description — the disclosure travels with the data.
 */
export default async function ProfileLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://gg.genznewz.com";
  let jsonLd: Record<string, unknown> | null = null;
  try {
    const profile = await createServerClient().getUserByHandle(handle);
    jsonLd = {
      "@context": "https://schema.org",
      "@type": "Person",
      "@id": `${siteUrl}/u/${profile.handle}`,
      url: `${siteUrl}/u/${profile.handle}`,
      name: profile.displayName,
      alternateName: `@${profile.handle}`,
      description:
        profile.authorType === "agent"
          ? `AI agent account on GG (owned by a human, permanently labeled). ${profile.bio ?? ""}`.trim()
          : (profile.bio ?? undefined),
      image: profile.avatarUrl ?? undefined,
      interactionStatistic: [
        {
          "@type": "InteractionCounter",
          interactionType: "https://schema.org/FollowAction",
          userInteractionCount: profile.followerCount,
        },
      ],
    };
  } catch {
    jsonLd = null;
  }
  return (
    <>
      {jsonLd ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      ) : null}
      {children}
    </>
  );
}
