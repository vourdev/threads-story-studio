import type { ProviderCapabilities, PublishingProviderId, StoryPost } from "@tss/shared";

export type PublishErrorKind = "transient" | "rate_limited" | "auth" | "permanent" | "unknown" | "not_configured";

/**
 * Normalized provider error.
 * - `unknown`: the request may or may not have reached the provider (timeout) — must be reconciled, never blindly resent.
 */
export class PublishError extends Error {
  readonly kind: PublishErrorKind;
  readonly httpStatus?: number;
  readonly providerCode?: string;
  readonly retryAfterMs?: number;

  constructor(
    kind: PublishErrorKind,
    message: string,
    opts: { httpStatus?: number; providerCode?: string; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "PublishError";
    this.kind = kind;
    this.httpStatus = opts.httpStatus;
    this.providerCode = opts.providerCode;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export type AccountCredentials = {
  accountId: string;
  externalAccountId: string | null;
  accessToken: string | null;
  meta: Record<string, string>;
};

export type PublishContext = {
  publicationId: string;
  posts: StoryPost[];
  account: AccountCredentials;
  step: string;
  stepState: Record<string, unknown>;
  /** True when a previous attempt of this step ended with an unknown outcome. */
  reconcile: boolean;
};

export type StepResult =
  | { type: "continue"; step: string; stepState: Record<string, unknown>; delayMs: number }
  | {
      type: "done";
      /** `published` = confirmed live on Threads; `submitted` = accepted by an intermediary (e.g. Buffer). */
      status: "published" | "submitted";
      externalPostIds: string[];
      permalink?: string | null;
      meta?: Record<string, unknown>;
    };

export type SyncResult =
  | { status: "pending"; meta?: Record<string, unknown> }
  | { status: "published"; permalink?: string | null; meta?: Record<string, unknown> }
  | { status: "failed"; message: string };

export interface PublishingProvider {
  readonly id: PublishingProviderId;
  readonly label: string;
  capabilities(): ProviderCapabilities;
  /** Server-side credentials present (app id/secret or API key). */
  isConfigured(): boolean;
  /** First step for a new publish job. */
  initialStep(): string;
  runStep(ctx: PublishContext): Promise<StepResult>;
  /** Status sync for providers that only report acceptance (Buffer). */
  syncStatus?(ctx: { account: AccountCredentials; externalPostIds: string[] }): Promise<SyncResult>;
}
