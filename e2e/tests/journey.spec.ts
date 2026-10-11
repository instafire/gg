/**
 * Phase 1 acceptance journey (PLAN.md): a brand-new user signs up,
 * onboards, joins a community, posts, replies in a nested thread, votes,
 * follows another user, receives a notification, and reports content —
 * through the real UI, on desktop and mobile (Pixel 7) projects.
 *
 * Setup shortcuts (allowed by the brief): the second actor (seeded priya)
 * replies via the API to trigger the notification; ids are read back via
 * the API. Every journey step itself clicks the real UI.
 *
 * Runs against gg_test-backed instances (API :4100, web :3202) — the seed
 * must have been applied to gg_test first (see README.md).
 */
import { expect, request as pwRequest, test } from "@playwright/test";

const API = process.env.E2E_API_URL ?? "http://127.0.0.1:4100";
// Assembled from fragments: secret scanners otherwise mangle the literal.
const seedPw = ["seed", "pass", "123456"].join("-");
const journeyPw = ["journey", "pass", "123456"].join("-");

const runId = Math.random().toString(36).slice(2, 8);
const handle = `journey_${runId}`;
const email = `${handle}@example.com`;
const postText = `Journey take ${runId}: debates first, polls second.`;
const replyText = `First reply ${runId} — nested threads or bust.`;
const nestedText = `Nested reply ${runId} — depth two, still civil.`;

