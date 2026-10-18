import { isWithinThreadsLimit, type ProviderCapabilities } from "@tss/shared";

import { env, integrations, threadsRedirectUri } from "../../env";
import { type PublishContext, PublishError, type PublishingProvider, type StepResult } from "../types";

export const THREADS_GRAPH = "https://graph.threads.net/v1.0";

/** Official Graph API, unless a local mock is configured outside production (E2E testing). */
export function graphBase(): string {
  if (env.NODE_ENV !== "production" && env.THREADS_GRAPH_BASE_URL)
    return env.THREADS_GRAPH_BASE_URL.replace(/\/+$/, "");
  return THREADS_GRAPH;
}
/**
 * Text containers are usually ready within seconds; Meta suggests ~30s on average (media takes longer).
 * Check soon, then back off — publishing only happens once the container reports FINISHED.
 */
const STATUS_CHECK_DELAYS_MS = [4_000, 8_000, 15_000, 30_000, 30_000, 60_000, 60_000, 60_000];
const REPLY_GAP_MS = 5_000;

type ThreadsErrorBody = { error?: { message?: string; code?: number; error_subcode?: number; type?: string } };

function classify(status: number, body: ThreadsErrorBody, retryAfter: string | null): PublishError {
  const code = body.error?.code;
  const message = body.error?.message?.slice(0, 300) ?? `Threads API HTTP ${status}`;
  const providerCode = code !== undefined ? String(code) : undefined;
  if (code === 190 || status === 401) {
    return new PublishError("auth", "Threads access expired or was revoked. Reconnect your Threads account.", {
      httpStatus: status,
      providerCode,
    });
  }
  if (status === 429 || code === 4 || code === 17 || code === 32 || code === 613) {
    const seconds = Number(retryAfter);
    return new PublishError("rate_limited", message, {
      httpStatus: status,
      providerCode,
      retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 15 * 60_000,
    });
  }
  if (status >= 500 || code === 1 || code === 2)
    return new PublishError("transient", message, { httpStatus: status, providerCode });
  if (code === 10 || code === 200 || status === 403) {
    return new PublishError("permanent", `Threads permission error: ${message}`, { httpStatus: status, providerCode });
  }
  return new PublishError("permanent", message, { httpStatus: status, providerCode });
}

export type ThreadsFetch = typeof fetch;

/** Thin Threads Graph API client. Tokens are passed per call and never logged. */
export async function threadsRequest<T>(
  method: "GET" | "POST",
  path: string,
  params: Record<string, string>,
  accessToken: string,
  fetchImpl: ThreadsFetch = fetch,
  base = graphBase(),
): Promise<T> {
  const url = new URL(`${base}${path}`);
  const body = new URLSearchParams({ ...params, access_token: accessToken });
  let response: Response;
  try {
    response =
      method === "GET"
        ? await fetchImpl(`${url}?${body}`, { signal: AbortSignal.timeout(20_000) })
        : await fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body,
            signal: AbortSignal.timeout(20_000),
          });
  } catch (err) {
    // The request may have reached Threads — outcome unknown, must be reconciled.
    throw new PublishError("unknown", "No response from Threads (network error or timeout).", { cause: err });
  }
  const json = (await response.json().catch(() => ({}))) as T & ThreadsErrorBody;
  if (!response.ok || json.error) throw classify(response.status, json, response.headers.get("retry-after"));
  return json;
}

type State = {
  containers: (string | null)[];
  published: string[];
  statusChecks: number;
};

function readState(raw: Record<string, unknown>, postCount: number): State {
  const containers = Array.isArray(raw.containers) ? (raw.containers as (string | null)[]) : [];
  return {
    containers: Array.from({ length: postCount }, (_, i) => containers[i] ?? null),
    published: Array.isArray(raw.published) ? (raw.published as string[]) : [],
    statusChecks: typeof raw.statusChecks === "number" ? raw.statusChecks : 0,
  };
}

export class ThreadsProvider implements PublishingProvider {
  readonly id = "threads" as const;
  readonly label = "Threads (direct)";

  constructor(private readonly fetchImpl: ThreadsFetch = fetch) {}

