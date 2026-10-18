import { createStoryInput } from "@tss/shared";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client";
import { publications, rateLimitBuckets, stories, users } from "../db/schema";
import { env } from "../env";
import { inBackground, drive } from "../jobs/drive";
import { validate } from "../lib/validate";
import * as publishing from "../publishing/service";
import { safeEqual } from "../security/crypto";
import { AppError } from "../security/errors";
import { enforceRateLimit } from "../security/rate-limit";
import { errorSummary, log } from "../security/redact";
import * as storyService from "../stories/service";

const webhookPayloadSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("ping"),
  }),
  z.object({
    action: z.literal("create_and_generate_story"),
    userEmail: z.string().email(),
    story: createStoryInput,
    count: z.number().int().min(1).max(5).default(3),
    idempotencyKey: z.string().min(1).max(200),
  }),
  z.object({
    action: z.literal("publish_story"),
    userEmail: z.string().email(),
    storyId: z.string().uuid(),
    provider: z.enum(["threads", "buffer"]),
    scheduledFor: z.string().datetime().optional(),
    idempotencyKey: z.string().min(1).max(200),
  }),
]);

export const webhookRoutes = new Hono()
  .use(async (c, next) => {
    // Validate secret header
    const secret = c.req.header("x-webhook-secret");
    const expected = env.CRON_SECRET;
    if (!expected || !secret || !safeEqual(secret, expected)) {
      throw new AppError("unauthorized", "Invalid or missing webhook secret.");
    }
    await next();
  })
  .post("/n8n", validate("json", webhookPayloadSchema), async (c) => {
    const payload = c.req.valid("json");

    if (payload.action === "ping") {
      return c.json({ ok: true, message: "n8n webhook active" });
    }

    // Resolve user by email through trusted server-side DB query (never blind trust of raw client user_id)
    const [user] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, payload.userEmail));

    if (!user) {
      throw new AppError("not_found", `User with email ${payload.userEmail} not found.`);
    }

    // Check rate limit for this user
    await enforceRateLimit(`n8n:${user.id}`, 30, 600);

    // Prevent duplicate webhook execution using an idempotency key check
    const idempotencyBucketKey = `webhook:n8n:${user.id}:${payload.idempotencyKey}`;
    const windowStart = new Date(Math.floor(Date.now() / (24 * 3600 * 1000)) * 24 * 3600 * 1000);
    const [existingExecution] = await db
      .select()
      .from(rateLimitBuckets)
      .where(and(eq(rateLimitBuckets.key, idempotencyBucketKey), eq(rateLimitBuckets.windowStart, windowStart)));

    if (existingExecution && existingExecution.count > 0) {
      log.info("duplicate n8n webhook ignored", { key: idempotencyBucketKey });
      return c.json({ ok: true, duplicate: true, message: "Webhook already processed" });
    }

    // Mark as processed
    await db
      .insert(rateLimitBuckets)
      .values({ key: idempotencyBucketKey, windowStart, count: 1 })
      .onConflictDoNothing();

    if (payload.action === "create_and_generate_story") {
      try {
        const story = await storyService.createStory(user.id, payload.story);
        const variations = await storyService.generateVariations(user.id, story.id, payload.count);
        return c.json({ ok: true, story, variations }, 201);
      } catch (err) {
        log.error("n8n story generation failed", { userId: user.id, err: errorSummary(err) });
        throw err;
      }
    }

    if (payload.action === "publish_story") {
      try {
        const result = await publishing.requestPublish(
          user.id,
          payload.storyId,
          { provider: payload.provider, scheduledFor: payload.scheduledFor },
          payload.idempotencyKey,
        );
        if (result.publication.status === "publishing") {
          const publicationId = result.publication.id;
          inBackground("n8n-publish", () => drive({ publicationId }));
        }
        return c.json({ ok: true, publication: result.publication, duplicate: result.duplicate });
      } catch (err) {
        log.error("n8n publishing failed", { userId: user.id, err: errorSummary(err) });
        throw err;
      }
    }

    return c.json({ ok: false, message: "Unhandled action" }, 400);
  });
