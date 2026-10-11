import type { Metadata } from "next";
import { DebateRoom } from "../../../../components/DebateRoom";
import { createServerClient } from "../../../../lib/api";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  try {
    const debate = await createServerClient().getDebate(id);
    return {
      title: `${debate.proposition} — GG Debate`,
      description: `A ${debate.format.replaceAll("_", " ")} debate on GG: ${debate.sides
        .map((side) => `${side.label} ${side.argumentCount} arguments`)
        .join(", ")}. ${debate.mindChange.mindChangedCount} minds changed.`,
      openGraph: {
        title: debate.proposition,
        description: "Debate it on GG — stance votes before and after, steelmanning, evidence.",
        type: "article",
      },
    };
  } catch {
    return { title: "Debate — GG" };
  }
}

export default async function DebatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DebateRoom debateId={id} />;
}
