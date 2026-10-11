import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/**
 * GG E2E — runs against the gg_test-backed instances on the laptop
 * (API :4100, web :3202 by default). See README.md for how to start them.
 * The system Chromium is used (no Playwright browser download needed).
 */
const systemChromium = "/usr/bin/chromium";
const executablePath =
  process.env.E2E_CHROME_PATH ??
  (existsSync(systemChromium) ? systemChromium : undefined);

export default defineConfig({
  testDir: "./tests",
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3202",
    trace: "retain-on-failure",
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"] },
    },
  ],
});
