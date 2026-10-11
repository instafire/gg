"use client";

import { use } from "react";
import { MessageThread } from "../../../../components/MessageThread";
import { RequireAuth } from "../../../../lib/session";

export default function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <RequireAuth>
      <div className="flex min-h-[70vh] flex-col overflow-hidden rounded-lg border border-border bg-surface">
        <MessageThread conversationId={id} />
      </div>
    </RequireAuth>
  );
}
