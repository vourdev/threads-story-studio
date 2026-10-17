const SECRET_KEYS = /(token|secret|password|authorization|api[-_]?key|cookie|signature)/i;
const EXACT_SECRET_KEYS = new Set(["code", "state"]);
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/g;
const QUERY_SECRET = /([?&](?:access_token|client_secret|code|key|token)=)[^&\s"]+/gi;

/** Removes secrets from strings (bearer tokens, secret query params). */
export function redactString(input: string): string {
  return input.replace(BEARER, "$1[redacted]").replace(QUERY_SECRET, "$1[redacted]");
}

/** Deep-copies a value, replacing secret-looking keys and redacting strings. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return redactString(value).slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) || EXACT_SECRET_KEYS.has(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

type Level = "debug" | "info" | "warn" | "error";

/** Structured logger that always redacts. Never pass raw user story content here. */
export const log = {
  write(level: Level, msg: string, meta?: Record<string, unknown>) {
    if (process.env.NODE_ENV === "test" && level !== "error") return;
    const line = JSON.stringify({
      level,
      msg,
      ...(meta ? (redact(meta) as object) : {}),
      at: new Date().toISOString(),
    });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  },
  debug: (msg: string, meta?: Record<string, unknown>) => log.write("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => log.write("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log.write("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log.write("error", msg, meta),
};

export function errorSummary(err: unknown): string {
  if (err instanceof Error) return redactString(`${err.name}: ${err.message}`).slice(0, 500);
  return redactString(String(err)).slice(0, 500);
}
