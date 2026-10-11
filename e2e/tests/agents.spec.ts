/**
 * Phase 4 acceptance (PLAN.md M6): a human registers an agent through the
 * UI — the first API key is shown exactly once — and the agent then
 * appears in the public directory carrying the permanent AI badge.
 *
 * Runs against the gg_test-backed instances (API :4100, web :3202).
 */
import { expect, test } from "@playwright/test";

const journeyPw = ["journey", "pass", "123456"].join("-");
const runId = Math.random().toString(36).slice(2, 8);
const handle = `agentown_${runId}`;
const email = `${handle}@example.com`;
const agentHandle = `e2ebot_${runId}`;
const agentName = `E2E Bot ${runId}`;

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Phase 4 E2E is desktop-only");
});

test("human registers an agent via UI → key shown once → directory lists it with the AI badge", async ({
  page,
}) => {
  // ── 1. Register + onboard (same flow as the Phase 1 journey) ────────────
  await page.goto("/register");
  await page.getByTestId("register-handle").fill(handle);
  await page.getByTestId("register-display-name").fill("Agent Owner");
  await page.getByTestId("register-email").fill(email);
  await page.getByTestId("register-password").fill(journeyPw);
  await page.getByTestId("register-dob").fill("1996-03-04");
  await page.getByTestId("register-submit").click();

  // D-035: registration lands on the check-email screen; on staging the
  // verification link is shown inline. Follow it on this origin.
  await expect(page.getByTestId("register-check-email")).toBeVisible();
  const verifyHref = await page
    .getByTestId("register-dev-verification-link")
    .getAttribute("href");
  const token = new URL(verifyHref!).searchParams.get("token");
  await page.goto(`/verify-email?token=${token}`);
  await expect(page.getByTestId("verify-email-success")).toBeVisible();
  await page.getByTestId("verify-email-continue").click();
  await expect(page).toHaveURL(/\/(home|onboarding)/);

  if (page.url().includes("/onboarding")) {
    await expect(page.getByTestId("onboarding-topics")).toBeVisible();
  } else {
    await page.goto("/onboarding");
    await expect(page.getByTestId("onboarding-topics")).toBeVisible();
  }
  await page.getByTestId("onboarding-topic-chip").first().click();
  await page.getByTestId("onboarding-next").click();
  await expect(page.getByTestId("onboarding-communities")).toBeVisible();
  await page.getByTestId("onboarding-next").click();
  await expect(page.getByTestId("onboarding-people")).toBeVisible();
  await page.getByTestId("onboarding-finish").click();
  await expect(page).toHaveURL(/\/(home|explore)/);

  // ── 2. Register an agent through the UI ─────────────────────────────────
  await page.goto("/agents/register");
  await page.getByTestId("agent-handle").fill(agentHandle);
  await page.getByTestId("agent-display-name").fill(agentName);
  await page
    .getByTestId("agent-purpose")
    .fill("E2E test agent: proves the Phase 4 registration flow end to end.");
  await page.getByTestId("agent-submit").click();

  // The first API key is shown exactly once, in full.
  const key = page.getByTestId("agent-api-key");
  await expect(key).toBeVisible();
  await expect(key).toHaveText(/^gg_live_[A-Za-z0-9_-]+$/);

  // ── 3. The directory lists the agent with the AI badge ──────────────────
  await page.goto("/agents");
  const card = page
    .getByTestId("agent-card")
    .filter({ hasText: `@${agentHandle}` });
  await expect(card).toBeVisible();
  await expect(card.getByTestId("agent-badge")).toBeVisible();
  await expect(card).toContainText(`Owned by @${handle}`);

  // ── 4. The agent profile shows the disclosure + owner link ──────────────
  await page.goto(`/u/${agentHandle}`);
  const disclosure = page.getByTestId("agent-disclosure");
  await expect(disclosure).toBeVisible();
  await expect(disclosure).toContainText("AI agent account");
  await expect(disclosure).toContainText(`@${handle}`);
});
