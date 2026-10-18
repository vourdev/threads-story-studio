import type { PublishingProviderId } from "@tss/shared";
import { and, eq, gt, isNull } from "drizzle-orm";

import { db } from "../db/client";
import { connectedAccounts, oauthStates } from "../db/schema";
import { env } from "../env";
import { decryptSecret, encryptSecret, randomToken, sha256 } from "../security/crypto";
import { AppError } from "../security/errors";
import { listChannels, listOrganizations } from "./providers/buffer";
import { buildAuthorizeUrl, exchangeCode, fetchThreadsProfile, threadsScopes } from "./providers/threads";
import { allPublishingProviders, getPublishingProvider } from "./registry";
import { type AccountCredentials, PublishError } from "./types";

const STATE_TTL_MS = 10 * 60 * 1000;

export async function getAccountRow(userId: string, provider: PublishingProviderId) {
  const [row] = await db
    .select()
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, provider)));
  return row ?? null;
}

/** Credentials for a publish step. Secrets never leave the server. */
export async function getCredentials(userId: string, provider: PublishingProviderId): Promise<AccountCredentials> {
  const row = await getAccountRow(userId, provider);
  if (row?.status !== "connected") {
    throw new PublishError("auth", `${provider === "threads" ? "Threads" : "Buffer"} is not connected.`);
  }
  return {
    accountId: row.id,
    externalAccountId: row.externalAccountId,
    accessToken: row.encryptedToken ? decryptSecret(row.encryptedToken) : null,
    meta: row.meta,
  };
}

/** Public connection overview (no secrets). */
export async function connectionOverview(userId: string) {
  const rows = await db.select().from(connectedAccounts).where(eq(connectedAccounts.userId, userId));
  return allPublishingProviders().map((p) => {
    const row = rows.find((r) => r.provider === p.id);
    return {
      provider: p.id,
      label: p.label,
      serverConfigured: p.isConfigured(),
      capabilities: p.capabilities(),
      connected: row?.status === "connected",
      status: row?.status ?? "not_connected",
      statusMessage: row?.statusMessage ?? null,
      username: row?.username ?? null,
      displayName: row?.displayName ?? null,
      tokenExpiresAt: row?.tokenExpiresAt ?? null,
      meta: row?.meta ?? {},
      lastValidatedAt: row?.lastValidatedAt ?? null,
    };
  });
}

export async function markAccountStatus(
  userId: string,
  provider: PublishingProviderId,
  status: "connected" | "expired" | "revoked" | "error",
  message: string | null,
) {
  await db
    .update(connectedAccounts)
    .set({ status, statusMessage: message })
    .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, provider)));
}

// ---------------------------------------------------------------- Threads OAuth

export async function startThreadsOAuth(userId: string) {
  if (!getPublishingProvider("threads").isConfigured()) {
    throw new AppError(
      "not_configured",
      "Threads app credentials (THREADS_APP_ID / THREADS_APP_SECRET) are not set on the server.",
    );
  }
  const state = randomToken(32);
  await db.insert(oauthStates).values({
    userId,
    provider: "threads",
    stateHash: sha256(state),
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });
  return { authorizeUrl: buildAuthorizeUrl(state), returnUrl: `${env.APP_SCHEME}://integrations/threads` };
}

/** Validates and consumes an OAuth state (single use, unexpired). Returns the owning user id. */
export async function consumeOAuthState(state: string, provider: string): Promise<string> {
  if (!state || state.length > 200) throw new AppError("bad_request", "Missing OAuth state");
  const [row] = await db
    .update(oauthStates)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(oauthStates.stateHash, sha256(state)),
        eq(oauthStates.provider, provider),
        isNull(oauthStates.usedAt),
        gt(oauthStates.expiresAt, new Date()),
      ),
    )
    .returning({ userId: oauthStates.userId });
  if (!row)
    throw new AppError("bad_request", "This connection link expired or was already used. Start again from the app.");
  return row.userId;
}

