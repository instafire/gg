/**
 * Phase 5A — worker social jobs against a real database (gg_test).
 * Skipped unless TEST_DATABASE_URL is set:
 *   TEST_DATABASE_URL=postgres://…/gg_test pnpm vitest run test/social-db.test.ts
 * Seeds raw rows, runs the same drizzle repos the BullMQ consumers use,
 * and asserts the persisted outcomes (publish claim + mention side
 * effects, trending snapshot contents).
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createWorkerDb } from "../src/db";
import { drizzleScheduledRepo, publishDueScheduledPosts } from "../src/scheduled";
import { computeTrending, drizzleTrendingRepo } from "../src/trending";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function rowsOf(result: unknown): any[] {
  return ((result as { rows?: any[] }).rows ?? (result as any[])) as any[];
}

describe.skipIf(!TEST_DATABASE_URL)("worker social jobs (DB integration)", () => {
  const { db, client } = createWorkerDb(TEST_DATABASE_URL!);
  const suffix = Math.random().toString(36).slice(2, 10);
  const authorId = randomUUID();
  const friendId = randomUUID();
  const scheduledPostId = randomUUID();
  const viralPostId = randomUUID();
  const replyId = randomUUID();
  const extraPostIds: string[] = [];
  const tag = `w5tag${suffix}`;

  afterAll(async () => {
    await db.execute(sql`delete from notifications where recipient_id = ${friendId}`);
    await db.execute(sql`delete from post_mentions where post_id in (${scheduledPostId}, ${viralPostId})`);
    await db.execute(sql`delete from vote_audit where target_id = ${viralPostId}`);
    await db.execute(sql`delete from posts where id in (${replyId}, ${scheduledPostId}, ${viralPostId})`);
    if (extraPostIds.length > 0) {
      await db.execute(sql`delete from posts where id in (${sql.join(extraPostIds.map((id) => sql`${id}`), sql`, `)})`);
    }
    await db.execute(sql`delete from users where id in (${authorId}, ${friendId})`);
    await client.end();
  });

  it("publishes a due scheduled post with mention side effects; trending snapshot ranks velocity", async () => {
    const friendHandle = `w5frnd_${suffix}`;
    await db.execute(sql`
      insert into users (id, handle) values
        (${authorId}, ${`w5auth_${suffix}`}),
        (${friendId}, ${friendHandle})
    `);
    const mention = `@${friendHandle}`;
    await db.execute(sql`
      insert into posts (id, short_code, author_id, author_type, type, body_md, root_id, path, path_label, scheduled_for)
      values (${scheduledPostId}, ${`w5s${suffix}`}, ${authorId}, 'human', 'TEXT',
              ${`later post ${mention} #${tag}`}, ${scheduledPostId}, ${`w5s${suffix}`}, ${`w5s${suffix}`},
              now() - interval '1 minute')
    `);
    await db.execute(sql`
      insert into posts (id, short_code, author_id, author_type, type, body_md, root_id, path, path_label)
      values (${viralPostId}, ${`w5v${suffix}`}, ${authorId}, 'human', 'TEXT',
              ${`viral #${tag} and again #${tag.toUpperCase()}`}, ${viralPostId}, ${`w5v${suffix}`}, ${`w5v${suffix}`})
    `);
    await db.execute(sql`
      insert into posts (id, short_code, author_id, author_type, type, body_md, root_id, path, path_label, parent_id)
      values (${replyId}, ${`w5r${suffix}`}, ${friendId}, 'human', 'TEXT', 'a reply',
              ${viralPostId}, ${`w5v${suffix}`}, ${`w5r${suffix}`}, ${viralPostId})
    `);
    // 30 audit upvotes → velocity 32 with the reply, safely above any
    // other suite's posts in the shared gg_test window (top-10 slice).
    for (let i = 0; i < 30; i += 1) {
      const voter = i % 2 === 0 ? authorId : friendId;
      await db.execute(sql`
        insert into vote_audit (voter_id, target_type, target_id, new_value, change_kind)
        values (${voter}, 'post', ${viralPostId}, 1, 'cast')
      `);
    }
    // Three more posts carrying the tag → count 5, safely inside the
    // hashtag top-10 slice as well.
    for (let i = 0; i < 3; i += 1) {
      const extraId = randomUUID();
      extraPostIds.push(extraId);
      await db.execute(sql`
        insert into posts (id, short_code, author_id, author_type, type, body_md, root_id, path, path_label)
        values (${extraId}, ${`w5x${suffix}${i}`}, ${authorId}, 'human', 'TEXT',
                ${`extra #${tag}`}, ${extraId}, ${`w5x${suffix}${i}`}, ${`w5x${suffix}${i}`})
      `);
    }

    // 1) Scheduled publisher (returns a count; the DB assertions below
    // pin the side effects to THIS post).
    const { published } = await publishDueScheduledPosts(
      drizzleScheduledRepo(db),
      new Date(),
    );
    expect(published).toBeGreaterThanOrEqual(1);
    const postRows = await db.execute(sql`
      select scheduled_for as "scheduledFor", published_at as "publishedAt"
      from posts where id = ${scheduledPostId}
    `);
    const postRow = rowsOf(postRows)[0];
    expect(postRow.scheduledFor).toBeNull();
    expect(postRow.publishedAt).toBeTruthy();
    const mentionRows = await db.execute(sql`
      select count(*)::int as n from post_mentions
      where post_id = ${scheduledPostId} and mentioned_user_id = ${friendId}
    `);
    expect(rowsOf(mentionRows)[0].n).toBe(1);
    const noteRows = await db.execute(sql`
      select count(*)::int as n from notifications
      where recipient_id = ${friendId} and type = 'mention' and subject_id = ${scheduledPostId}
    `);
    expect(rowsOf(noteRows)[0].n).toBe(1);

    // 2) Trending: hashtag counted once per post (viral post mentions it
    // twice + different case; 5 posts carry the tag in total), viral
    // post velocity = 30 audit upvotes + 1 reply ×2 = 32. Storage is one
    // row per item (D-054): kind/key/score, one batch per computed_at.
    const summary = await computeTrending(drizzleTrendingRepo(db), new Date());
    expect(summary.hashtags).toBeGreaterThanOrEqual(1);
    const tagRows = await db.execute(sql`
      select score from trending_snapshots
      where kind = 'hashtag' and key = ${tag}
      order by computed_at desc limit 1
    `);
    expect(rowsOf(tagRows)[0].score).toBe(5);
    const postRows2 = await db.execute(sql`
      select key, score from trending_snapshots
      where kind = 'post'
        and computed_at = (select max(computed_at) from trending_snapshots)
    `);
    const viralRow = rowsOf(postRows2).find((r) => r.key === viralPostId);
    expect(viralRow?.score).toBe(32);
    // The scheduled post has zero velocity in the window → dropped.
    expect(rowsOf(postRows2).some((r) => r.key === scheduledPostId)).toBe(false);
    await db.execute(sql`
      delete from trending_snapshots
      where key in (${tag}, ${viralPostId}, ${scheduledPostId})
    `);
  });
});
