import type { AIProviderId } from "@tss/shared";

export type ModelTier = "quality" | "fast";

export type CompletionRequest = {
  system: string;
  prompt: string;
  /** JSON schema for the expected output. Providers with native structured output enforce it. */
  jsonSchema?: Record<string, unknown>;
  tier: ModelTier;
  maxOutputTokens: number;
  temperature?: number;
  signal?: AbortSignal;
};

export type CompletionResult = {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
};

export type ProviderStatus = {
  id: AIProviderId;
  configured: boolean;
  models: { quality: string; fast: string } | null;
  structuredOutput: "native" | "prompted";
};

/** Vendor adapter. Business logic never talks to a vendor directly — only through this. */
export interface AIProvider {
  readonly id: AIProviderId;
  isConfigured(): boolean;
  status(): ProviderStatus;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export type AIErrorKind =
  | "rate_limited"
  | "quota_exhausted"
  | "timeout"
  | "transient"
  | "unavailable"
  | "auth"
  | "bad_request"
  | "blocked"
  | "invalid_output"
  | "not_configured";

const RETRYABLE: ReadonlySet<AIErrorKind> = new Set(["rate_limited", "timeout", "transient", "unavailable"]);
/** Errors where trying a different provider makes sense (the provider itself failed, not the request). */
const FALLBACK_ELIGIBLE: ReadonlySet<AIErrorKind> = new Set([
  "rate_limited",
  "quota_exhausted",
  "timeout",
  "transient",
  "unavailable",
  "auth",
  "not_configured",
  "invalid_output",
]);

export class AIError extends Error {
  readonly kind: AIErrorKind;
  readonly provider: AIProviderId | "orchestrator";
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    kind: AIErrorKind,
    message: string,
    opts: { provider: AIProviderId | "orchestrator"; status?: number; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, { cause: opts.cause });
    this.name = "AIError";
    this.kind = kind;
    this.provider = opts.provider;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }

  get retryable() {
    return RETRYABLE.has(this.kind);
  }

  get fallbackEligible() {
    return FALLBACK_ELIGIBLE.has(this.kind);
  }
}

export function classifyHttpError(
  provider: AIProviderId,
  status: number,
  body: string,
  retryAfterHeader: string | null,
): AIError {
  const retryAfterMs = parseRetryAfter(retryAfterHeader);
  const snippet = body.slice(0, 300);
  if (status === 429) {
    const quota = /quota|RESOURCE_EXHAUSTED|exceeded your current|billing/i.test(body) && !/per minute|RPM/i.test(body);
    return new AIError(quota ? "quota_exhausted" : "rate_limited", `${provider} ${status}: ${snippet}`, {
      provider,
      status,
      retryAfterMs,
    });
  }
  if (status === 401 || status === 403) return new AIError("auth", `${provider} ${status}`, { provider, status });
  if (status === 400 || status === 404 || status === 422) {
    return new AIError("bad_request", `${provider} ${status}: ${snippet}`, { provider, status });
  }
  if (status === 503 || /ALL_TARGETS_SKIPPED|all targets were skipped/i.test(body)) {
    return new AIError("unavailable", `${provider} ${status}: ${snippet}`, { provider, status, retryAfterMs });
  }
  if (status === 408 || status === 504) return new AIError("timeout", `${provider} ${status}`, { provider, status });
  return new AIError("transient", `${provider} ${status}: ${snippet}`, { provider, status, retryAfterMs });
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** Converts fetch/abort failures to AIError. */
export function classifyFetchFailure(provider: AIProviderId, err: unknown): AIError {
  if (err instanceof AIError) return err;
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return new AIError("timeout", `${provider} request timed out`, { provider, cause: err });
  }
  return new AIError("transient", `${provider} network error`, { provider, cause: err });
}
