import { affiliateLinkInput, productInput } from "@tss/shared";
import { Hono } from "hono";
import { z } from "zod";

import { type AuthedEnv, requireUser } from "../auth/require-user";
import { env } from "../env";
import { validate } from "../lib/validate";
import * as productsService from "../products/service";
import { enforceRateLimit } from "../security/rate-limit";

const idParam = z.object({ id: z.uuid() });

const linkView = (link: { slug: string } & Record<string, unknown>) => ({
  ...link,
  trackedUrl: `${env.API_BASE_URL}/r/${link.slug}`,
});

export const productRoutes = new Hono<AuthedEnv>()
  .use(requireUser)
  .get("/", async (c) => c.json({ products: await productsService.listProducts(c.get("user").id) }))
  .post("/import", validate("json", z.object({ url: z.string().trim().min(8).max(2000) })), async (c) => {
    const userId = c.get("user").id;
    await enforceRateLimit(`product-import:${userId}`, 20, 60);
    return c.json(await productsService.importProduct(userId, c.req.valid("json").url), 201);
  })
  .get("/:id", validate("param", idParam), async (c) => {
    const detail = await productsService.getProductDetail(c.get("user").id, c.req.valid("param").id);
    return c.json({ ...detail, links: detail.links.map(linkView) });
  })
  .patch("/:id", validate("param", idParam), validate("json", productInput.partial()), async (c) => {
    const product = await productsService.updateProduct(c.get("user").id, c.req.valid("param").id, c.req.valid("json"));
    return c.json({ product });
  })
  .delete("/:id", validate("param", idParam), async (c) => {
    await productsService.deleteProduct(c.get("user").id, c.req.valid("param").id);
    return c.json({ ok: true });
  })
  .post("/:id/links", validate("param", idParam), validate("json", affiliateLinkInput), async (c) => {
    const link = await productsService.addManualLink(c.get("user").id, c.req.valid("param").id, c.req.valid("json"));
    return c.json({ link: link ? linkView(link) : null }, 201);
  })
  .post("/:id/links/generate", validate("param", idParam), async (c) => {
    const link = await productsService.generateAffiliateLink(c.get("user").id, c.req.valid("param").id);
    return c.json({ link: link ? linkView(link) : null }, 201);
  })
  .delete("/links/:id", validate("param", idParam), async (c) => {
    await productsService.archiveLink(c.get("user").id, c.req.valid("param").id);
    return c.json({ ok: true });
  });
