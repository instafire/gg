import { existsSync } from "node:fs";
import path from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { loadConfig, loadDotEnv } from "../config";
import { closeDb, getDb } from "./index";

function migrationsFolder(): string {
  const candidates = [
    path.resolve(process.cwd(), "drizzle"),
    path.resolve(__dirname, "../../drizzle"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

/** Apply all migrations in apps/api/drizzle to DATABASE_URL. */
async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const { db } = getDb(config.DATABASE_URL);
  await migrate(db, { migrationsFolder: migrationsFolder() });
  console.log("[gg-api] migrations applied");
  await closeDb();
}

main().catch((error: unknown) => {
  console.error("[gg-api] migration failed:", error);
  process.exit(1);
});
