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
    const response = await fetchImpl(current, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": "ThreadsStoryStudio/1.0 (+link preview)" },
      signal: AbortSignal.timeout(8000),
    });
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (response.status < 300 || response.status >= 400 || !location) return { finalUrl: current, hops };
    const next = new URL(location, current);
    if (next.protocol !== "https:" || !isShopeeHost(next.hostname)) {
      throw new AppError("bad_request", "This link redirects outside Shopee, so it can't be used.");
    }
    current = next;
    hops.push(current.toString());
  }
  return { finalUrl: current, hops };
}
