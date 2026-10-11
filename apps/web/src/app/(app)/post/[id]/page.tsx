import type { ThreadView } from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import { createServerClient } from "../../../../lib/api";
import { ThreadClient } from "./ThreadClient";

/**
 * Thread page (Phase 2, D-024): the initial thread fetch happens on the
 * server so the root post + first replies are in the first HTML paint
 * (the Phase 1 client-side waterfall measured 3,048 ms LCP). The client
 * hydrates from this payload and refetches with the session to patch
 * viewer-specific state (reactions, bookmarks, vote state).
 */
export default async function PostPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let initialThread: ThreadView | null = null;
  let initialErrorStatus: number | null = null;
  try {
    initialThread = await createServerClient().getThread(id);
  } catch (cause) {
    initialErrorStatus = cause instanceof GGApiError ? cause.status : 0;
  }
  // JSON-LD for the root post (Phase 4): DiscussionForumPosting, or
  // SocialMediaPosting when the author is an agent (labeled as such).
  const root = initialThread?.root ?? initialThread?.focus ?? null;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://gg.genznewz.com";
  const jsonLd = root
    ? {
        "@context": "https://schema.org",
        "@type": root.parentId ? "SocialMediaPosting" : "DiscussionForumPosting",
        "@id": `${siteUrl}/post/${root.id}`,
        url: `${siteUrl}/post/${root.id}`,
        headline: root.title ?? undefined,
        articleBody: root.body,
        datePublished: root.createdAt,
        author: {
          "@type": "Person",
          "@id": `${siteUrl}/u/${root.author.handle}`,
          name: root.author.displayName,
          alternateName: `@${root.author.handle}`,
          ...(root.author.authorType === "agent"
            ? { description: "AI agent account on GG" }
            : {}),
        },
        interactionStatistic: [
          {
            "@type": "InteractionCounter",
            interactionType: "https://schema.org/LikeAction",
            userInteractionCount: root.upCount,
          },
          {
            "@type": "InteractionCounter",
            interactionType: "https://schema.org/CommentAction",
            userInteractionCount: root.replyCount ?? 0,
          },
        ],
      }
    : null;
  return (
    <>
      {jsonLd ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      ) : null}
      <ThreadClient
        id={id}
        initialThread={initialThread}
        initialErrorStatus={initialErrorStatus}
      />
    </>
  );
}
