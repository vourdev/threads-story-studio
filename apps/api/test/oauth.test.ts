import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../src/db/client";
import { connectedAccounts, oauthStates } from "../src/db/schema";
import { refreshExpiringTokens } from "../src/jobs/tick";
import { completeThreadsOAuth, startThreadsOAuth } from "../src/publishing/accounts";
import { decryptSecret, encryptSecret, sha256 } from "../src/security/crypto";
import { createUser, json, resetDb, routeFetch } from "./helpers";

// Mock-only: Meta's OAuth endpoints are stubbed. A live connection still needs a real Threads app.

describe("Threads OAuth", () => {
  beforeEach(resetDb);

  it("builds an authorize URL with required scopes and a stored, hashed state", async () => {
    const userId = await createUser();
    const { authorizeUrl } = await startThreadsOAuth(userId);
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://threads.com/oauth/authorize");
    expect(url.searchParams.get("scope")).toBe("threads_basic,threads_content_publish");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/threads/oauth/callback");
    const state = url.searchParams.get("state") ?? "";
    const [row] = await db
      .select()
      .from(oauthStates)
      .where(eq(oauthStates.stateHash, sha256(state)));
    expect(row?.userId).toBe(userId);
    expect(JSON.stringify(row)).not.toContain(state); // only the hash is stored
  });

  it("exchanges the code for a long-lived token and stores it encrypted", async () => {
    const userId = await createUser();
    await db
      .insert(oauthStates)
      .values({ userId, provider: "threads", stateHash: sha256("st"), expiresAt: new Date(Date.now() + 60_000) });
    const api = routeFetch([
      ["graph.threads.com/oauth/access_token", () => json({ access_token: "short-token", user_id: 4242 })],
      [
        "graph.threads.net/access_token",
        () => json({ access_token: "long-token", token_type: "bearer", expires_in: 5_184_000 }),
      ],
      ["/me?", () => json({ id: "4242", username: "storyteller", name: "Story Teller" })],
    ]);
    await completeThreadsOAuth("st", "the-code#_", api.impl);

    const exchange = api.calls.find((c) => c.url.includes("oauth/access_token"));
    expect(String(exchange?.init?.body)).toContain("code=the-code&");
    expect(String(exchange?.init?.body)).toContain("grant_type=authorization_code");
    expect(api.calls.find((c) => c.url.includes("graph.threads.net/access_token"))?.url).toContain(
      "grant_type=th_exchange_token",
    );

    const [account] = await db
      .select()
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, "threads")));
    expect(account).toMatchObject({ status: "connected", username: "storyteller", externalAccountId: "4242" });
    expect(account?.encryptedToken).not.toContain("long-token");
    expect(decryptSecret(account?.encryptedToken ?? "")).toBe("long-token");
    const days = ((account?.tokenExpiresAt?.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(59);
  });

  it("refuses a callback with an unknown state without calling Meta", async () => {
    const api = routeFetch([]);
    await expect(completeThreadsOAuth("forged", "code", api.impl)).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
  });

  it("refreshes tokens that expire within 7 days and are at least 24h old", async () => {
    const userId = await createUser();
    await db.insert(connectedAccounts).values({
      userId,
      provider: "threads",
      externalAccountId: "1",
      encryptedToken: encryptSecret("old-token"),
      tokenIssuedAt: new Date(Date.now() - 55 * 86_400_000),
      tokenExpiresAt: new Date(Date.now() + 3 * 86_400_000),
      status: "connected",
    });
    const api = routeFetch([
      ["refresh_access_token", () => json({ access_token: "fresh-token", expires_in: 5_184_000 })],
    ]);
    await refreshExpiringTokens(api.impl);
    expect(api.calls[0]?.url).toContain("grant_type=th_refresh_token");
    const [account] = await db.select().from(connectedAccounts).where(eq(connectedAccounts.userId, userId));
    expect(decryptSecret(account?.encryptedToken ?? "")).toBe("fresh-token");
  });
});
