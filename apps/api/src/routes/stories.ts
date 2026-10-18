import {
  createStoryInput,
  generateInput,
  libraryQuery,
  paramOperationInput,
  refineInput,
  saveContentInput,
  updateStoryInputInput,
} from "@tss/shared";
import { Hono } from "hono";
import { z } from "zod";

import { type AuthedEnv, requireUser } from "../auth/require-user";
import { validate } from "../lib/validate";
import { enforceRateLimit } from "../security/rate-limit";
import { listMessages, sendChatMessage } from "../stories/chat";
import * as stories from "../stories/service";

const idParam = z.object({ id: z.uuid() });
const aiLimit = (userId: string) => enforceRateLimit(`ai:${userId}`, 30, 60);

export const storyRoutes = new Hono<AuthedEnv>()
  .use(requireUser)
  .get("/", validate("query", libraryQuery), async (c) => {
    return c.json(await stories.listStories(c.get("user").id, c.req.valid("query")));
  })
  .post("/", validate("json", createStoryInput), async (c) => {
    const story = await stories.createStory(c.get("user").id, c.req.valid("json"));
    return c.json({ story }, 201);
  })
  .get("/:id", validate("param", idParam), async (c) => {
    return c.json(await stories.getStoryDetail(c.get("user").id, c.req.valid("param").id));
  })
  .patch("/:id/input", validate("param", idParam), validate("json", updateStoryInputInput), async (c) => {
    await stories.updateInput(c.get("user").id, c.req.valid("param").id, c.req.valid("json"));
    return c.json({ ok: true });
  })
  .post("/:id/analyze", validate("param", idParam), async (c) => {
    const userId = c.get("user").id;
    await aiLimit(userId);
    return c.json(await stories.analyzeStory(userId, c.req.valid("param").id));
  })
  /** Analyze + suggest in one request: one round trip for the app, and it completes even if the app goes to background. */
  .post("/:id/prepare", validate("param", idParam), async (c) => {
    const userId = c.get("user").id;
    await aiLimit(userId);
    const id = c.req.valid("param").id;
    const analysis = await stories.analyzeStory(userId, id);
    const suggested = await stories.suggestParams(userId, id);
    return c.json({ ...analysis, ...suggested });
  })
  .post("/:id/suggest", validate("param", idParam), async (c) => {
    const userId = c.get("user").id;
    await aiLimit(userId);
    return c.json(await stories.suggestParams(userId, c.req.valid("param").id));
  })
  .post("/:id/params", validate("param", idParam), validate("json", paramOperationInput), async (c) => {
    const params = await stories.applyParamOperation(c.get("user").id, c.req.valid("param").id, c.req.valid("json"));
    return c.json({ params });
  })
  .post("/:id/generate", validate("param", idParam), validate("json", generateInput), async (c) => {
    const userId = c.get("user").id;
    await aiLimit(userId);
    const body = c.req.valid("json");
    const variations = await stories.generateVariations(userId, c.req.valid("param").id, body.count, {
      disablePersonalization: body.disablePersonalization,
    });
    return c.json({ variations });
  })
  .post("/:id/variations/new", validate("param", idParam), async (c) => {
    const userId = c.get("user").id;
    await aiLimit(userId);
    const variations = await stories.generateVariations(userId, c.req.valid("param").id, 1, {
      avoidExistingHooks: true,
    });
    return c.json({ variations });
  })
  .post("/:id/select", validate("param", idParam), validate("json", z.object({ variationId: z.uuid() })), async (c) => {
    const story = await stories.selectVariation(
      c.get("user").id,
      c.req.valid("param").id,
      c.req.valid("json").variationId,
    );
    return c.json({ story });
  })
  .put(
    "/:id/content",
    validate("param", idParam),
    validate("json", saveContentInput.extend({ cta: z.string().max(300).nullable().optional() })),
    async (c) => {
      const body = c.req.valid("json");
      const story = await stories.saveContent(
        c.get("user").id,
        c.req.valid("param").id,
        body.posts,
        body.note,
        body.cta,
      );
      return c.json({ story });
    },
  )
  .post("/:id/refine", validate("param", idParam), validate("json", refineInput), async (c) => {
    const userId = c.get("user").id;
    await aiLimit(userId);
    const story = await stories.refineStory(userId, c.req.valid("param").id, c.req.valid("json"));
    return c.json({ story });
  })
  .post("/:id/evaluate", validate("param", idParam), async (c) => {
    const userId = c.get("user").id;
    await aiLimit(userId);
    return c.json({ evaluation: await stories.evaluateStory(userId, c.req.valid("param").id) });
  })
  .get("/:id/chat", validate("param", idParam), async (c) => {
    return c.json({ messages: await listMessages(c.get("user").id, c.req.valid("param").id) });
  })
  .post(
    "/:id/chat",
    validate("param", idParam),
    validate("json", z.object({ message: z.string().trim().min(1).max(2000) })),
    async (c) => {
      const userId = c.get("user").id;
      await aiLimit(userId);
      return c.json(await sendChatMessage(userId, c.req.valid("param").id, c.req.valid("json").message));
    },
  )
  .get("/:id/versions", validate("param", idParam), async (c) => {
    return c.json({ versions: await stories.listVersions(c.get("user").id, c.req.valid("param").id) });
  })
  .post(
    "/:id/versions/:versionNo/restore",
    validate("param", z.object({ id: z.uuid(), versionNo: z.coerce.number().int().min(1) })),
    async (c) => {
      const { id, versionNo } = c.req.valid("param");
      return c.json({ story: await stories.restoreVersion(c.get("user").id, id, versionNo) });
    },
  )
  .post("/:id/duplicate", validate("param", idParam), async (c) => {
    return c.json({ story: await stories.duplicateStory(c.get("user").id, c.req.valid("param").id) }, 201);
  })
  .put(
    "/:id/link",
    validate("param", idParam),
    validate(
      "json",
      z.object({ affiliateLinkId: z.uuid().nullable(), cta: z.string().max(300).nullable().optional() }),
    ),
    async (c) => {
      const body = c.req.valid("json");
      return c.json({
        story: await stories.setLink(c.get("user").id, c.req.valid("param").id, body.affiliateLinkId, body.cta),
      });
    },
  )
  .delete("/:id", validate("param", idParam), async (c) => {
    await stories.deleteStory(c.get("user").id, c.req.valid("param").id);
    return c.json({ ok: true });
  });
