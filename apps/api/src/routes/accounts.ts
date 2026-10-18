import { Hono } from "hono";
import { z } from "zod";

import { type AuthedEnv, requireUser } from "../auth/require-user";
import { env } from "../env";
import { validate } from "../lib/validate";
import * as accounts from "../publishing/accounts";
import { AppError } from "../security/errors";
import { enforceRateLimit } from "../security/rate-limit";
import { errorSummary, log } from "../security/redact";

const providerParam = z.object({ provider: z.enum(["threads", "buffer"]) });

export const accountRoutes = new Hono<AuthedEnv>()
  .use(requireUser)
  .get("/", async (c) => c.json({ accounts: await accounts.connectionOverview(c.get("user").id) }))
  .post("/threads/oauth/start", async (c) => {
    const userId = c.get("user").id;
    await enforceRateLimit(`oauth:${userId}`, 10, 600);
    return c.json(await accounts.startThreadsOAuth(userId));
  })
  // Token travels in the body, never the URL (URLs end up in access logs and proxies).
  .post(
    "/buffer/channels",
    validate("json", z.object({ token: z.string().trim().min(1).max(500).optional() })),
    async (c) => {
      const userId = c.get("user").id;
      await enforceRateLimit(`buffer-channels:${userId}`, 20, 600);
      return c.json({ organizations: await accounts.bufferChannels(userId, c.req.valid("json").token) });
    },
  )
  .post(
    "/buffer/connect",
    validate(
      "json",
      z.object({
        organizationId: z.string().min(1).max(100),
        channelId: z.string().min(1).max(100),
        token: z.string().trim().min(1).max(500).optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid("json");
      await accounts.connectBuffer(c.get("user").id, body.organizationId, body.channelId, body.token);
      return c.json({ ok: true });
    },
  )
  .post("/:provider/validate", validate("param", providerParam), async (c) => {
    return c.json(await accounts.validateConnection(c.get("user").id, c.req.valid("param").provider));
  })
  .delete("/:provider", validate("param", providerParam), async (c) => {
    await accounts.disconnect(c.get("user").id, c.req.valid("param").provider);
    return c.json({ ok: true });
  });

/**
 * Public OAuth callback (Threads redirects the in-app browser here). The user is identified only by the
 * single-use state created by an authenticated /start call. Always ends with a redirect back into the app.
 */
export const threadsOAuthCallback = new Hono().get("/", async (c) => {
  const back = (result: "connected" | "error", code?: string) => {
    const url = new URL(`${env.APP_SCHEME}://integrations/threads`);
    url.searchParams.set("result", result);
    if (code) url.searchParams.set("code", code);
    return c.redirect(url.toString(), 302);
  };
  const error = c.req.query("error");
  if (error) return back("error", error === "access_denied" ? "denied" : "provider_error");
  const state = c.req.query("state");
  const code = c.req.query("code");
  if (!state || !code) return back("error", "missing_params");
  try {
    await enforceRateLimit(`oauth-callback:${c.req.header("x-forwarded-for") ?? "local"}`, 20, 600);
    await accounts.completeThreadsOAuth(state, code);
    return back("connected");
  } catch (err) {
    log.warn("threads oauth callback failed", { err: errorSummary(err) });
    return back("error", err instanceof AppError && err.code === "bad_request" ? "invalid_state" : "exchange_failed");
  }
});
