import { sql } from "drizzle-orm";

import { db } from "../db/client";
import { rateLimitBuckets } from "../db/schema";
import { AppError } from "./errors";

/**
 * Fixed-window limiter stored in Postgres so it works across serverless instances.
 * Returns the count after increment; throws `rate_limited` when over the limit.
 */
export async function enforceRateLimit(key: string, limit: number, windowSeconds: number): Promise<number> {
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const [row] = await db
    .insert(rateLimitBuckets)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimitBuckets.key, rateLimitBuckets.windowStart],
      set: { count: sql`${rateLimitBuckets.count} + 1` },
    })
    .returning({ count: rateLimitBuckets.count });
  const count = row?.count ?? 1;
  if (count > limit) {
    throw new AppError("rate_limited", "Too many requests. Please slow down and try again shortly.", {
      details: { retryAfterSeconds: Math.ceil((windowStart.getTime() + windowMs - Date.now()) / 1000) },
    });
  }
  return count;
}

export async function pruneRateLimits(): Promise<void> {
  await db.delete(rateLimitBuckets).where(sql`${rateLimitBuckets.windowStart} < now() - interval '1 day'`);
}
