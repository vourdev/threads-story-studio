import { AIError } from "./types";

export type RetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (err: AIError, attempt: number, delayMs: number) => void;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The only place an AI call is retried. Bounded exponential backoff with jitter;
 * honours Retry-After; never retries quota exhaustion, auth or bad requests.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const base = options.baseDelayMs ?? 1500;
  const max = options.maxDelayMs ?? 20000;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!(err instanceof AIError) || !err.retryable || attempt === attempts) throw err;
      const backoff = Math.min(max, base * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
      // Unavailable pools (OmniRoute ALL_TARGETS_SKIPPED) need longer than a transport blip.
      const floor = err.kind === "unavailable" ? Math.min(max, 10000) : 0;
      const delay = Math.min(max, Math.max(err.retryAfterMs ?? 0, backoff, floor));
      options.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}
