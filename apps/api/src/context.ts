import type { AppConfig } from "./config";
import type { Db } from "./db";

/** Per-app context handed to every route module. */
export interface AppContext {
  config: AppConfig;
  db: Db;
}
