/**
 * Phase 5A E2E: the two-user DM journey — a stranger's message lands in
 * Requests, accepting moves it to the inbox, the reply arrives LIVE in
 * the sender's open thread (WebSocket, no reload), and the read receipt
 * shows once the recipient has read. Plus the minor-gate UI state.
 *
 * Runs against the gg_test-backed instances (API :4100, web :3202).
 */
import { expect, test, type Page } from "@playwright/test";

const journeyPw = ["journey", "pass", "123456"].join("-");
const runId = Math.random().toString(36).slice(2, 8);

async function registerAndOnboard(
  page: Page,
  handle: string,
  displayName: string,
  dob = "1996-03-04",
): Promise<void> {
  await page.goto("/register");
  await page.getByTestId("register-handle").fill(handle);
  await page.getByTestId("register-display-name").fill(displayName);
  await page.getByTestId("register-email").fill(`${handle}@example.com`);
  await page.getByTestId("register-password").fill(journeyPw);
  await page.getByTestId("register-dob").fill(dob);
  await page.getByTestId("register-submit").click();

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
}

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Phase 5A E2E is desktop-only");
});

test("DM journey: request → accept → live reply via WS → read receipt", async ({
  browser,
}) => {
  const senderHandle = `e2edma_${runId}`;
  const receiverHandle = `e2edmb_${runId}`;

  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  try {
    await registerAndOnboard(sender, senderHandle, "DM Sender");
    await registerAndOnboard(receiver, receiverHandle, "DM Receiver");
    const firstMessage = `e2e hello ${runId}`;
    const replyMessage = `e2e reply ${runId}`;

    // Sender opens the receiver's profile and starts a conversation.
    await sender.goto(`/u/${receiverHandle}`);
    await sender.getByTestId("profile-message-button").click();
    await expect(sender).toHaveURL(/\/messages\/[0-9a-f-]+/);
    await expect(sender.getByTestId("message-thread")).toBeVisible();

    // The receiver does not follow the sender → this lands in Requests.
    await sender.getByTestId("message-composer-input").fill(firstMessage);
    await sender.getByTestId("message-send-button").click();
    await expect(
      sender.getByTestId("message-row").filter({ hasText: firstMessage }),
    ).toBeVisible();

    // Receiver: the conversation is under Requests, not the inbox.
    // (Rows are titled by display name; the preview shows the message.)
    await receiver.goto("/messages");
    await receiver.getByTestId("messages-tab-requests").click();
    const requestRow = receiver
      .getByTestId("conversation-row")
      .filter({ hasText: firstMessage });
    await expect(requestRow).toBeVisible();
    await expect(requestRow).toContainText("DM Sender");
    await requestRow.click();
    await expect(receiver).toHaveURL(/\/messages\/[0-9a-f-]+/);
    await expect(receiver.getByTestId("request-banner")).toBeVisible();
    await expect(
      receiver.getByTestId("message-row").filter({ hasText: firstMessage }),
    ).toBeVisible();

    // Accept → reply. The sender's open thread must update live (WS).
    await receiver.getByTestId("request-accept").click();
    await expect(receiver.getByTestId("request-banner")).toBeHidden();
    await receiver.getByTestId("message-composer-input").fill(replyMessage);
    await receiver.getByTestId("message-send-button").click();
    await expect(
      receiver.getByTestId("message-row").filter({ hasText: replyMessage }),
    ).toBeVisible();

    await expect(
      sender.getByTestId("message-row").filter({ hasText: replyMessage }),
    ).toBeVisible({ timeout: 15_000 });

    // Read receipt: the receiver has the thread open (messages marked
    // read), so the sender sees "Read by @receiver" on their message.
    await expect(sender.getByTestId("message-read-by")).toContainText(
      `@${receiverHandle}`,
      { timeout: 15_000 },
    );

    // The accepted conversation now lives in the receiver's inbox.
    await receiver.goto("/messages");
    await expect(
      receiver.getByTestId("conversation-row").filter({ hasText: replyMessage }),
    ).toBeVisible();
  } finally {
    await senderContext.close();
    await receiverContext.close();
  }
});

test("minor gate: a stranger's Message attempt on a minor profile is refused with a note", async ({
  browser,
}) => {
  const adultHandle = `e2edmc_${runId}`;
  const minorHandle = `e2edmd_${runId}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await registerAndOnboard(page, minorHandle, "Minor User", "2011-06-01");
    // Fresh context for the adult so sessions don't mix.
    const adultContext = await browser.newContext();
    const adult = await adultContext.newPage();
    try {
      await registerAndOnboard(adult, adultHandle, "Adult Stranger");
      await adult.goto(`/u/${minorHandle}`);
      await adult.getByTestId("profile-message-button").click();
      await expect(adult.getByTestId("profile-message-blocked")).toBeVisible();
      await expect(adult).not.toHaveURL(/\/messages\/[0-9a-f-]+/);
    } finally {
      await adultContext.close();
    }
  } finally {
    await context.close();
  }
});
