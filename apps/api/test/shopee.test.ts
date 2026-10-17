import { describe, expect, it } from "vitest";

import { extractProduct } from "../src/products/extract";
import { validateDestination } from "../src/products/service";
import { signRequest } from "../src/products/shopee-affiliate-api";
import { extractProductIds, isShopeeHost, parseShopeeUrl, resolveShopeeUrl } from "../src/products/shopee-url";
import { routeFetch } from "./helpers";

// Mock-only: no request reaches Shopee.

describe("Shopee URL validation", () => {
  it("accepts Shopee product and short links", () => {
    expect(parseShopeeUrl("https://shopee.co.id/Produk-i.123.456").hostname).toBe("shopee.co.id");
    expect(isShopeeHost("s.shopee.co.id")).toBe(true);
    expect(isShopeeHost("shope.ee")).toBe(true);
  });
  it("rejects lookalike and non-Shopee hosts", () => {
    for (const url of [
      "https://shopee.co.id.evil.com/x",
      "https://evilshopee.co.id/x",
      "https://example.com",
      "ftp://shopee.co.id/x",
    ]) {
      expect(() => parseShopeeUrl(url)).toThrow();
    }
    expect(() => parseShopeeUrl("https://user:pass@shopee.co.id/x")).toThrow();
  });
  it("extracts shop and item ids", () => {
    expect(extractProductIds(new URL("https://shopee.co.id/Nama-Produk-i.111.222"))).toEqual({
      shopId: "111",
      itemId: "222",
    });
    expect(extractProductIds(new URL("https://shopee.co.id/product/333/444"))).toEqual({
      shopId: "333",
      itemId: "444",
    });
    expect(extractProductIds(new URL("https://shopee.co.id/some-shop"))).toBeNull();
  });
  it("follows short-link redirects but refuses to leave Shopee", async () => {
    const ok = routeFetch([
      [
        "s.shopee.co.id",
        () => new Response(null, { status: 302, headers: { location: "https://shopee.co.id/X-i.1.2" } }),
      ],
    ]);
    const resolved = await resolveShopeeUrl("https://s.shopee.co.id/abc", ok.impl);
    expect(resolved.finalUrl.toString()).toBe("https://shopee.co.id/X-i.1.2");

    const evil = routeFetch([
      [
        "s.shopee.co.id",
        () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }),
      ],
    ]);
    await expect(resolveShopeeUrl("https://s.shopee.co.id/abc", evil.impl)).rejects.toThrow(/outside Shopee/);
  });
});

describe("product extraction", () => {
  it("falls back to manual entry when Shopee serves no metadata, keeping the URL", async () => {
    const f = routeFetch([
      [
        "shopee.co.id",
        () =>
          new Response("<html><title>Shopee Indonesia</title></html>", { headers: { "content-type": "text/html" } }),
      ],
    ]);
    const result = await extractProduct("https://shopee.co.id/Produk-i.10.20", f.impl);
    expect(result).toMatchObject({
      status: "failed",
      dataSource: "manual",
      shopeeUrl: "https://shopee.co.id/Produk-i.10.20",
      shopId: "10",
      itemId: "20",
    });
    expect(result.message).toMatch(/manually/);
  });
  it("reads og: metadata when the page provides it", async () => {
    const html =
      '<meta property="og:title" content="Serum Vitamin C 20ml | Shopee Indonesia"><meta property="og:image" content="https://cf.shopee.co.id/x.jpg">';
    const f = routeFetch([
      ["shopee.co.id", () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })],
    ]);
    const result = await extractProduct("https://shopee.co.id/Serum-i.1.2", f.impl);
    expect(result).toMatchObject({ status: "partial", dataSource: "og_meta", name: "Serum Vitamin C 20ml" });
    expect(result.priceMin).toBeNull(); // never guessed
  });
  it("survives network failure", async () => {
    const f = routeFetch([
      [
        "shopee.co.id",
        () => {
          throw new Error("ECONNRESET");
        },
      ],
    ]);
    const result = await extractProduct("https://shopee.co.id/X-i.1.2", f.impl);
    expect(result.status).toBe("failed");
  });
});

describe("affiliate destinations", () => {
  it("preserves tracking parameters byte-for-byte", () => {
    const url = "https://s.shopee.co.id/AbC?utm_source=an_1&mmp_pid=an_2&sub_id=a%20b";
    expect(validateDestination(url)).toBe(url);
  });
  it("blocks open redirects", () => {
    for (const url of [
      "https://evil.com/?r=shopee.co.id",
      "javascript:alert(1)",
      "http://shopee.co.id/x",
      "https://shopee.co.id@evil.com/",
    ]) {
      expect(() => validateDestination(url)).toThrow();
    }
  });
  it("signs Shopee Affiliate API requests as sha256(appId+timestamp+payload+secret)", () => {
    const header = signRequest("app", "secret", '{"query":"q"}', 1700000000);
    expect(header).toMatch(/^SHA256 Credential=app, Timestamp=1700000000, Signature=[0-9a-f]{64}$/);
  });
});
