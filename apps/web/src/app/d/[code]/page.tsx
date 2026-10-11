import { notFound, redirect } from "next/navigation";
import { createServerClient } from "../../../lib/api";

/** Short debate links: /d/{code} → the canonical debate page. */
export default async function DebateShortLink({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  try {
    const debate = await createServerClient().getDebate(code);
    redirect(`/debates/${debate.id}`);
  } catch {
    notFound();
  }
}
