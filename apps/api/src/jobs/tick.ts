import { and, eq, lt, sql } from "drizzle-orm";

import { db } from "../db/client";
import { connectedAccounts } from "../db/schema";
import { checkPushReceipts } from "../notifications/expo-push";
import { notify } from "../notifications/notify";
import { refreshLongLivedToken } from "../publishing/providers/threads";
import { decryptSecret, encryptSecret } from "../security/crypto";
import { pruneRateLimits } from "../security/rate-limit";
import { errorSummary, log } from "../security/redact";
import { processDueJobs } from "./runner";

/** Refreshes Threads long-lived tokens that expire within 7 days (refresh requires the token to be ≥24h old). */
export async function refreshExpiringTokens(fetchImpl: typeof fetch = fetch) {
  const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const accounts = await db
    .select()
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.provider, "threads"),
        eq(connectedAccounts.status, "connected"),
        lt(connectedAccounts.tokenExpiresAt, soon),
        lt(connectedAccounts.tokenIssuedAt, dayAgo),
      ),
    )
    .limit(20);
  for (const account of accounts) {
    if (!account.encryptedToken) continue;
    if (account.tokenExpiresAt && account.tokenExpiresAt < new Date()) {
      await db
        .update(connectedAccounts)
        .set({ status: "expired", statusMessage: "Token expired. Reconnect Threads." })
        .where(eq(connectedAccounts.id, account.id));
      await notify(account.userId, "account.expired", {
        title: "Threads disconnected",
        body: "Reconnect Threads to keep publishing.",
        data: { screen: "settings/publishing" },
      });
      continue;
    }
    try {
      const refreshed = await refreshLongLivedToken(decryptSecret(account.encryptedToken), fetchImpl);
      const now = new Date();
      await db
        .update(connectedAccounts)
        .set({
          encryptedToken: encryptSecret(refreshed.accessToken),
          tokenIssuedAt: now,
          tokenExpiresAt: new Date(now.getTime() + refreshed.expiresIn * 1000),
          statusMessage: null,
        })
        .where(eq(connectedAccounts.id, account.id));
    } catch (err) {
      log.warn("threads token refresh failed", { accountId: account.id, err: errorSummary(err) });
      await db
        .update(connectedAccounts)
        .set({ statusMessage: "Token refresh failed; reconnect if publishing fails." })
        .where(eq(connectedAccounts.id, account.id));
    }
  }
}

/**
 * Daily server maintenance (Vercel Cron, Hobby-compatible): finishes any leftover publishing work,
 * refreshes Threads tokens, checks push receipts and prunes old data. Publishing itself never
 * waits for this — it runs immediately in the background of the publish request.
 */
export async function runTick(options: { budgetMs?: number } = {}) {
  const report: Record<string, unknown> = {};
  const safe = async (name: string, fn: () => Promise<unknown>) => {
    try {
      report[name] = await fn();
    } catch (err) {
      report[name] = { error: errorSummary(err) };
      log.error("tick task failed", { task: name, err: errorSummary(err) });
    }
  };
  await safe("jobs", () => processDueJobs({ budgetMs: options.budgetMs ?? 40_000 }));
  await safe("tokens", () => refreshExpiringTokens());
  await safe("pushReceipts", () => checkPushReceipts());
  await safe("rateLimits", () => pruneRateLimits());
  await safe("aiCache", () => db.execute(sql`delete from ai_cache where expires_at < now()`));
  return report;
}
