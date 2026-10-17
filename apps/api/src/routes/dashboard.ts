import { registerDeviceInput } from "@tss/shared";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { dashboard, RANGES, type Range } from "../analytics/queries";
import { type AuthedEnv, requireUser } from "../auth/require-user";
import { db } from "../db/client";
import { devices } from "../db/schema";
import { validate } from "../lib/validate";
import { getUserTimezone } from "../publishing/service";

export const dashboardRoutes = new Hono<AuthedEnv>()
  .use(requireUser)
  .get(
    "/",
    validate("query", z.object({ range: z.enum(Object.keys(RANGES) as [Range, ...Range[]]).default("30d") })),
    async (c) => {
      const userId = c.get("user").id;
      return c.json(await dashboard(userId, c.req.valid("query").range, await getUserTimezone(userId)));
    },
  );

export const deviceRoutes = new Hono<AuthedEnv>()
  .use(requireUser)
  .post("/", validate("json", registerDeviceInput), async (c) => {
    const userId = c.get("user").id;
    const input = c.req.valid("json");
    await db
      .insert(devices)
      .values({ userId, expoPushToken: input.expoPushToken, platform: input.platform })
      .onConflictDoUpdate({
        target: devices.expoPushToken,
        set: { userId, platform: input.platform, lastSeenAt: new Date(), disabledAt: null },
      });
    return c.json({ ok: true });
  })
  .delete("/", validate("json", z.object({ expoPushToken: z.string().max(200) })), async (c) => {
    await db
      .delete(devices)
      .where(and(eq(devices.userId, c.get("user").id), eq(devices.expoPushToken, c.req.valid("json").expoPushToken)));
    return c.json({ ok: true });
  });
