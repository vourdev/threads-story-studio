import { env, integrations } from "../env";
import { sha256 } from "../security/crypto";
import { AppError } from "../security/errors";

/**
 * Shopee Affiliate Open API (GraphQL).
 * Auth (per Shopee's Open API and a working community client):
 *   Authorization: SHA256 Credential={AppId}, Timestamp={unix}, Signature=sha256(AppId + Timestamp + Payload + Secret)
 * where Payload is the exact JSON request body.
 *
 * `generateShortLink` matches that client's working usage. `productOfferV2` field names come from
 * community documentation and are NOT verified here — any GraphQL error makes the caller fall back.
 */
export function signRequest(appId: string, secret: string, payload: string, timestamp: number): string {
  const signature = sha256(`${appId}${timestamp}${payload}${secret}`);
  return `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`;
}

type GraphQLResponse<T> = { data?: T; errors?: { message: string; extensions?: { code?: number | string } }[] };

async function call<T>(query: string, variables: Record<string, unknown>, fetchImpl: typeof fetch): Promise<T> {
  if (!integrations.shopeeAffiliate() || !env.SHOPEE_AFFILIATE_APP_ID || !env.SHOPEE_AFFILIATE_SECRET) {
    throw new AppError("not_configured", "Shopee Affiliate Open API is not configured.");
  }
  const payload = JSON.stringify({ query, variables });
  const timestamp = Math.floor(Date.now() / 1000);
  let response: Response;
  try {
    response = await fetchImpl(env.SHOPEE_AFFILIATE_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: signRequest(env.SHOPEE_AFFILIATE_APP_ID, env.SHOPEE_AFFILIATE_SECRET, payload, timestamp),
      },
      body: payload,
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    throw new AppError("provider_unavailable", "Shopee Affiliate API is unreachable.", { cause: err });
  }
  const body = (await response.json().catch(() => ({}))) as GraphQLResponse<T>;
  if (!response.ok || body.errors?.length || !body.data) {
    const message = body.errors?.[0]?.message ?? `HTTP ${response.status}`;
    throw new AppError("provider_error", `Shopee Affiliate API error: ${message.slice(0, 200)}`);
  }
  return body.data;
}

export type AffiliateProductOffer = {
  productName: string;
  priceMin?: string;
  priceMax?: string;
  imageUrl?: string;
  productLink?: string;
  offerLink?: string;
  shopName?: string;
};

export async function fetchProductOffer(
  ids: { shopId: string; itemId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<AffiliateProductOffer | null> {
  const data = await call<{ productOfferV2: { nodes: AffiliateProductOffer[] } }>(
    `query ($itemId: Int64, $shopId: Int64) {
      productOfferV2(itemId: $itemId, shopId: $shopId, limit: 1) {
        nodes { productName priceMin priceMax imageUrl productLink offerLink shopName }
      }
    }`,
    { itemId: ids.itemId, shopId: ids.shopId },
    fetchImpl,
  );
  return data.productOfferV2.nodes[0] ?? null;
}

export async function generateShortLink(
  originUrl: string,
  subIds: string[] = ["tss"],
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const data = await call<{ generateShortLink: { shortLink: string } }>(
    `mutation ($originUrl: String!, $subIds: [String]) {
      generateShortLink(input: { originUrl: $originUrl, subIds: $subIds }) { shortLink }
    }`,
    { originUrl, subIds },
    fetchImpl,
  );
  return data.generateShortLink.shortLink;
}
