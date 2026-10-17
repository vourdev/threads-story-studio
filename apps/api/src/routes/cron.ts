import { Hono } from "hono";

import { env } from "../env";
import { runTick } from "../jobs/tick";
import { safeEqual } from "../security/crypto";

/** Vercel Cron (GET with `Authorization: Bearer CRON_SECRET`) or any external pinger. */
export const cronRoutes = new Hono().on(["GET", "POST"], "/tick", async (c) => {
  if (!env.CRON_SECRET) return c.json({ error: { code: "not_configured", message: "CRON_SECRET is not set" } }, 503);
  const header = c.req.header("authorization") ?? "";
  if (!safeEqual(header, `Bearer ${env.CRON_SECRET}`)) {
    return c.json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
  }
  const report = await runTick();
  return c.json({ ok: true, report });
});
