import { PUBLICATION_STATUSES, publishInput } from "@tss/shared";
import { Hono } from "hono";
import { z } from "zod";

import { type AuthedEnv, requireUser } from "../auth/require-user";
import { drive, inBackground } from "../jobs/drive";
import { validate } from "../lib/validate";
import * as publishing from "../publishing/service";
import { enforceRateLimit } from "../security/rate-limit";
import { getOwnedStory } from "../stories/service";

const idParam = z.object({ id: z.uuid() });

export const publishingRoutes = new Hono<AuthedEnv>()
  .use(requireUser)
  .get("/stories/:id/preview", validate("param", idParam), async (c) => {
    const story = await getOwnedStory(c.get("user").id, c.req.valid("param").id);
    return c.json({ posts: await publishing.composeStoryForPublishing(story) });
  })
  .post("/stories/:id/publish", validate("param", idParam), validate("json", publishInput), async (c) => {
    const userId = c.get("user").id;
    await enforceRateLimit(`publish:${userId}`, 20, 600);
    const result = await publishing.requestPublish(
      userId,
      c.req.valid("param").id,
      c.req.valid("json"),
      c.req.header("idempotency-key"),
    );
    // Publish immediately: the job runs to completion after the response is sent.
    if (result.publication.status === "publishing") {
      const publicationId = result.publication.id;
      inBackground("publish", () => drive({ publicationId }));
    }
    return c.json(result, result.duplicate ? 200 : 201);
  })
  .get(
    "/publications",
    validate(
      "query",
      z.object({
        status: z.enum(PUBLICATION_STATUSES).optional(),
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
      }),
    ),
    async (c) => {
      const q = c.req.valid("query");
      const items = await publishing.listPublications(c.get("user").id, {
        status: q.status,
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
      });
      return c.json({
        items: items.map(({ preview, ...rest }) => ({
          ...rest,
          preview: preview[0]?.text.slice(0, 200) ?? "",
          postCount: preview.length,
        })),
      });
    },
  )
  .get("/publications/:id", validate("param", idParam), async (c) => {
    return c.json(await publishing.getPublicationDetail(c.get("user").id, c.req.valid("param").id));
  })
  .post("/publications/:id/retry", validate("param", idParam), async (c) => {
    const publicationId = c.req.valid("param").id;
    await publishing.retryPublication(c.get("user").id, publicationId);
    inBackground("retry", () => drive({ publicationId }));
    return c.json({ ok: true });
  })
  .delete("/publications/:id", validate("param", idParam), async (c) => {
    const publicationId = c.req.valid("param").id;
    await publishing.cancelPublication(c.get("user").id, publicationId);
    return c.json({ ok: true });
  })
  /**
   * Called by the app when it opens or while a post is in progress: continues any of this user's
   * unfinished publishing work (e.g. after a server restart) and Buffer status checks.
   */
  .post("/run", async (c) => {
    const userId = c.get("user").id;
    await enforceRateLimit(`jobs-run:${userId}`, 30, 600);
    inBackground("app-run", () => drive({ userId }));
    return c.json({ ok: true }, 202);
  });
