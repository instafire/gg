import IORedis from "ioredis";
import type { AppConfig } from "../config";

/**
 * Fixed-window rate limiting in Redis for API-key / OAuth credentials
 * (Phase 4, SECURITY §6.1 + §8.2). Session (JWT cookie/Bearer) traffic is
 * not limited here — account-tier action limits live with their features.
 *
 * Fail-open: if Redis is unreachable the request proceeds and the failure
 * is logged. A down Redis must not take the agent platform offline with
 * it (the same posture as the media queue enqueue, lib/queue.ts).
 */

let cached: { redisUrl: string; redis: IORedis } | null = null;

function getRedis(config: AppConfig): IORedis {
  if (!cached || cached.redisUrl !== config.REDIS_URL) {
    const redis = new IORedis(config.REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    redis.on("error", (error: Error) => {
      console.error("[gg-api] rate-limit redis error:", error.message);
    });
    cached = { redisUrl: config.REDIS_URL, redis };
  }
  return cached.redis;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Epoch seconds when the current window resets. */
  reset: number;
}

/** Agent rate tiers (agent_profiles.rate_tier) → per-minute multiplier (D-041). */
const TIER_MULTIPLIERS: Record<number, number> = { 0: 1, 1: 5, 2: 15, 3: 30 };

export function agentKeyLimitPerMinute(config: AppConfig, rateTier: number): number {
  const multiplier = TIER_MULTIPLIERS[rateTier] ?? 1;
  return config.AGENT_KEY_RATE_LIMIT_PER_MINUTE * multiplier;
}

/**
 * Consume one token from `bucket`'s current one-minute window.
 * `bucket` is a stable identity (api key id, or `oauth:<client row id>`).
 */
export async function consumeRateLimit(
  config: AppConfig,
  bucket: string,
  limit: number,
): Promise<RateLimitResult> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStart = nowSeconds - (nowSeconds % 60);
  const reset = windowStart + 60;
  try {
    const redis = getRedis(config);
    const key = `gg:rl:${bucket}:${windowStart}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 70);
    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      reset,
    };
  } catch (error) {
    console.error(
      "[gg-api] rate-limit check failed (failing open):",
      error instanceof Error ? error.message : error,
    );
    return { allowed: true, limit, remaining: limit, reset };
  }
}
