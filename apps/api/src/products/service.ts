import type { ProductInput } from "@tss/shared";
import { and, count, desc, eq, isNull } from "drizzle-orm";

import { ai } from "../ai/service";
import { track } from "../analytics/events";
import { db } from "../db/client";
import { affiliateLinks, products, stories } from "../db/schema";
import { integrations } from "../env";
import { randomSlug } from "../security/crypto";
import { AppError } from "../security/errors";
import { extractProduct } from "./extract";
import { getOwnedProduct } from "./facts";
import { generateShortLink } from "./shopee-affiliate-api";
import { extractSlugTitle, isShopeeHost, parseShopeeUrl } from "./shopee-url";

/** Imports a product from a Shopee link. Extraction failure still creates the product for manual completion. */
export async function importProduct(userId: string, url: string) {
  const extracted = await extractProduct(url);
  const slugTitle = extracted.name ?? extractSlugTitle(parseShopeeUrl(extracted.canonicalUrl || url));
  let name = slugTitle;
  let category = extracted.category;
  let description = extracted.description;
  let features = extracted.verifiedFields ?? [];
  let benefits: string[] = [];
  let status = extracted.status;
  let message = extracted.message;
  let dataSource = extracted.dataSource;

  // If page metadata didn't provide full details, use AI to infer from the URL and slug.
  if (!name || status !== "success") {
    try {
      const aiInferred = await ai.inferProduct(userId, {
        url,
        canonicalUrl: extracted.canonicalUrl,
        slugTitle,
      });
      if (aiInferred.data.name) {
        name = aiInferred.data.name;
        category = aiInferred.data.category || category;
        description = aiInferred.data.description || description;
        features = aiInferred.data.features?.length ? aiInferred.data.features : features;
        benefits = aiInferred.data.benefits?.length ? aiInferred.data.benefits : benefits;
        status = "success";
        message = "AI identified product details from the link.";
        dataSource = "og_meta";
      }
    } catch {
      // Keep best-effort extraction if AI call is unavailable
    }
  }

  const [row] = await db
    .insert(products)
    .values({
      userId,
      shopeeUrl: extracted.shopeeUrl,
      canonicalUrl: extracted.canonicalUrl,
      shopId: extracted.shopId,
      itemId: extracted.itemId,
      name: name ?? "Shopee Product",
      description,
      imageUrl: extracted.imageUrl,
      priceMin: extracted.priceMin,
      priceMax: extracted.priceMax,
      currency: extracted.currency,
      category,
      features,
      benefits,
      dataSource,
      verifiedFields: extracted.verifiedFields,
      extractionStatus: status,
      extractionMessage: message,
    })
    .returning();
  if (!row) throw new AppError("internal", "Could not save product");
  return {
    product: row,
    extraction: { status, message, source: dataSource },
  };
}

const FIELD_MAP = {
  name: "name",
  description: "description",
  imageUrl: "image",
  priceMin: "price",
  priceMax: "price",
  category: "category",
} as const;

/** Manual edits. Any field the user changes is no longer marked as verified. */
export async function updateProduct(userId: string, productId: string, input: Partial<ProductInput>) {
  const current = await getOwnedProduct(userId, productId);
  if (input.shopeeUrl) parseShopeeUrl(input.shopeeUrl);
  if (input.imageUrl && !input.imageUrl.startsWith("https://")) {
    throw new AppError("bad_request", "Image URL must use https.");
  }
  let verified = [...current.verifiedFields];
  for (const [key, tag] of Object.entries(FIELD_MAP)) {
    const next = input[key as keyof ProductInput];
    const prev = current[key as keyof typeof current];
    if (next !== undefined && String(next ?? "") !== String(prev ?? "")) verified = verified.filter((f) => f !== tag);
  }
  const [row] = await db
    .update(products)
    .set({
      ...(input.shopeeUrl !== undefined ? { shopeeUrl: input.shopeeUrl } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.category !== undefined ? { category: input.category || null } : {}),
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl || null } : {}),
      ...(input.priceMin !== undefined ? { priceMin: input.priceMin || null } : {}),
      ...(input.priceMax !== undefined ? { priceMax: input.priceMax || null } : {}),
      ...(input.currency !== undefined ? { currency: input.currency || null } : {}),
      ...(input.benefits !== undefined ? { benefits: input.benefits } : {}),
      ...(input.features !== undefined ? { features: input.features } : {}),
      verifiedFields: verified,
      // Product data changed: the cached AI analysis no longer applies.
      analysis: null,
    })
    .where(eq(products.id, productId))
    .returning();
  return row;
}