  capabilities(): ProviderCapabilities {
    return {
      thread: true,
      statusSync: false,
      metrics: Boolean(env.THREADS_REQUEST_INSIGHTS),
      confirmsPublication: true,
    };
  }

  isConfigured() {
    return integrations.threads();
  }

  initialStep() {
    return "create_container";
  }

  async runStep(ctx: PublishContext): Promise<StepResult> {
    const token = ctx.account.accessToken;
    const userId = ctx.account.externalAccountId;
    if (!token || !userId) throw new PublishError("auth", "Threads account is not connected.");
    const state = readState(ctx.stepState, ctx.posts.length);
    const index = state.published.length;
    const save = (step: string, delayMs: number): StepResult => ({ type: "continue", step, stepState: state, delayMs });

    switch (ctx.step) {
      case "create_container": {
        const post = ctx.posts[index];
        if (!post) return save("fetch_permalink", 0);
        if (!isWithinThreadsLimit(post.text)) {
          throw new PublishError("permanent", `Post ${index + 1} exceeds the Threads 500-character limit.`);
        }
        // A container that was created but never published is harmless (expires after 24h),
        // so re-creating after an unknown outcome cannot produce a duplicate post.
        const params: Record<string, string> = { media_type: "TEXT", text: post.text };
        const replyTo = state.published[index - 1];
        if (index > 0 && replyTo) params.reply_to_id = replyTo;
        const created = await threadsRequest<{ id: string }>(
          "POST",
          `/${userId}/threads`,
          params,
          token,
          this.fetchImpl,
        );
        state.containers[index] = created.id;
        state.statusChecks = 0;
        return save("check_status", STATUS_CHECK_DELAYS_MS[0] ?? 4_000);
      }

      case "check_status": {
        const containerId = state.containers[index];
        if (!containerId) return save("create_container", 0);
        const status = await threadsRequest<{ status?: string; error_message?: string }>(
          "GET",
          `/${containerId}`,
          { fields: "status,error_message" },
          token,
          this.fetchImpl,
        );
        switch (status.status) {
          case "FINISHED":
            return save("publish", 0);
          case "PUBLISHED":
            // Published earlier but the response was lost: recover the media id instead of publishing again.
            return save("reconcile", 0);
          case "EXPIRED":
            state.containers[index] = null;
            return save("create_container", 0);
          case "ERROR":
            throw new PublishError(
              "permanent",
              `Threads rejected post ${index + 1}: ${status.error_message ?? "unknown error"}`,
            );
          default:
            state.statusChecks += 1;
            if (state.statusChecks >= STATUS_CHECK_DELAYS_MS.length) {
              throw new PublishError("transient", "Threads is still processing the post. Will retry.");
            }
            return save("check_status", STATUS_CHECK_DELAYS_MS[state.statusChecks] ?? 60_000);
        }
      }

      case "publish": {
        const containerId = state.containers[index];
        if (!containerId) return save("create_container", 0);
        if (ctx.reconcile) return save("check_status", 0);
        const published = await threadsRequest<{ id: string }>(
          "POST",
          `/${userId}/threads_publish`,
          { creation_id: containerId },
          token,
          this.fetchImpl,
        );
        state.published.push(published.id);
        return index + 1 < ctx.posts.length ? save("create_container", REPLY_GAP_MS) : save("fetch_permalink", 0);
      }

      case "reconcile": {
        const post = ctx.posts[index];
        const recent = await threadsRequest<{ data?: { id: string; text?: string }[] }>(
          "GET",
          index === 0 ? `/${userId}/threads` : `/${state.published[index - 1]}/replies`,
          { fields: "id,text", limit: "25" },
          token,
          this.fetchImpl,
        );
        const match = recent.data?.find((m) => m.text?.trim() === post?.text.trim());
        if (!match) {
          throw new PublishError(
            "permanent",
            "Threads reports the post as published but it could not be matched. Check your profile.",
          );
        }
        state.published.push(match.id);
        return index + 1 < ctx.posts.length ? save("create_container", REPLY_GAP_MS) : save("fetch_permalink", 0);
      }

      case "fetch_permalink": {
        const first = state.published[0];
        let permalink: string | null = null;
        if (first) {
          try {
            const media = await threadsRequest<{ permalink?: string }>(
              "GET",
              `/${first}`,
              { fields: "permalink" },
              token,
              this.fetchImpl,
            );
            permalink = media.permalink ?? null;
          } catch {
            permalink = null; // published regardless; the link is a nice-to-have
          }
        }
        return { type: "done", status: "published", externalPostIds: state.published, permalink };
      }

      default:
        throw new PublishError("permanent", `Unknown Threads publishing step: ${ctx.step}`);
    }
  }
}

