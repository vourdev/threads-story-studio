import { integrations } from "../env";
import { log } from "../security/redact";
import { fetchProductOffer } from "./shopee-affiliate-api";
import { extractProductIds, resolveShopeeUrl } from "./shopee-url";

export type ExtractedProduct = {
  shopeeUrl: string;
  canonicalUrl: string;
  shopId: string | null;
  itemId: string | null;
  name: string | null;
  description: string | null;
  imageUrl: string | null;
  priceMin: string | null;
  priceMax: string | null;
  currency: string | null;
  category: string | null;
  dataSource: "affiliate_api" | "og_meta" | "manual";
  verifiedFields: string[];
  status: "success" | "partial" | "failed";
  message: string;
};

const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

function meta(html: string, property: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${property}["']`,
    "i",
  );
  const m = html.match(re);
  const value = m?.[1] ?? m?.[2];
  return value ? decodeEntities(value).trim() : null;
}

/** Shopee prices (affiliate API) are plain decimal strings. Keep only well-formed values. */
function decimalOrNull(value: string | undefined | null): string | null {
  if (!value) return null;
  const v = String(value).trim();
  return /^\d{1,10}(\.\d{1,2})?$/.test(v) ? v : null;
}

/**
 * Best-effort, permitted product lookup:
 *  1. Shopee Affiliate Open API (official data) when configured.
 *  2. Public page metadata (og:/meta tags) with a single honest request — Shopee pages are often
 *     JS-rendered or protected; we never try to bypass that.
 *  3. Otherwise report failure so the user can fill the form manually. The URL is always kept.
 */
export async function extractProduct(inputUrl: string, fetchImpl: typeof fetch = fetch): Promise<ExtractedProduct> {
  const resolved = await resolveShopeeUrl(inputUrl, fetchImpl);
  const ids = extractProductIds(resolved.finalUrl);
  const base: ExtractedProduct = {
    shopeeUrl: inputUrl.trim(),
    canonicalUrl: `${resolved.finalUrl.origin}${resolved.finalUrl.pathname}`,
    shopId: ids?.shopId ?? null,
    itemId: ids?.itemId ?? null,
    name: null,
    description: null,
    imageUrl: null,
    priceMin: null,
    priceMax: null,
    currency: null,
    category: null,
    dataSource: "manual",
    verifiedFields: [],
    status: "failed",
    message: "",
  };

  if (ids && integrations.shopeeAffiliate()) {
    try {
      const offer = await fetchProductOffer(ids, fetchImpl);
      if (offer?.productName) {
        const priceMin = decimalOrNull(offer.priceMin);
        const priceMax = decimalOrNull(offer.priceMax);
        return {
          ...base,
          name: offer.productName,
          imageUrl: offer.imageUrl ?? null,
          priceMin,
          priceMax,
          currency: priceMin ? "IDR" : null,
          dataSource: "affiliate_api",
          verifiedFields: ["name", ...(offer.imageUrl ? ["image"] : []), ...(priceMin ? ["price"] : [])],
          status: "partial",
          message: "Loaded from the Shopee Affiliate API. Add benefits and details from the product page.",
        };
      }
    } catch (err) {
      log.warn("shopee affiliate lookup failed", { err: String(err) });
    }
  }

  try {
    const response = await fetchImpl(resolved.finalUrl, {
      headers: { "user-agent": "ThreadsStoryStudio/1.0 (+link preview)", accept: "text/html" },
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok && (response.headers.get("content-type") ?? "").includes("text/html")) {
      const html = (await response.text()).slice(0, 500_000);
      const title = meta(html, "og:title");
      const genericTitle = !title || /^shopee( indonesia)?\b/i.test(title) || /login|captcha|verify/i.test(title);
      if (!genericTitle) {
        const description = meta(html, "og:description") ?? meta(html, "description");
        const image = meta(html, "og:image");
        return {
          ...base,
          name: title.replace(/\s*\|\s*Shopee.*$/i, "").trim(),
          description,
          imageUrl: image,
          dataSource: "og_meta",
          verifiedFields: ["name", ...(description ? ["description"] : []), ...(image ? ["image"] : [])],
          status: "partial",
          message: "Read the product title from the page. Price and benefits must be added manually.",
        };
      }
    } else {
      await response.body?.cancel().catch(() => undefined);
    }
  } catch (err) {
    log.info("shopee page metadata unavailable", { err: String(err) });
  }

  return {
    ...base,
    message:
      "Shopee didn't share product details for this link (pages are often protected or rendered by JavaScript). Enter the product information manually — your link is saved.",
  };
}
