import { beforeEach, describe, expect, it } from "vitest";

import { app } from "../src/app";
import { db } from "../src/db/client";
import { affiliateLinks, products } from "../src/db/schema";
import { createUser, resetDb } from "./helpers";

const ORIGIN = { origin: "http://localhost:8081", "content-type": "application/json" };

async function signUp() {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: ORIGIN,
    body: JSON.stringify({ email: "owner@test.local", password: "correct-horse-battery", name: "Owner" }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  return { res, cookie };
}

describe("HTTP security", () => {
  beforeEach(resetDb);

  it("rejects unauthenticated access to every private area", async () => {
    for (const path of [
      "/api/stories",
      "/api/products",
      "/api/settings",
      "/api/dashboard",
      "/api/accounts",
      "/api/publishing/publications",
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(401);
    }
  });

  it("closes sign-up after the owner account exists", async () => {
    const first = await signUp();
    expect(first.res.status).toBe(200);
    const second = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: ORIGIN,
      body: JSON.stringify({ email: "x@test.local", password: "correct-horse-battery", name: "X" }),
    });
    expect(second.status).toBeGreaterThanOrEqual(400);
  });

  it("never returns secrets from settings", async () => {
    const { cookie } = await signUp();
    const res = await app.request("/api/settings", { headers: { cookie } });
    const text = await res.text();
    expect(res.status).toBe(200);
    for (const secret of ["test-gemini", "test-omni", "threads-secret", "buffer-key", "cron-test-secret"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("never accepts the Buffer token in a URL", async () => {
    const { cookie } = await signUp();
    const res = await app.request("/api/accounts/buffer/channels?token=secret-token", { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it("validates request payloads", async () => {
    const { cookie } = await signUp();
    const res = await app.request("/api/stories", {
      method: "POST",
      headers: { ...ORIGIN, cookie },
      body: JSON.stringify({ mode: "nope" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
  });

  it("protects the cron endpoint", async () => {
    expect((await app.request("/api/cron/tick")).status).toBe(401);
    expect((await app.request("/api/cron/tick", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect(
      (await app.request("/api/cron/tick", { headers: { authorization: "Bearer cron-test-secret" } })).status,
    ).toBe(200);
  });
});

describe("tracked redirect", () => {
  beforeEach(resetDb);

  it("redirects to the stored URL unchanged and refuses unknown or unsafe links", async () => {
    const userId = await createUser();
    const [product] = await db
      .insert(products)
      .values({ userId, shopeeUrl: "https://shopee.co.id/x-i.1.2", name: "P" })
      .returning();
    if (!product) throw new Error("product seed failed");
    const destination = "https://s.shopee.co.id/Zz9?utm_source=an_1&mmp_pid=an_2";
    await db
      .insert(affiliateLinks)
      .values({ userId, productId: product.id, slug: "abcdef12", destinationUrl: destination });
    await db
      .insert(affiliateLinks)
      .values({ userId, productId: product.id, slug: "evil1234", destinationUrl: "https://evil.example/" });

    const ok = await app.request("/r/abcdef12", { headers: { "user-agent": "Mozilla/5.0" } });
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe(destination);
    expect((await app.request("/r/evil1234")).status).toBe(410);
    expect((await app.request("/r/nope")).status).toBe(404);
    expect((await app.request("/r/https:%2F%2Fevil.com")).status).toBe(404);
  });
});
