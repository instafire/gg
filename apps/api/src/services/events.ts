/**
 * Product analytics event log (Phase 5B).
 *
 * One writer for the `events` table. Two call styles:
 * - `logEvent(db, …)` — awaited, for low-frequency actions (post.create,
 *   follow, report, …) where the insert rides along with the request.
 * - `logEventSoon(ctx.db, …)` — fire-and-forget for hot paths (feed
 *   impressions, post views): the insert is a single round-trip issued
 *   without blocking the response; failures are logged, never thrown.
 *
 * Feed impressions batch: one `feed.impression` row per served page with
 * `props.post_ids` — never one row per post.
 */
import type { Db } from "../db";
import { events } from "../db/schema";
import { uuidv7 } from "../lib/ids";

export type EventType =
  | "post.view"
  | "feed.impression"
  | "post.create"
  | "post.vote"
  | "poll.vote"
  | "debate.argument"
  | "debate.completed"
  | "follow"
  | "report"
  | "dm.sent";

export interface EventInput {
  userId: string | null;
  type: EventType;
  subjectType?: string | null;
  subjectId?: string | null;
  props?: Record<string, unknown>;
}

export async function logEvent(db: Db, input: EventInput): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(),
    userId: input.userId,
    type: input.type,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    props: input.props ?? {},
  });
}

/** Fire-and-forget variant for hot paths; never throws into the request. */
export function logEventSoon(db: Db, input: EventInput, log?: { error: (obj: unknown, msg: string) => void }): void {
  logEvent(db, input).catch((error: unknown) => {
    log?.error({ err: error, eventType: input.type }, "event log write failed");
  });
}
