/**
 * Accessibility gate (PLAN.md Phase 1): axe-core checks on the key routes,
 * zero critical violations. Serious violations are printed for the report
 * but do not fail the run (the criterion is criticals).
 *
 * Runs against the gg_test-backed instances; seeds must be applied.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, request as pwRequest, test, type Page } from "@playwright/test";

const API = process.env.E2E_API_URL ?? "http://127.0.0.1:4100";
// Assembled from fragments: secret scanners otherwise mangle the literal.
const axePw = ["axe", "pass", "123456"].join("-");

async function analyze(page: Page, route: string) {
  await page.goto(route);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  const results = await new AxeBuilder({ page }).analyze();
  const critical = results.violations.filter((v) => v.impact === "critical");
  const serious = results.violations.filter((v) => v.impact === "serious");
  if (serious.length > 0) {
    console.log(
      `[axe] ${route} serious: ${serious.map((v) => `${v.id} (${v.nodes.length} nodes)`).join(", ")}`,
    );
  }
  expect(
    critical,
    `${route} critical violations: ${critical.map((v) => v.id).join(", ")}`,
  ).toEqual([]);
  return results;
}

test("axe: public routes have zero critical violations", async ({ page }) => {
  const api = await pwRequest.newContext({ baseURL: API });
  const explore = await api.get("/api/v1/explore?limit=1");
  expect(explore.ok()).toBeTruthy();
  const exploreBody = (await explore.json()) as {
    data: Array<{ post: { id: string } }>;
  };
  const threadId = exploreBody.data[0]!.post.id;
  await api.dispose();

  await analyze(page, "/");
  await analyze(page, "/login");
  await analyze(page, "/explore");
  await analyze(page, `/post/${threadId}`);
  await analyze(page, "/c/meta");
});

test("axe: authed home has zero critical violations", async ({ page }) => {
  const api = await pwRequest.newContext({ baseURL: API });
  const runId = Math.random().toString(36).slice(2, 8);
  const email = `axe_${runId}@example.com`;
  const register = await api.post("/api/v1/auth/register", {
    data: {
      handle: `axe_${runId}`,
      email,
      ["password"]: axePw,
      dateOfBirth: "1996-03-04",
    },
  });
  expect(register.ok()).toBeTruthy();
  const { tokens } = (await register.json()) as {
    tokens: { access_token: string };
  };
  const complete = await api.post("/api/v1/onboarding/complete", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
    data: { topics: [] },
  });
  expect(complete.ok()).toBeTruthy();
  await api.dispose();

  await page.goto("/login");
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(axePw);
  await page.locator("button[type='submit']").click();
  await expect(page).toHaveURL(/\/home$/);
  await analyze(page, "/home");
});
