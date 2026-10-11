/**
 * Query-time text embeddings for semantic search (Phase 5B, D-060).
 *
 * Local all-MiniLM-L6-v2 (384d) via @huggingface/transformers
 * (onnxruntime-node under the hood) — no external embedding APIs. The
 * model directory comes from EMBEDDINGS_MODEL_PATH; when it is unset or
 * the model fails to load, `embedText` returns null and search degrades
 * to FTS-only (the response says so via `semantic_applied: false`).
 *
 * The extractor is a lazily-created singleton: the first semantic query
 * pays the model load (~100 ms), later queries are a few ms each.
 */
import type { AppConfig } from "../config";

type Extractor = (
  text: string,
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array }>;

let extractorPromise: Promise<Extractor | null> | null = null;

async function loadExtractor(config: AppConfig): Promise<Extractor | null> {
  const modelPath = config.EMBEDDINGS_MODEL_PATH;
  if (!modelPath) return null;
  try {
    // Dynamic import: the (heavy) ML stack must never block API boot.
    const transformers = (await import("@huggingface/transformers")) as {
      pipeline: (task: string, model: string) => Promise<Extractor>;
      env: { allowRemoteModels: boolean };
    };
    transformers.env.allowRemoteModels = false;
    return await transformers.pipeline("feature-extraction", modelPath);
  } catch (error) {
    console.error(
      "[gg-api] embedding model failed to load; semantic search disabled:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export async function embedText(
  config: AppConfig,
  text: string,
): Promise<number[] | null> {
  if (!config.EMBEDDINGS_MODEL_PATH) return null;
  extractorPromise ??= loadExtractor(config);
  const extractor = await extractorPromise;
  if (!extractor) return null;
  try {
    const output = await extractor(text.slice(0, 2000), {
      pooling: "mean",
      normalize: true,
    });
    return Array.from(output.data);
  } catch (error) {
    console.error(
      "[gg-api] embedding inference failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/** pgvector literal form for a JS number array. */
export function vectorLiteral(embedding: number[]): string {
  return `[${embedding.map((n) => n.toFixed(6)).join(",")}]`;
}
