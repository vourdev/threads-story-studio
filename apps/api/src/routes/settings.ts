import { AI_PROVIDERS, appSettingsInput, isValidParamValue } from "@tss/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { getProvider, providerStatuses, runAI } from "../ai/orchestrator";
import { type AuthedEnv, requireUser } from "../auth/require-user";
import { db } from "../db/client";
import { appSettings } from "../db/schema";
import { env, integrations, threadsRedirectUri } from "../env";
import { validate } from "../lib/validate";
import { AppError } from "../security/errors";
import { enforceRateLimit } from "../security/rate-limit";

async function loadAppSettings(userId: string) {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.userId, userId));
  if (row) return row;
  const [created] = await db.insert(appSettings).values({ userId }).onConflictDoNothing().returning();
  return created ?? (await db.select().from(appSettings).where(eq(appSettings.userId, userId)))[0];
}

export const settingsRoutes = new Hono<AuthedEnv>()
  .use(requireUser)
  .get("/", async (c) => {
    const settings = await loadAppSettings(c.get("user").id);
    // Only booleans and non-secret identifiers are returned — never keys or tokens.
    return c.json({
      settings,
      ai: { providers: providerStatuses(), priority: env.AI_PROVIDER_PRIORITY },
      integrations: {
        threads: { configured: integrations.threads(), redirectUri: threadsRedirectUri() },
        buffer: { configured: integrations.buffer() },
        shopeeAffiliate: { configured: integrations.shopeeAffiliate() },
        cron: { configured: integrations.cron() },
      },
      apiBaseUrl: env.API_BASE_URL,
    });
  })
  .put("/", validate("json", appSettingsInput), async (c) => {
    const userId = c.get("user").id;
    const input = c.req.valid("json");
    try {
      new Intl.DateTimeFormat("en", { timeZone: input.timezone });
    } catch {
      throw new AppError("bad_request", "Unknown timezone");
    }
    const defaultParams = Object.fromEntries(
      Object.entries(input.defaultParams).filter(([k, v]) => isValidParamValue(k, v)),
    );
    await loadAppSettings(userId);
    const [settings] = await db
      .update(appSettings)
      .set({ ...input, defaultParams })
      .where(eq(appSettings.userId, userId))
      .returning();
    return c.json({ settings });
  })
  .post("/ai/test", validate("json", z.object({ provider: z.enum(AI_PROVIDERS) })), async (c) => {
    const userId = c.get("user").id;
    await enforceRateLimit(`ai-test:${userId}`, 6, 60);
    const { provider } = c.req.valid("json");
    if (!getProvider(provider).isConfigured()) return c.json({ ok: false, message: "Not configured on the server" });
    const started = Date.now();
    try {
      const result = await runAI({
        userId,
        workflow: "evaluate",
        provider,
        skipCache: true,
        schema: z.object({ ok: z.boolean() }),
        prompt: { version: "health", system: "You are a health check.", prompt: 'Reply with {"ok": true}.' },
        maxOutputTokens: 200,
      });
      return c.json({ ok: result.data.ok, model: result.model, latencyMs: Date.now() - started });
    } catch (err) {
      return c.json({ ok: false, message: err instanceof AppError ? err.message : "Provider check failed" });
    }
  });
