import { AIError } from "./types";

export type RetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Absolute time (epoch ms) after which no further attempt starts. */
  deadline?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (err: AIError, attempt: number, delayMs: number) => void;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** An attempt that would start with less time than this left is not worth making. */
const MIN_ATTEMPT_MS = 5_000;

/**
 * The only place an AI call is retried: rate limits (honouring Retry-After) and transient errors,
 * with bounded exponential backoff and jitter, never past the request deadline.
 * Quota exhaustion, auth, bad requests, timeouts and unavailable pools are thrown immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 2;
  const base = options.baseDelayMs ?? 1500;
  const max = options.maxDelayMs ?? 15000;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!(err instanceof AIError) || !err.retryable || attempt === attempts) throw err;
      const backoff = Math.min(max, base * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
      const delay = Math.min(max, Math.max(err.retryAfterMs ?? 0, backoff));
      if (options.deadline !== undefined && Date.now() + delay + MIN_ATTEMPT_MS > options.deadline) throw err;
      options.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}