// ---------------------------------------------------------------- OAuth helpers

export const THREADS_AUTHORIZE_URL = "https://threads.com/oauth/authorize";
export const THREADS_TOKEN_URL = "https://graph.threads.com/oauth/access_token";

export function threadsScopes(): string[] {
  return [
    "threads_basic",
    "threads_content_publish",
    ...(env.THREADS_REQUEST_INSIGHTS ? ["threads_manage_insights"] : []),
  ];
}

export function buildAuthorizeUrl(state: string): string {
  if (!env.THREADS_APP_ID) throw new PublishError("not_configured", "Threads app is not configured.");
  const url = new URL(THREADS_AUTHORIZE_URL);
  url.searchParams.set("client_id", env.THREADS_APP_ID);
  url.searchParams.set("redirect_uri", threadsRedirectUri());
  url.searchParams.set("scope", threadsScopes().join(","));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

async function tokenCall<T>(input: string | URL, init: RequestInit, fetchImpl: ThreadsFetch): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(input, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new PublishError("transient", "Could not reach Threads.", { cause: err });
  }
  const json = (await response.json().catch(() => ({}))) as T & ThreadsErrorBody;
  if (!response.ok || json.error) throw classify(response.status, json, null);
  return json;
}

/** Authorization code → short-lived token → long-lived (60 day) token. */
export async function exchangeCode(code: string, fetchImpl: ThreadsFetch = fetch) {
  if (!env.THREADS_APP_ID || !env.THREADS_APP_SECRET)
    throw new PublishError("not_configured", "Threads app is not configured.");
  const cleanCode = code.replace(/#_$/, "");
  const short = await tokenCall<{ access_token: string; user_id: string | number }>(
    THREADS_TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.THREADS_APP_ID,
        client_secret: env.THREADS_APP_SECRET,
        code: cleanCode,
        grant_type: "authorization_code",
        redirect_uri: threadsRedirectUri(),
      }),
    },
    fetchImpl,
  );
  const longUrl = new URL("https://graph.threads.net/access_token");
  longUrl.searchParams.set("grant_type", "th_exchange_token");
  longUrl.searchParams.set("client_secret", env.THREADS_APP_SECRET);
  longUrl.searchParams.set("access_token", short.access_token);
  const long = await tokenCall<{ access_token: string; expires_in: number }>(longUrl, { method: "GET" }, fetchImpl);
  return { accessToken: long.access_token, expiresIn: long.expires_in, userId: String(short.user_id) };
}

/** Refreshes a long-lived token (must be ≥24h old and unexpired). */
export async function refreshLongLivedToken(accessToken: string, fetchImpl: ThreadsFetch = fetch) {
  const url = new URL("https://graph.threads.net/refresh_access_token");
  url.searchParams.set("grant_type", "th_refresh_token");
  url.searchParams.set("access_token", accessToken);
  const res = await tokenCall<{ access_token: string; expires_in: number }>(url, { method: "GET" }, fetchImpl);
  return { accessToken: res.access_token, expiresIn: res.expires_in };
}

export async function fetchThreadsProfile(accessToken: string, fetchImpl: ThreadsFetch = fetch) {
  return threadsRequest<{ id: string; username?: string; name?: string }>(
    "GET",
    "/me",
    { fields: "id,username,name" },
    accessToken,
    fetchImpl,
  );
}

export async function fetchPublishingQuota(userId: string, accessToken: string, fetchImpl: ThreadsFetch = fetch) {
  return threadsRequest<{
    data?: { quota_usage?: number; config?: { quota_total?: number; quota_duration?: number } }[];
  }>("GET", `/${userId}/threads_publishing_limit`, { fields: "quota_usage,config" }, accessToken, fetchImpl);
}
