import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "quota_exhausted"
  | "provider_unavailable"
  | "provider_error"
  | "not_configured"
  | "unsupported"
  | "invalid_ai_output"
  | "internal";

const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  quota_exhausted: 429,
  provider_unavailable: 503,
  provider_error: 502,
  not_configured: 412,
  unsupported: 422,
  invalid_ai_output: 502,
  internal: 500,
};

/** Error that is safe to show to the user. Internal details go in `cause` and are never serialized. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: ContentfulStatusCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: { cause?: unknown; details?: Record<string, unknown> } = {}) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.details = options.details;
  }
}

export const notFound = (what = "Resource") => new AppError("not_found", `${what} not found`);

export function toErrorBody(err: AppError) {
  return { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } };
}
