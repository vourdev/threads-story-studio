import { and, eq } from "drizzle-orm";

import type { ProductFacts } from "../ai/prompts/v1";
import { db } from "../db/client";
import { products } from "../db/schema";
import { notFound } from "../security/errors";

export async function getOwnedProduct(userId: string, productId: string) {
  const [row] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.userId, userId)));
  if (!row) throw notFound("Product");
  return row;
}

export function toProductFacts(row: typeof products.$inferSelect): ProductFacts {
  return {
    name: row.name,
    category: row.category,
    description: row.description,
    priceMin: row.priceMin,
    priceMax: row.priceMax,
    currency: row.currency,
    benefits: row.benefits,
    features: row.features,
    verifiedFields: row.verifiedFields,
    dataSource: row.dataSource,
  };
}
