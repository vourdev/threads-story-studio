import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { secureHeaders } from "hono/secure-headers";

import { auth, isSignupOpen } from "./auth/auth";
import { db } from "./db/client";
import { accountRoutes, threadsOAuthCallback } from "./routes/accounts";
import { cronRoutes } from "./routes/cron";
import { dashboardRoutes, deviceRoutes } from "./routes/dashboard";
import { productRoutes } from "./routes/products";
import { publishingRoutes } from "./routes/publishing";
import { redirectRoutes } from "./routes/redirect";
import { settingsRoutes } from "./routes/settings";
import { storyRoutes } from "./routes/stories";
import { AppError, toErrorBody } from "./security/errors";
import { enforceRateLimit } from "./security/rate-limit";
import { errorSummary, log } from "./security/redact";

export const app = new Hono();

app.use(secureHeaders());
// Story payloads (variations, versions) compress ~5-10x; mobile clients decode gzip transparently.
app.use(compress({ threshold: 1024 }));
// Response time for every request; slow ones are logged (path only, never bodies).
app.use(async (c, next) => {
  const started = performance.now();
  await next();
  const ms = Math.round(performance.now() - started);
  c.header("x-response-time", `${ms}ms`);
  if (ms > 2_000) log.info("slow request", { method: c.req.method, path: c.req.path, status: c.res.status, ms });
});
app.use("*", async (c, next) => {
  await next();
  c.header("cache-control", c.res.headers.get("cache-control") ?? "no-store");
});

app.onError((err, c) => {
  if (err instanceof AppError) {
    if (err.status >= 500) log.error("app error", { code: err.code, path: c.req.path, cause: errorSummary(err.cause) });
    if (err.code === "rate_limited" && typeof err.details?.retryAfterSeconds === "number") {
      c.header("retry-after", String(err.details.retryAfterSeconds));
    }
    return c.json(toErrorBody(err), err.status);
  }
  log.error("unhandled error", { path: c.req.path, err: errorSummary(err) });
  return c.json({ error: { code: "internal", message: "Something went wrong. Please try again." } }, 500);
});
app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));

app.get("/healthz", (c) => c.text("ok"));

app.get("/api/health", async (c) => {
  const started = Date.now();
  await db.execute(sql`select 1`);
  return c.json({ ok: true, db: "up", latencyMs: Date.now() - started });
});

// Public: lets the app decide between "Create owner account" and "Sign in".
app.get("/api/auth-status", async (c) => c.json({ signupOpen: await isSignupOpen() }));

// Brute-force protection for credential endpoints, shared across instances via Postgres.
app.use("/api/auth/sign-in/*", async (c, next) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  await enforceRateLimit(`signin:${ip}`, 10, 600);
  await next();
});
app.use("/api/auth/sign-up/*", async (c, next) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  await enforceRateLimit(`signup:${ip}`, 5, 3600);
  await next();
});
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.route("/api/stories", storyRoutes);
app.route("/api/products", productRoutes);
app.route("/api/publishing", publishingRoutes);
app.route("/api/accounts", accountRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/dashboard", dashboardRoutes);
app.route("/api/devices", deviceRoutes);
app.route("/api/threads/oauth/callback", threadsOAuthCallback);
app.route("/api/cron", cronRoutes);
app.route("/r", redirectRoutes);
