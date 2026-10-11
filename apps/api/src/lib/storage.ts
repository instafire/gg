/**
 * Process-wide storage adapter instance (local disk under MEDIA_DIR,
 * ARCHITECTURE §6). The worker constructs its own instance over the same
 * directory; keys are the shared contract.
 */
import { LocalStorageAdapter, type FileStore } from "@gg/media";
import type { AppConfig } from "../config";

let cached: { dir: string; store: FileStore } | null = null;

export function getStorage(config: AppConfig): FileStore {
  if (!cached || cached.dir !== config.MEDIA_DIR) {
    cached = { dir: config.MEDIA_DIR, store: new LocalStorageAdapter(config.MEDIA_DIR) };
  }
  return cached.store;
}
