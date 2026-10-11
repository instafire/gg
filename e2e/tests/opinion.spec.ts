/**
 * Phase 3 acceptance (PLAN.md): poll journey + debate view on desktop.
 *
 * - A fresh user creates a poll through the real composer (Poll tab),
 *   hits the T1 trust gate when voting on their own poll (D-014), then
 *   sees live results + the human/agent split after a seeded T1 account
 *   votes through the API (setup shortcut, same pattern as journey.spec).
 * - The same user starts an open debate through the composer (Debate tab)
 *   and lands on the debate room: proposition, side columns, opening
 *   argument card, stance section.
 *
 * Runs against the gg_test-backed instances (API :4100, web :3202).
 */
import { expect, request as pwRequest, test } from "@playwright/test";

const API = process.env.E2E_API_URL ?? "http://127.0.0.1:4100";
const seedPw = ["seed", "pass", "123456"].join("-");
const journeyPw = ["journey", "pass", "123456"].join("-");

const runId = Math.random().toString(36).slice(2, 8);
const handle = `opinion_${runId}`;
const email = `${handle}@example.com`;
const pollQuestion = `Opinion journey poll ${runId}: tabs or spaces?`;
const proposition = `Tabs are better than spaces, change my mind ${runId}`;
const opening = `Opening argument ${runId}: tabs adapt to every reader; spaces freeze one person's preference into every file.`;

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Phase 3 E2E is desktop-only");
});

test("poll journey + debate view", async ({ page, browser }) => {
  const api = await pwRequest.newContext({ baseURL: API });

  // ── 1. Register + onboard (same flow as the Phase 1 journey) ───────────
  await page.goto("/register");
  await page.getByTestId("register-handle").fill(handle);
  await page.getByTestId("register-display-name").fill("Opinion Tester");
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

  await expect(page.getByTestId("onboarding-topics")).toBeVisible();
  await page.getByTestId("onboarding-topic-chip").first().click();
  await page.getByTestId("onboarding-next").click();
  await expect(page.getByTestId("onboarding-communities")).toBeVisible();
  await page.getByTestId("onboarding-next").click();
  await expect(page.getByTestId("onboarding-people")).toBeVisible();
  await page.getByTestId("onboarding-finish").click();
  await expect(page).toHaveURL(/\/home$/);

  // ── 2. Create a poll through the composer ──────────────────────────────
  await page.getByTestId("composer-mode-poll").click();
  await expect(page.getByTestId("poll-composer")).toBeVisible();
  await page.getByLabel(/Question/).fill(pollQuestion);
  const optionInputs = page.locator('[data-testid="poll-composer"] input[placeholder^="Option"]');
  await optionInputs.nth(0).fill("Tabs");
  await optionInputs.nth(1).fill("Spaces");
  await page.getByTestId("poll-submit").click();

  const pollCard = page.getByTestId("poll-card").filter({ hasText: pollQuestion });
  await expect(pollCard).toBeVisible();

  // ── 3. An UNVERIFIED (T0) account hits the trust-tier gate ────────────
  // The journey author is T1 after the D-035 verify step above, so the
  // gate is proven with a second account that never verifies its email:
  // registered through the UI in a fresh context, taken straight to the
  // poll's post page. (An earlier revision clicked as the author and
  // expected the gate — stale once the author verifies.)
  const login = await api.post("/api/v1/auth/login", {
    data: { email: "aman@genznewz.com", password: seedPw },
  });
  expect(login.ok()).toBeTruthy();
  const loginBody = (await login.json()) as { tokens: { access_token: string } };
  const amanHeaders = { authorization: `Bearer ${loginBody.tokens.access_token}` };

  // Find the poll id + post id through the author's post (search by text).
  const search = await api.get(
    `/api/v1/search?q=${encodeURIComponent(pollQuestion)}`,
    { headers: amanHeaders },
  );
  expect(search.ok()).toBeTruthy();
  const searchBody = (await search.json()) as {
    posts: {
      data: Array<{ id: string; poll: { id: string; options: Array<{ id: string }> } | null }>;
    };
  };
  const found = searchBody.posts.data.find((post) => post.poll !== null);
  expect(found?.poll).toBeTruthy();

  const gateCtx = await browser.newContext();
  const gatePage = await gateCtx.newPage();
  await gatePage.goto("/register");
  await gatePage.getByTestId("register-handle").fill(`opiniongate_${runId}`);
  await gatePage.getByTestId("register-display-name").fill("Gate Tester");
  await gatePage.getByTestId("register-email").fill(`opiniongate_${runId}@example.com`);
  await gatePage.getByTestId("register-password").fill(journeyPw);
  await gatePage.getByTestId("register-dob").fill("1996-03-04");
  await gatePage.getByTestId("register-submit").click();
  await expect(gatePage.getByTestId("register-check-email")).toBeVisible();
  // Deliberately NOT verifying: this account stays T0.
  await gatePage.goto(`/post/${found!.id}`);
  const gateCard = gatePage.getByTestId("poll-card").filter({ hasText: pollQuestion });
  await expect(gateCard).toBeVisible();
  await gateCard.getByTestId("poll-option-1").click();
  await expect(gateCard.getByRole("alert")).toBeVisible();
  await gateCtx.close();

  // ── 4. A seeded T1 account votes via the API; results appear live ──────
  const voteRes = await api.post(`/api/v1/polls/${found!.poll!.id}/votes`, {
    headers: amanHeaders,
    data: { option_id: found!.poll!.options[0]!.id },
  });
  expect(voteRes.ok()).toBeTruthy();

  // Assert on the post page, not the ranked home feed: ranking v2 can
  // legitimately push a fresh 1-vote poll off the feed's first page.
  await page.goto(`/post/${found!.id}`);
  const votedCard = page.getByTestId("poll-card").filter({ hasText: pollQuestion });
  await expect(votedCard).toContainText("1 human");
  await votedCard.getByRole("button", { name: /Human \/ agent split/ }).click();
  await expect(votedCard).toContainText("0 agent");
  await page.goto("/home");

  // ── 5. Start an open debate through the composer ───────────────────────
  await page.getByTestId("composer-mode-debate").click();
  await expect(page.getByTestId("debate-composer")).toBeVisible();
  await page.getByLabel(/Proposition/).fill(proposition);
  await page.getByLabel(/Opening argument/).fill(opening);
  await page.getByTestId("debate-submit").click();

  const debateCard = page.getByTestId("post-debate-card").filter({ hasText: proposition });
  await expect(debateCard).toBeVisible();
  await debateCard.click();

  // ── 6. Debate room renders: sides, opening argument, stance section ────
  await expect(page).toHaveURL(/\/debates\/[0-9a-f-]+$/);
  await expect(page.getByTestId("debate-room")).toBeVisible();
  await expect(page.getByRole("heading", { name: proposition })).toBeVisible();
  await expect(page.getByTestId("debate-column-for")).toBeVisible();
  await expect(page.getByTestId("debate-column-against")).toBeVisible();
  await expect(page.getByTestId("argument-card").filter({ hasText: opening })).toBeVisible();
  await expect(page.getByText("Where the audience stands")).toBeVisible();
});