export async function completeThreadsOAuth(state: string, code: string, fetchImpl: typeof fetch = fetch) {
  const userId = await consumeOAuthState(state, "threads");
  const token = await exchangeCode(code, fetchImpl);
  const profile = await fetchThreadsProfile(token.accessToken, fetchImpl);
  const now = new Date();
  const values = {
    userId,
    provider: "threads" as const,
    externalAccountId: profile.id ?? token.userId,
    username: profile.username ?? null,
    displayName: profile.name ?? null,
    scopes: threadsScopes(),
    encryptedToken: encryptSecret(token.accessToken),
    tokenIssuedAt: now,
    tokenExpiresAt: new Date(now.getTime() + token.expiresIn * 1000),
    status: "connected" as const,
    statusMessage: null,
    lastValidatedAt: now,
  };
  await db
    .insert(connectedAccounts)
    .values(values)
    .onConflictDoUpdate({ target: [connectedAccounts.userId, connectedAccounts.provider], set: values });
  return { userId, username: profile.username ?? null };
}

// ---------------------------------------------------------------- Buffer

export async function bufferChannels(userId?: string, explicitToken?: string) {
  let token = explicitToken?.trim();
  if (!token && userId) {
    const row = await getAccountRow(userId, "buffer");
    if (row?.encryptedToken) {
      try {
        token = decryptSecret(row.encryptedToken);
      } catch {
        // fallback
      }
    }
  }
  if (!token) token = env.BUFFER_API_KEY;
  if (!token) {
    throw new AppError("not_configured", "Masukkan Buffer API Token untuk melihat channel.");
  }
  const orgs = await listOrganizations(token);
  const result = [];
  for (const org of orgs) {
    const channels = await listChannels(org.id, token);
    result.push({ organization: org, channels: channels.filter((c) => c.service.toLowerCase() === "threads") });
  }
  return result;
}

export async function connectBuffer(userId: string, organizationId: string, channelId: string, explicitToken?: string) {
  let token = explicitToken?.trim();
  const existingRow = await getAccountRow(userId, "buffer");
  if (!token && existingRow?.encryptedToken) {
    try {
      token = decryptSecret(existingRow.encryptedToken);
    } catch {
      // fallback
    }
  }
  if (!token) token = env.BUFFER_API_KEY;
  if (!token) {
    throw new AppError("not_configured", "Buffer API Token belum diatur.");
  }

  const channels = await listChannels(organizationId, token);
  const channel = channels.find((c) => c.id === channelId);
  if (!channel) throw new AppError("bad_request", "That Buffer channel was not found in the organization.");
  if (channel.service.toLowerCase() !== "threads") throw new AppError("bad_request", "Pick a Threads channel.");
  const values = {
    userId,
    provider: "buffer" as const,
    externalAccountId: channel.id,
    username: channel.name,
    displayName: channel.displayName ?? channel.name,
    encryptedToken: token ? encryptSecret(token) : null,
    meta: { organizationId, channelId },
    status: "connected" as const,
    statusMessage: channel.isQueuePaused ? "Buffer queue is paused for this channel." : null,
    lastValidatedAt: new Date(),
  };
  await db
    .insert(connectedAccounts)
    .values(values)
    .onConflictDoUpdate({ target: [connectedAccounts.userId, connectedAccounts.provider], set: values });
}

export async function validateConnection(userId: string, provider: PublishingProviderId) {
  try {
    const creds = await getCredentials(userId, provider);
    if (provider === "threads") {
      if (!creds.accessToken) throw new PublishError("auth", "No token");
      await fetchThreadsProfile(creds.accessToken);
    } else {
      const token = creds.accessToken ?? env.BUFFER_API_KEY;
      const channels = await listChannels(creds.meta.organizationId ?? "", token);
      if (!channels.some((c) => c.id === creds.meta.channelId))
        throw new PublishError("auth", "Buffer channel no longer available.");
    }
    await db
      .update(connectedAccounts)
      .set({ status: "connected", statusMessage: null, lastValidatedAt: new Date() })
      .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, provider)));
    return { ok: true as const };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Validation failed";
    if (err instanceof PublishError && err.kind === "auth")
      await markAccountStatus(userId, provider, "expired", message);
    return { ok: false as const, message };
  }
}

export async function disconnect(userId: string, provider: PublishingProviderId) {
  await db
    .delete(connectedAccounts)
    .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, provider)));
}
