import { buildApp } from "./app";
import { loadConfig, loadDotEnv } from "./config";
import { getDb } from "./db";
import { encryptLegacyWebhookSecrets } from "./services/webhooks";

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const app = await buildApp(config);
  // D-065 backfill: encrypt any legacy plaintext webhook secrets before
  // serving traffic. Best-effort — delivery decrypts legacy rows too.
  try {
    const { db } = getDb(config.DATABASE_URL);
    const rewritten = await encryptLegacyWebhookSecrets(db, config);
    if (rewritten > 0) {
      app.log.info(
        `[secrets] encrypted ${rewritten} legacy webhook secret(s) at rest`,
      );
    }
  } catch (error) {
    app.log.error(error, "[secrets] legacy webhook secret backfill failed");
  }
  await app.listen({ port: config.API_PORT, host: "0.0.0.0" });
}

main().catch((error: unknown) => {
  console.error("Failed to start gg-api:", error);
  process.exit(1);
});
