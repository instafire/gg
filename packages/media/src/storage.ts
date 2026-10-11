/**
 * Storage adapter (ARCHITECTURE §6): media bytes live behind this interface.
 * The local-disk implementation is the Phase 2 default (the laptop is the
 * media host, D-010); an S3/R2 implementation can replace it without API
 * changes. Keys are slash-separated relative paths, never absolute.
 */
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

export interface StorageAdapter {
  put(key: string, data: Buffer): Promise<void>;
  /** Stream `data` into `key`; resolves with the total bytes written. */
  putStream(key: string, data: NodeJS.ReadableStream): Promise<number>;
  /**
   * Append `data` at byte `offset` (tus PATCH). Resolves with the new file
   * size; throws RangeError when the offset does not match the current size.
   */
  append(key: string, data: Buffer, offset: number): Promise<number>;
  read(key: string): Promise<Buffer>;
  createReadStream(key: string): NodeJS.ReadableStream;
  exists(key: string): Promise<boolean>;
  size(key: string): Promise<number>;
  delete(key: string): Promise<void>;
  move(fromKey: string, toKey: string): Promise<void>;
}

/**
 * Processing (sharp/ffmpeg) works on real filesystem paths. Adapters that
 * can resolve a key to a local path implement this; a future S3 adapter
 * stages objects into a temp dir to satisfy it.
 */
export interface FileStore extends StorageAdapter {
  localPath(key: string): string;
}

function assertSafeKey(key: string): void {
  if (key.includes("..") || path.isAbsolute(key)) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}

export class LocalStorageAdapter implements FileStore {
  constructor(private readonly rootDir: string) {}

  localPath(key: string): string {
    assertSafeKey(key);
    return path.join(this.rootDir, key);
  }

  private async ensureParent(key: string): Promise<void> {
    await mkdir(path.dirname(this.localPath(key)), { recursive: true });
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.ensureParent(key);
    await writeFile(this.localPath(key), data);
  }

  async putStream(key: string, data: NodeJS.ReadableStream): Promise<number> {
    await this.ensureParent(key);
    let bytes = 0;
    data.on("data", (chunk: Buffer | string) => {
      bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    });
    await pipeline(data, createWriteStream(this.localPath(key)));
    return bytes;
  }

  async append(key: string, data: Buffer, offset: number): Promise<number> {
    await this.ensureParent(key);
    const current = (await this.exists(key)) ? await this.size(key) : 0;
    if (current !== offset) {
      throw new RangeError(
        `Upload offset mismatch: expected ${current}, got ${offset}`,
      );
    }
    const handle = await open(this.localPath(key), "a");
    try {
      await handle.write(data, 0, data.length, offset);
    } finally {
      await handle.close();
    }
    return offset + data.length;
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.localPath(key));
  }

  createReadStream(key: string): NodeJS.ReadableStream {
    return createReadStream(this.localPath(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.localPath(key));
      return true;
    } catch {
      return false;
    }
  }

  async size(key: string): Promise<number> {
    const stats = await stat(this.localPath(key));
    return stats.size;
  }

  async delete(key: string): Promise<void> {
    await rm(this.localPath(key), { force: true });
  }

  async move(fromKey: string, toKey: string): Promise<void> {
    await this.ensureParent(toKey);
    await rename(this.localPath(fromKey), this.localPath(toKey));
  }
}