export async function listProducts(userId: string) {
  const rows = await db
    .select()
    .from(products)
    .where(and(eq(products.userId, userId), isNull(products.archivedAt)))
    .orderBy(desc(products.updatedAt))
    .limit(200);
  const clickRows = await db
    .select({ productId: affiliateLinks.productId, clicks: affiliateLinks.clickCount })
    .from(affiliateLinks)
    .where(eq(affiliateLinks.userId, userId));
  const clicks = new Map<string, number>();
  for (const r of clickRows) clicks.set(r.productId, (clicks.get(r.productId) ?? 0) + r.clicks);
  return rows.map((p) => ({ ...p, clicks: clicks.get(p.id) ?? 0 }));
}

export async function getProductDetail(userId: string, productId: string) {
  const product = await getOwnedProduct(userId, productId);
  const [links, relatedStories, [storyCount]] = await Promise.all([
    db
      .select()
      .from(affiliateLinks)
      .where(and(eq(affiliateLinks.productId, productId), isNull(affiliateLinks.archivedAt)))
      .orderBy(desc(affiliateLinks.createdAt)),
    db
      .select({ id: stories.id, title: stories.title, status: stories.status, updatedAt: stories.updatedAt })
      .from(stories)
      .where(and(eq(stories.productId, productId), isNull(stories.deletedAt)))
      .orderBy(desc(stories.updatedAt))
      .limit(50),
    db
      .select({ n: count() })
      .from(stories)
      .where(and(eq(stories.productId, productId), isNull(stories.deletedAt))),
  ]);
  await track({ userId, type: "product_viewed", productId });
  return {
    product,
    links,
    stories: relatedStories,
    storyCount: storyCount?.n ?? 0,
    affiliateApiAvailable: integrations.shopeeAffiliate(),
  };
}

export async function archiveProduct(userId: string, productId: string) {
  await getOwnedProduct(userId, productId);
  await db.update(products).set({ archivedAt: new Date() }).where(eq(products.id, productId));
}

export async function deleteProduct(userId: string, productId: string) {
  await getOwnedProduct(userId, productId);
  await db.transaction(async (tx) => {
    await tx.update(stories).set({ productId: null }).where(eq(stories.productId, productId));
    await tx.delete(affiliateLinks).where(eq(affiliateLinks.productId, productId));
    await tx.delete(products).where(eq(products.id, productId));
  });
}

/** Destination must be an https Shopee URL. It is stored exactly as given (tracking params intact). */
export function validateDestination(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("bad_request", "Invalid affiliate URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || !isShopeeHost(url.hostname)) {
    throw new AppError("bad_request", "The affiliate link must be an https Shopee link (e.g. s.shopee.co.id/…).");
  }
  return raw.trim();
}

async function uniqueSlug(): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const slug = randomSlug(8);
    const [existing] = await db
      .select({ id: affiliateLinks.id })
      .from(affiliateLinks)
      .where(eq(affiliateLinks.slug, slug));
    if (!existing) return slug;
  }
  throw new AppError("internal", "Could not allocate a link slug");
}

/** Saves an affiliate link the user pasted from the Shopee Affiliate dashboard. Not marked verified. */
export async function addManualLink(
  userId: string,
  productId: string,
  input: { destinationUrl: string; label?: string },
) {
  await getOwnedProduct(userId, productId);
  const destinationUrl = validateDestination(input.destinationUrl);
  const [row] = await db
    .insert(affiliateLinks)
    .values({
      userId,
      productId,
      destinationUrl,
      label: input.label ?? null,
      slug: await uniqueSlug(),
      source: "manual",
    })
    .returning();
  return row;
}

/** Generates a real affiliate short link through the Shopee Affiliate Open API. */
export async function generateAffiliateLink(userId: string, productId: string) {
  const product = await getOwnedProduct(userId, productId);
  if (!integrations.shopeeAffiliate()) {
    throw new AppError("not_configured", "Shopee Affiliate Open API credentials are not configured on the server.");
  }
  const origin = product.canonicalUrl ?? product.shopeeUrl;
  const shortLink = validateDestination(await generateShortLink(origin));
  const [row] = await db
    .insert(affiliateLinks)
    .values({
      userId,
      productId,
      destinationUrl: shortLink,
      label: "Shopee Affiliate API",
      slug: await uniqueSlug(),
      source: "affiliate_api",
      isVerifiedAffiliate: true,
    })
    .returning();
  return row;
}

export async function archiveLink(userId: string, linkId: string) {
  const [row] = await db
    .update(affiliateLinks)
    .set({ archivedAt: new Date() })
    .where(and(eq(affiliateLinks.id, linkId), eq(affiliateLinks.userId, userId)))
    .returning();
  if (!row) throw new AppError("not_found", "Link not found");
}
