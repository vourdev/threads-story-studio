import { and, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";

import { track } from "../analytics/events";
import { db } from "../db/client";
import { affiliateLinks } from "../db/schema";
import { env } from "../env";
import { validateDestination } from "../products/service";
import { sha256 } from "../security/crypto";
import { log } from "../security/redact";

const BOT_UA =
  /bot|crawler|spider|preview|facebookexternalhit|meta-externalagent|slurp|curl|wget|python-requests|headless/i;

/**
 * Public tracked redirect. Only a slug is accepted — the destination always comes from the database
 * and is re-validated as a Shopee https URL, so this can never act as an open redirect.
 * Counts are "redirect clicks", not sales.
 */
export const redirectRoutes = new Hono().get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  if (!/^[a-z0-9]{6,16}$/.test(slug)) return c.text("Link not found", 404);

  const [link] = await db
    .select()
    .from(affiliateLinks)
    .where(and(eq(affiliateLinks.slug, slug), isNull(affiliateLinks.archivedAt)));
  if (!link) return c.text("Link not found", 404);

  let destination: string;
  try {
    destination = validateDestination(link.destinationUrl);
  } catch {
    log.warn("refused unsafe stored destination", { linkId: link.id });
    return c.text("Link unavailable", 410);
  }

  const ua = c.req.header("user-agent") ?? "";
  const bot = BOT_UA.test(ua);
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  try {
    if (!bot) {
      await db
        .update(affiliateLinks)
        .set({ clickCount: sql`${affiliateLinks.clickCount} + 1` })
        .where(eq(affiliateLinks.id, link.id));
    }
    await track({
      userId: link.userId,
      type: "affiliate_link_clicked",
      productId: link.productId,
      affiliateLinkId: link.id,
      meta: {
        bot,
        visitor: ip ? sha256(`${env.CLICK_IP_SALT ?? env.BETTER_AUTH_SECRET}:${ip}`).slice(0, 16) : null,
        referer: c.req.header("referer")?.slice(0, 200) ?? null,
      },
    });
  } catch (err) {
    log.warn("click tracking failed", { err: String(err) });
  }

  c.header("cache-control", "no-store");
  c.header("referrer-policy", "no-referrer-when-downgrade");
  return c.redirect(destination, 302);
});
