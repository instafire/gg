/**
 * LCP probe (D-024): measures Largest Contentful Paint for a URL with the
 * Phase 1 exit-round lab method — mobile viewport 412×915, 4× CPU
 * throttle, Slow-4G network (1.6 Mbps down / 150 ms RTT) via CDP, LCP
 * collected with a PerformanceObserver buffered from navigation start.
 *
 * Usage: node tools/lcp-probe.mjs <url> [runs]
 * Prints JSON: { url, runs: number[], medianMs }.
 */
import { chromium } from "@playwright/test";

const url = process.argv[2];
const runs = Number.parseInt(process.argv[3] ?? "3", 10);
if (!url) {
  console.error("usage: node tools/lcp-probe.mjs <url> [runs]");
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: process.env.E2E_CHROME_PATH ?? "/usr/bin/chromium",
  args: ["--no-sandbox"],
});

const results = [];
for (let run = 0; run < runs; run += 1) {
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__lcp = 0;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__lcp = entry.startTime;
        }
      });
      observer.observe({ type: "largest-contentful-paint", buffered: true });
    } catch {
      // Observer unsupported — __lcp stays 0.
    }
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (0.75 * 1024 * 1024) / 8,
  });
  await page.goto(url, { waitUntil: "load", timeout: 120_000 });
  // LCP settles after content paints; give late candidates time to land.
  await page.waitForTimeout(4000);
  const lcp = await page.evaluate(() => window.__lcp ?? 0);
  results.push(Math.round(lcp));
  await context.close();
}
await browser.close();

const sorted = [...results].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
console.log(JSON.stringify({ url, runs: results, medianMs: median }, null, 2));
