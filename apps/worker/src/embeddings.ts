/**
 * Post embedding jobs (Phase 5B, D-060) — queue `gg-embed`.
 *
 * Model: all-MiniLM-L6-v2 (Xenova ONNX build), 384 dimensions, loaded
 * locally via @huggingface/transformers (onnxruntime-node). No external
 * embedding APIs. The model directory comes from EMBEDDINGS_MODEL_PATH;
 * without it the consumers stay disabled and log why (search then runs
 * FTS-only, which the API reports honestly).
 *
 * Freshness: the API enqueues `post.embed` on create/edit; a 10-minute
 * sweep embeds anything missing (lost enqueues, pre-5B posts), so the
 * index converges without a backfill command.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { WorkerDb } from "./db";
import { postEmbeddingsTable, postsTable } from "./db";

export const EMBED_QUEUE_NAME = "gg-embed";
export const EMBED_POST_JOB = "post.embed";
export const EMBED_SWEEP_JOB = "embed.sweep";
export const EMBEDDING_MODEL_NAME = "all-MiniLM-L6-v2";

export type Embedder = (text: string) => Promise<number[]>;

interface PostTextRow {
  id: string;
  title: string | null;
  bodyMd: string | null;
  deletedAt: Date | null;
}

/** The text an embedding represents: title first, markdown noise stripped. */
export function embeddingTextOf(post: { title: string | null; bodyMd: string | null }): string {
  const clean = (value: string): string =>
    value
      // URLs carry almost no semantic weight for retrieval; drop them.
      .replace(/https?:\/\/\S+/g, " ")
      // Markdown punctuation (incl. link/image syntax chars) → spaces.
      .replace(/[#>*`_~[\]()!|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  return [clean(post.title ?? ""), clean(post.bodyMd ?? "")]
    .filter(Boolean)
    .join("\n")
    .slice(0, 2000);
}

export interface EmbeddingRepo {
  getPostText(postId: string): Promise<PostTextRow | null>;
  upsertEmbedding(postId: string, embedding: number[], model: string): Promise<void>;
  listMissingEmbeddings(limit: number): Promise<PostTextRow[]>;
}

export function drizzleEmbeddingRepo(db: WorkerDb): EmbeddingRepo {
  return {
    async getPostText(postId) {
      const [row] = await db
        .select({
          id: postsTable.id,
          title: postsTable.title,
          bodyMd: postsTable.bodyMd,
          deletedAt: postsTable.deletedAt,
        })
        .from(postsTable)
        .where(eq(postsTable.id, postId))
        .limit(1);
      return row ?? null;
    },
    async upsertEmbedding(postId, embedding, model) {
      const literal = `[${embedding.map((n) => n.toFixed(6)).join(",")}]`;
      await db.execute(sql`
        insert into post_embeddings (post_id, embedding, model, created_at, updated_at)
        values (${postId}::uuid, ${literal}::vector, ${model}, now(), now())
        on conflict (post_id) do update
          set embedding = excluded.embedding,
              model = excluded.model,
              updated_at = now()
      `);
    },
    async listMissingEmbeddings(limit) {
      return db
        .select({
          id: postsTable.id,
          title: postsTable.title,
          bodyMd: postsTable.bodyMd,
          deletedAt: postsTable.deletedAt,
        })
        .from(postsTable)
        .leftJoin(postEmbeddingsTable, eq(postEmbeddingsTable.postId, postsTable.id))
        .where(
          and(
            isNull(postEmbeddingsTable.postId),
            isNull(postsTable.deletedAt),
            sql`(${postsTable.scheduledFor} is null or ${postsTable.scheduledFor} <= now())`,
          ),
        )
        .orderBy(desc(postsTable.createdAt))
        .limit(limit);
    },
  };
}

export type EmbedOutcome = "embedded" | "skipped_deleted" | "missing" | "empty_text";

export async function runEmbedPost(
  repo: EmbeddingRepo,
  embedder: Embedder,
  postId: string,
): Promise<{ outcome: EmbedOutcome }> {
  const post = await repo.getPostText(postId);
  if (!post) return { outcome: "missing" };
  if (post.deletedAt) return { outcome: "skipped_deleted" };
  const text = embeddingTextOf(post);
  if (!text) return { outcome: "empty_text" };
  const embedding = await embedder(text);
  await repo.upsertEmbedding(postId, embedding, EMBEDDING_MODEL_NAME);
  return { outcome: "embedded" };
}

export async function runEmbedSweep(
  repo: EmbeddingRepo,
  embedder: Embedder,
  limit = 50,
): Promise<{ embedded: number; scanned: number }> {
  const missing = await repo.listMissingEmbeddings(limit);
  let embedded = 0;
  for (const post of missing) {
    const result = await runEmbedPost(repo, embedder, post.id);
    if (result.outcome === "embedded") embedded += 1;
  }
  return { embedded, scanned: missing.length };
}

/**
 * Production embedder: lazily loads the local MiniLM pipeline once.
 * Returns null when EMBEDDINGS_MODEL_PATH is unset (feature disabled).
 */
export async function createModelEmbedder(
  modelPath: string | undefined,
): Promise<Embedder | null> {
  if (!modelPath) return null;
  type Extractor = (
    text: string,
    opts: { pooling: "mean"; normalize: boolean },
  ) => Promise<{ data: Float32Array }>;
  const transformers = (await import("@huggingface/transformers")) as {
    pipeline: (task: string, model: string) => Promise<Extractor>;
    env: { allowRemoteModels: boolean };
  };
  transformers.env.allowRemoteModels = false;
  const extractor = await transformers.pipeline("feature-extraction", modelPath);
  return async (text: string) => {
    const output = await extractor(text, { pooling: "mean", normalize: true });
    return Array.from(output.data);
  };
}