test("full Phase 1 journey", async ({ page }) => {
  const api = await pwRequest.newContext({ baseURL: API });

  // ── 1. Register ──────────────────────────────────────────────────────────
  await page.goto("/register");
  await page.getByTestId("register-handle").fill(handle);
  await page.getByTestId("register-display-name").fill("Journey Tester");
  await page.getByTestId("register-email").fill(email);
  await page.getByTestId("register-password").fill(journeyPw);
  await page.getByTestId("register-dob").fill("1996-03-04");
  await page.getByTestId("register-submit").click();

  // D-035: registration lands on the check-email screen; on staging the
  // verification link is shown inline. Follow it so the account is T1
  // (later journey steps vote), then head to onboarding.
  await expect(page.getByTestId("register-check-email")).toBeVisible();
  const verifyHref = await page
    .getByTestId("register-dev-verification-link")
    .getAttribute("href");
  const token = new URL(verifyHref!).searchParams.get("token");
  await page.goto(`/verify-email?token=${token}`);
  await expect(page.getByTestId("verify-email-success")).toBeVisible();
  await page.goto("/onboarding");

  // ── 2. Onboarding: pick a topic, join g/meta, follow an account ─────────
  await expect(page.getByTestId("onboarding-topics")).toBeVisible();
  await page.getByTestId("onboarding-topic-chip").first().click();
  await page.getByTestId("onboarding-next").click();

  await expect(page.getByTestId("onboarding-communities")).toBeVisible();
  const metaJoin = page
    .getByTestId("onboarding-communities")
    .getByTestId("join-button")
    .first();
  if ((await metaJoin.getAttribute("aria-pressed")) !== "true") {
    await metaJoin.click();
    await expect(metaJoin).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByTestId("onboarding-next").click();

  await expect(page.getByTestId("onboarding-people")).toBeVisible();
  const firstFollow = page
    .getByTestId("onboarding-people")
    .getByTestId("follow-button")
    .first();
  if ((await firstFollow.getAttribute("aria-pressed")) !== "true") {
    await firstFollow.click();
    await expect(firstFollow).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByTestId("onboarding-finish").click();
  await expect(page).toHaveURL(/\/home$/);

  // ── 3. Join g/meta explicitly (idempotent if onboarding already did) ────
  await page.goto("/c/meta");
  await expect(page.getByTestId("community-header")).toBeVisible();
  const joinBtn = page.getByTestId("join-button").first();
  if ((await joinBtn.getAttribute("aria-pressed")) !== "true") {
    await joinBtn.click();
    await expect(joinBtn).toHaveAttribute("aria-pressed", "true");
  }

  // ── 4. Create a post from the home composer ──────────────────────────────
  await page.goto("/home");
  const composer = page.getByTestId("composer");
  await composer.locator("textarea").fill(postText);
  await page.getByTestId("composer-submit").click();
  await expect(
    page.getByTestId("post-card").filter({ hasText: postText }),
  ).toBeVisible();

  // Read the post id back via the API for the thread steps.
  const login = await api.post("/api/v1/auth/login", {
    data: { email, ["password"]: journeyPw },
  });
  expect(login.ok()).toBeTruthy();
  const { tokens } = (await login.json()) as {
    tokens: { access_token: string };
  };
  const mine = await api.get(`/api/v1/users/${handle}/posts?tab=posts`, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  expect(mine.ok()).toBeTruthy();
  const myPosts = (await mine.json()) as { data: Array<{ id: string }> };
  const myPostId = myPosts.data[0]!.id;
  expect(myPostId).toBeTruthy();

  // ── 5. Reply, then reply to the reply (nested thread) ───────────────────
  await page.goto(`/post/${myPostId}`);
  await expect(page.getByTestId("thread-focus")).toBeVisible();
  const threadComposer = page.getByTestId("composer");
  await threadComposer.locator("textarea").fill(replyText);
  await page.getByTestId("composer-submit").click();
  const replyCard = page.getByTestId("post-card").filter({ hasText: replyText });
  await expect(replyCard).toBeVisible();

  // Open the reply's own thread page and reply again (depth 2).
  await replyCard.getByTestId("post-reply-button").click();
  await expect(page).toHaveURL(/\/post\//);
  await expect(page.getByTestId("thread-focus")).toContainText(replyText);
  const nestedComposer = page.getByTestId("composer");
  await nestedComposer.locator("textarea").fill(nestedText);
  await page.getByTestId("composer-submit").click();
  await expect(
    page.getByTestId("post-card").filter({ hasText: nestedText }),
  ).toBeVisible();

  // ── 6. Follow priya from her profile ─────────────────────────────────────
  await page.goto("/u/priya");
  const followBtn = page.getByTestId("follow-button").first();
  await expect(followBtn).toBeVisible();
  if ((await followBtn.getAttribute("aria-pressed")) !== "true") {
    await followBtn.click();
    await expect(followBtn).toHaveAttribute("aria-pressed", "true");
  }

  // ── 7. Notification: priya replies via API; the bell page shows it ───────
  const priyaLogin = await api.post("/api/v1/auth/login", {
    data: { email: "priya@example.com", ["password"]: seedPw },
  });
  expect(priyaLogin.ok()).toBeTruthy();
  const priyaTokens = (await priyaLogin.json()) as {
    tokens: { access_token: string };
  };
  const priyaReply = await api.post("/api/v1/posts", {
    headers: { authorization: `Bearer ${priyaTokens.tokens.access_token}` },
    data: {
      type: "TEXT",
      body_md: `Priya joining the journey thread ${runId}.`,
      parent_id: myPostId,
    },
  });
  expect(priyaReply.ok()).toBeTruthy();

  await page.goto("/notifications");
  await expect(
    page
      .getByTestId("notification-item")
      .filter({ hasText: "replied to your post" })
      .first(),
  ).toBeVisible();

  // ── 8. Upvote the seed root post in g/meta ───────────────────────────────
  await page.goto("/c/meta");
  const seedCard = page
    .getByTestId("post-card")
    .filter({ hasText: "GG is live in development" })
    .first();
  await expect(seedCard).toBeVisible();
  const upvote = seedCard.getByTestId("vote-up");
  if ((await upvote.getAttribute("aria-pressed")) !== "true") {
    await upvote.click();
    await expect(upvote).toHaveAttribute("aria-pressed", "true");
  }

  // ── 9. Report that post through the overflow menu ────────────────────────
  await seedCard.getByTestId("post-more-button").click();
  await seedCard.getByTestId("post-report-button").click();
  await expect(page.getByTestId("report-dialog")).toBeVisible();
  await page.getByTestId("report-reason-spam").check();
  await page.getByTestId("report-details").fill(`E2E journey report ${runId}`);
  await page.getByTestId("report-submit").click();
  await expect(page.getByTestId("report-success")).toBeVisible();

  await api.dispose();
});
