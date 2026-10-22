import { AppError } from "../security/errors";

/** Hosts we accept as Shopee product or affiliate links (no wildcards beyond Shopee's own domains). */
const SHOPEE_HOST = /^(?:[a-z0-9-]+\.)*shopee\.(?:co\.id|com|com\.my|sg|co\.th|ph|vn|tw|com\.br|com\.mx|cl|com\.co)$/i;
const SHORT_HOSTS = new Set(["shope.ee", "s.shopee.co.id", "id.shp.ee", "shp.ee"]);

export function isShopeeHost(host: string): boolean {
  const h = host.toLowerCase();
  return SHOPEE_HOST.test(h) || SHORT_HOSTS.has(h);
}

export function isShortLinkHost(host: string): boolean {
  const h = host.toLowerCase();
  return SHORT_HOSTS.has(h) || /^s\.shopee\./.test(h);
}

/** Parses and validates a user-supplied Shopee URL. Only https (or http upgraded) Shopee hosts are accepted. */
export function parseShopeeUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new AppError("bad_request", "That doesn't look like a valid URL.");
  }
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:") throw new AppError("bad_request", "Only https links are supported.");
  if (url.username || url.password) throw new AppError("bad_request", "Links with credentials are not allowed.");
  if (url.port && url.port !== "443") throw new AppError("bad_request", "Unexpected port in link.");
  if (!isShopeeHost(url.hostname))
    throw new AppError("bad_request", "Please paste a Shopee product or affiliate link.");
  return url;
}

/** Extracts shop and item ids from the common Shopee product URL shapes. */
export function extractProductIds(url: URL): { shopId: string; itemId: string } | null {
  // https://shopee.co.id/Nama-Produk-i.12345.67890
  const slug = url.pathname.match(/-i\.(\d+)\.(\d+)(?:$|[/?#])/);
  if (slug?.[1] && slug[2]) return { shopId: slug[1], itemId: slug[2] };
  // https://shopee.co.id/product/12345/67890
  const product = url.pathname.match(/^\/product\/(\d+)\/(\d+)/);
  if (product?.[1] && product[2]) return { shopId: product[1], itemId: product[2] };
  // https://shopee.co.id/universal-link/...-i.123.456
  const universal = decodeURIComponent(url.pathname).match(/i\.(\d+)\.(\d+)/);
  if (universal?.[1] && universal[2]) return { shopId: universal[1], itemId: universal[2] };
  return null;
}

export const BROWSER_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

/** Extracts clean product title from Shopee URL slug if present. */
export function extractSlugTitle(url: URL): string | null {
  // https://shopee.co.id/Nama-Produk-Disini-i.12345.67890
  const slugMatch = url.pathname.match(/^\/([^/]+)-i\.\d+\.\d+/);
  const target = slugMatch?.[1] ?? (url.pathname.startsWith("/product/") ? null : url.pathname.split("/")[1]);
  if (target) {
    const cleaned = decodeURIComponent(target)
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned && !/^(product|item|universal-link|buy|cart)\b/i.test(cleaned) && cleaned.length > 2) {
      return cleaned;
    }
  }
  return null;
}

export type ResolvedLink = { finalUrl: URL; hops: string[] };

/**
 * Follows short-link redirects manually (max 5 hops). Every hop must stay on a Shopee host,
 * which prevents SSRF through attacker-controlled redirects.
 */
export async function resolveShopeeUrl(
  input: string,
  fetchImpl: typeof fetch = fetch,
  maxHops = 5,
): Promise<ResolvedLink> {
  let current = parseShopeeUrl(input);
  const hops: string[] = [current.toString()];
  for (let i = 0; i < maxHops; i++) {
    if (!isShortLinkHost(current.hostname)) return { finalUrl: current, hops };
    let location: string | null = null;
    try {
      const response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        headers: {
          "user-agent": BROWSER_UA,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        },
        signal: AbortSignal.timeout(8000),
      });
      location = response.headers.get("location");
      if (!location && response.ok) {
        const text = (await response.text()).slice(0, 50_000);
        const metaRefresh = text.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"'>\s]+)/i);
        const jsRedirect = text.match(/(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i);
        const canonical = text.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
        location = metaRefresh?.[1] ?? jsRedirect?.[1] ?? canonical?.[1] ?? null;
      } else {
        await response.body?.cancel().catch(() => undefined);
      }
    } catch {
      break;
    }
    if (!location) break;
    const next = new URL(location, current);
    if (next.protocol !== "https:" || !isShopeeHost(next.hostname)) {
      throw new AppError("bad_request", "This link redirects outside Shopee, so it can't be used.");
    }
    current = next;
    hops.push(current.toString());
  }
  return { finalUrl: current, hops };
}
