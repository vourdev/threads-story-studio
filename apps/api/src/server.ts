// Long-running Node server (local dev and Render). Vercel uses src/index.ts instead.
import { serve } from "@hono/node-server";

import { app } from "./app";
import { env } from "./env";
import { runTick } from "./jobs/tick";
import { errorSummary, log } from "./security/redact";

serve({ fetch: app.fetch, port: env.PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(`Threads Story Studio API on http://localhost:${info.port}`);
});

// Maintenance without an external scheduler: shortly after boot, then every 6 hours while the
// process is up. Timers are unref'd so they never keep the process alive on their own.
const MAINTENANCE_EVERY_MS = 6 * 60 * 60 * 1000;
const maintain = () =>
  runTick({ budgetMs: 30_000 }).catch((err) => log.error("maintenance failed", { err: errorSummary(err) }));
if (env.NODE_ENV !== "test") {
  setTimeout(maintain, 60_000).unref();
  setInterval(maintain, MAINTENANCE_EVERY_MS).unref();
}
