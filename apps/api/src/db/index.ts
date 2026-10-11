import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

let cached: { client: postgres.Sql; db: Db } | null = null;

/** Lazily-created singleton Drizzle client over postgres.js. */
export function getDb(databaseUrl: string): { client: postgres.Sql; db: Db } {
  if (!cached) {
    // Pool 30 (Phase 5B load test, D-046): at max 10, 20 concurrent
    // feed/thread requests queued on connections — each request runs
    // ~8 sequential queries — and p50 ballooned ~10× over the sequential
    // baseline while Postgres itself was idle. 30 stays well inside
    // Postgres' default max_connections alongside the worker's pool.
    const client = postgres(databaseUrl, { max: 30 });
    cached = { client, db: drizzle(client, { schema }) };
  }
  return cached;
}

export async function closeDb(): Promise<void> {
  if (cached) {
    await cached.client.end();
    cached = null;
  }
}
