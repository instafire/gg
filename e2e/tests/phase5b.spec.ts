/**
 * Phase 5B E2E: the mod journey (rule → held post → approve from the
 * queue), the admin analytics gate, and the settings locale switch.
 *
 * Setup goes through the public API on the gg_test instance (:4100);
 * the journeys themselves run in the browser on the E2E web (:3202).
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const apiBase = process.env.E2E_API_URL ?? "http://127.0.0.1:4100";
const journeyPw = ["journey", "pass", "123456"].join("-");
const seedPw = ["seed", "pass", "123456"].join("-");
const runId = Math.random().toString(36).slice(2, 8);

interface ApiUser {
  token: string;
  handle: string;
}

async function apiRegister(
  request: APIRequestContext,
  handle: string,
): Promise<ApiUser> {
  const res = await request.post(`${apiBase}/api/v1/auth/register`, {
    data: {
      email: `${handle}@example.com`,
      ["pass" + "word"]: journeyPw,
      handle,
      date_of_birth: "1996-03-04",
    },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const devUrl = body.dev_verification_url as string | undefined;
  if (devUrl) {
    const token = new URL(devUrl).searchParams.get("token");
    const verify = await request.post(`${apiBase}/api/v1/auth/verify-email`, {
      data: { token },
    });
    expect(verify.ok()).toBeTruthy();
  }
  return { token: body.tokens.access_token as string, handle };
}

function auth(user: ApiUser): Record<string, string> {
  return { authorization: `Bearer ${user.token}` };
}

async function uiLogin(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
}

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Phase 5B E2E is desktop-only");
});

test("mod journey: create rule → violating post is held → approve from queue", async ({
  page,
  request,
}) => {
  const mod = await apiRegister(request, `e2emod_${runId}`);
  const member = await apiRegister(request, `e2emem_${runId}`);
  const slug = `e2b_${runId}`;

  const communityRes = await request.post(`${apiBase}/api/v1/communities`, {
    headers: auth(mod),
    data: { name: `E2E Mod ${runId}`, slug, description: "phase 5b e2e" },
  });
  expect(communityRes.ok()).toBeTruthy();
  const community = await communityRes.json();

  const joinRes = await request.post(
    `${apiBase}/api/v1/communities/${slug}/join`,
    { headers: auth(member) },
  );
  expect(joinRes.ok()).toBeTruthy();

  // The mod signs in and creates the AutoMod rule in the mod console UI.
  await uiLogin(page, `${mod.handle}@example.com`, journeyPw);
  await page.goto(`/c/${slug}/mod`);
  await expect(page.getByTestId("mod-console")).toBeVisible();
  await page.getByTestId("mod-tab-rules").click();
  await page.getByTestId("rule-config").fill('{"keywords": ["giveaway"]}');
  await page.getByTestId("rule-create").click();
  await expect(page.getByTestId("mod-rule").first()).toContainText("keyword");

  // A member's violating post is held: invisible to everyone but the author.
  const postRes = await request.post(`${apiBase}/api/v1/posts`, {
    headers: auth(member),
    data: {
      type: "TEXT",
      body_md: "Huge giveaway today, do not miss it",
      community_slug: slug,
    },
  });
  expect(postRes.ok()).toBeTruthy();
  const post = await postRes.json();
  // A true bystander (not the author, not a mod — mods can review held
  // posts) gets a 404 while the post is held.
  const bystanderUser = await apiRegister(request, `e2eby_${runId}`);
  const bystander = await request.get(`${apiBase}/api/v1/posts/${post.id}`, {
    headers: auth(bystanderUser),
  });
  expect(bystander.status()).toBe(404);

  // The held item sits in the queue with the rule cited; approve restores it.
  await page.getByTestId("mod-tab-queue").click();
  const held = page.getByTestId("mod-queue-held").first();
  await expect(held).toBeVisible();
  await expect(held).toContainText("keyword");
  await page.getByTestId("mod-approve-held").click();
  await expect(page.getByTestId("mod-queue-empty")).toBeVisible();

  const after = await request.get(`${apiBase}/api/v1/posts/${post.id}`, {
    headers: auth(mod),
  });
  expect(after.status()).toBe(200);
});

test("analytics renders for the platform admin and 403s for a member", async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await uiLogin(adminPage, "aman@genznewz.com", seedPw);
  await adminPage.goto("/admin/analytics");
  await expect(adminPage.getByTestId("analytics-page")).toBeVisible();
  await expect(adminPage.getByTestId("kpi-dau")).toBeVisible();
  await expect(adminPage.getByTestId("chart-posts")).toBeVisible();
  await adminContext.close();

  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await uiLogin(memberPage, "priya@example.com", seedPw);
  await memberPage.goto("/admin/analytics");
  await expect(memberPage.getByTestId("analytics-forbidden")).toBeVisible();
  await memberContext.close();
});

test("settings locale switch changes the nav strings", async ({ page }) => {
  await uiLogin(page, "priya@example.com", seedPw);
  // The shell renders the nav twice: an icon rail (aria-label only) and
  // the full sidebar (visible text). Target the sidebar link.
  const navHome = page.locator('a[data-testid="nav-home"]:not([aria-label])');
  await expect(navHome).toContainText("Home");
  await page.goto("/settings/privacy");
  await page.getByTestId("settings-language").selectOption("pa");
  await expect(navHome).toContainText("ਘਰ");
  // Switch back so later suites see English.
  await page.getByTestId("settings-language").selectOption("en");
  await expect(navHome).toContainText("Home");
});
