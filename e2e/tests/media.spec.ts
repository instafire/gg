/**
 * Phase 2 media journey (desktop): register via API, log in through the
 * UI, post a photo through the real composer (upload → worker processing →
 * ready → IMAGE post rendered in the feed), publish a story and open the
 * viewer, then check the profile media grid.
 *
 * The worker is spawned by this spec (built dist, gg_test DATABASE_URL,
 * temp MEDIA_DIR) because media only becomes `ready` through the pipeline.
 * Runs against the same gg_test-backed instances as the Phase 1 journey
 * (API :4100, web :3202 — see README.md).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, request as pwRequest, test } from "@playwright/test";

const API = process.env.E2E_API_URL ?? "http://127.0.0.1:4100";
const pw = ["media", "pass", "123456"].join("-");
const runId = Math.random().toString(36).slice(2, 8);
const handle = `media_${runId}`;
const email = `${handle}@example.com`;

// A real 96×64 PNG (opaque orange) generated with sharp, base64-embedded.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAA" +
  "wUlEQVR4nO3ZwQ3CUBDE0NTiQin318EdiVwQmhyelAosj9mE67zynO8QLnTOrSIABVC/rIRBARSD" +
  "+t9PjYkFUAzKxFodtBoUQDEoE0uDeuZ3BZEOoBiUiaVBzXss0gEUgzKx5t1xKAZQDMrEmgfIy2oA" +
  "xaBMLA1qHmORDqAYlIk1j45DMYBiUCbWQx7/rAZQDMrE0qDmPRbpAIpBmVjz7jgUAygGZWLNA+R" +
  "lNYBiUCaWBjWPsUgHUAzKxJpH5+NQfAMSLpIdHhT3mgAAAABJRU5ErkJggg==";

let worker: ChildProcess | null = null;
let fixturePath = "";

test.beforeAll(async () => {
  // Must match the API instance's MEDIA_DIR (uploads land there; the worker
  // reads them). The runner exports one shared MEDIA_DIR for both.
  const mediaDir =
    process.env.MEDIA_DIR ?? mkdtempSync(path.join(os.tmpdir(), "gg-e2e-media-"));
  fixturePath = path.join(os.tmpdir(), `gg-e2e-${runId}.png`);
  writeFileSync(fixturePath, Buffer.from(PNG_BASE64, "base64"));

  // Register the actor through the API (the journey itself uses the UI).
  const api = await pwRequest.newContext({ baseURL: API });
  const reg = await api.post("/api/v1/auth/register", {
    data: {
      handle,
      email,
      ["password"]: pw,
      dateOfBirth: "1996-03-04",
      display_name: "Media Tester",
    },
  });
  expect(reg.status()).toBe(201);
  await api.dispose();

  // Spawn the media worker against gg_test. Playwright runs specs as ESM
  // (no __dirname); the e2e package dir is one level below the app root.
  const appRoot = path.resolve(process.cwd(), "..");
  worker = spawn("node", ["apps/worker/dist/index.js"], {
    cwd: appRoot,
    env: {
      ...process.env,
      MEDIA_DIR: mediaDir,
      NODE_ENV: "production",
    },
    stdio: "pipe",
  });
  worker.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[worker] ${chunk.toString()}`);
  });
  // Give the worker a moment to connect before the first upload completes.
  await new Promise((resolve) => setTimeout(resolve, 3000));
});

test.afterAll(() => {
  worker?.kill("SIGTERM");
  worker = null;
});

test("media journey: image post, story, profile grid", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "media journey runs on desktop");

  // ── Log in through the UI ──────────────────────────────────────────────
  await page.goto("/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(pw);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/(home|onboarding)$/);
  if (page.url().endsWith("/onboarding")) {
    // Complete onboarding minimally if this account hasn't yet.
    await page.getByTestId("onboarding-topic-chip").first().click();
    await page.getByTestId("onboarding-next").click();
    await page.getByTestId("onboarding-next").click();
    await page.getByTestId("onboarding-finish").click();
    await expect(page).toHaveURL(/\/home$/);
  }

  // ── Compose an image post ──────────────────────────────────────────────
  const composer = page.getByTestId("composer");
  await expect(composer).toBeVisible();
  await composer.getByTestId("composer-file-input").setInputFiles(fixturePath);
  // Alt-text field only appears once the pipeline marks the upload ready.
  const altInput = composer.getByTestId("composer-alt-text");
  await expect(altInput).toBeVisible({ timeout: 90_000 });
  await altInput.fill("An orange rectangle (e2e)");
  await composer.locator("textarea").fill(`Media journey ${runId}`);
  await page.getByTestId("composer-submit").click();

  // The IMAGE post renders in the home feed with its picture.
  const card = page.getByTestId("post-card").first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId("post-media-image")).toBeVisible({ timeout: 30_000 });

  // ── Publish a story and open the viewer ────────────────────────────────
  await page.getByTestId("story-file-input").setInputFiles(fixturePath);
  // The button flips to data-story-state="has-story" once the story posts.
  await expect(page.getByTestId("story-add-button")).toHaveAttribute(
    "data-story-state",
    "has-story",
    { timeout: 90_000 },
  );
  await page.getByTestId("story-add-button").click();
  await expect(page.getByTestId("story-viewer")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("story-viewer")).toHaveCount(0);

  // ── Profile media grid ─────────────────────────────────────────────────
  await page.goto(`/u/${handle}`);
  await page.getByTestId("profile-tab-media").click();
  await expect(page.getByTestId("profile-media-grid")).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByTestId("profile-media-grid").locator("a"),
  ).toHaveCount(1);
});
