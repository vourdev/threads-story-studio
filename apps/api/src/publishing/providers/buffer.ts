import type { ProviderCapabilities } from "@tss/shared";

import { env, integrations } from "../../env";
import {
  type AccountCredentials,
  type PublishContext,
  PublishError,
  type PublishingProvider,
  type StepResult,
  type SyncResult,
} from "../types";

export const BUFFER_API = "https://api.buffer.com";

type GraphQLBody<T> = { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };

/**
 * Buffer GraphQL API (personal API key, Bearer auth).
 * Verified from developers.buffer.com examples: organizations, channels, createPost
 * (schedulingType=automatic), threads via metadata.<service>.thread, posts query with status filter.
 * Posts are shared immediately with mode `shareNow` — described in Buffer's docs prose ("share now"),
 * but no literal example is published, so treat the enum value as inferred.
 */
export async function bufferGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  apiKey = env.BUFFER_API_KEY,
): Promise<T> {
  if (!apiKey) throw new PublishError("not_configured", "Buffer API key is not configured on the server.");
  let response: Response;
  try {
    response = await fetchImpl(BUFFER_API, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new PublishError("unknown", "No response from Buffer (network error or timeout).", { cause: err });
  }
  const json = (await response.json().catch(() => ({}))) as GraphQLBody<T>;
  if (response.status === 401 || response.status === 403) {
    throw new PublishError("auth", "Buffer rejected the API key. Check BUFFER_API_KEY.", {
      httpStatus: response.status,
    });
  }
  if (response.status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    throw new PublishError("rate_limited", "Buffer rate limit reached.", {
      httpStatus: 429,
      retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 15 * 60_000,
    });
  }
  if (response.status >= 500)
    throw new PublishError("transient", `Buffer HTTP ${response.status}`, { httpStatus: response.status });
  if (json.errors?.length || !json.data) {
    const message = json.errors?.[0]?.message ?? `Buffer HTTP ${response.status}`;
    throw new PublishError("permanent", `Buffer error: ${message.slice(0, 300)}`, {
      httpStatus: response.status,
      providerCode: json.errors?.[0]?.extensions?.code,
    });
  }
  return json.data;
}

/** GraphQL enum literal (rendered without quotes). */
export class GqlEnum {
  constructor(readonly value: string) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error("Invalid enum literal");
  }
}

/**
 * Serializes a value as an inline GraphQL literal. Buffer's documented examples use inline
 * literals, which avoids depending on undocumented input type names for variables.
 * Strings use JSON escaping, which is valid GraphQL string syntax.
 */
export function gql(value: unknown): string {
  if (value instanceof GqlEnum) return value.value;
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(gql).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error("Invalid field name");
        return `${k}: ${gql(v)}`;
      })
      .join(", ")}}`;
  }
  throw new Error("Unsupported GraphQL value");
}

export async function listOrganizations(fetchImpl?: typeof fetch) {
  const data = await bufferGraphQL<{ account: { organizations: { id: string; name: string }[] } }>(
    "query { account { organizations { id name } } }",
    {},
    fetchImpl,
  );
  return data.account.organizations;
}

export async function listChannels(organizationId: string, fetchImpl?: typeof fetch) {
  const data = await bufferGraphQL<{
    channels: {
      id: string;
      name: string;
      displayName?: string;
      service: string;
      avatar?: string;
      isQueuePaused?: boolean;
    }[];
  }>(
    `query { channels(input: ${gql({ organizationId })}) { id name displayName service avatar isQueuePaused } }`,
    {},
    fetchImpl,
  );
  return data.channels;
}

type CreatePostData = {
  createPost:
    | { __typename?: "PostActionSuccess"; post?: { id: string; status?: string } }
    | { __typename?: "MutationError"; message?: string };
};

export class BufferProvider implements PublishingProvider {
  readonly id = "buffer" as const;
  readonly label = "Buffer";

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  capabilities(): ProviderCapabilities {
    return {
      thread: true,
      statusSync: true,
      metrics: false,
      // Buffer only confirms acceptance; "sent" status is reported by Buffer, not by Threads.
      confirmsPublication: false,
    };
  }

  isConfigured() {
    return integrations.buffer();
  }

  initialStep() {
    return "submit";
  }

  async runStep(ctx: PublishContext): Promise<StepResult> {
    if (ctx.step !== "submit") throw new PublishError("permanent", `Unknown Buffer step: ${ctx.step}`);
    const channelId = ctx.account.meta.channelId;
    const organizationId = ctx.account.meta.organizationId;
    if (!channelId || !organizationId) {
      throw new PublishError("auth", "Choose a Buffer Threads channel in Settings › Publishing.");
    }

    if (ctx.reconcile) {
      // A previous submit may have succeeded without us seeing the response — look for it first.
      const existing = await this.findRecentPost(organizationId, channelId, ctx.posts[0]?.text ?? "");
      if (existing) {
        return { type: "done", status: "submitted", externalPostIds: [existing.id] };
      }
    }

    const text = ctx.posts[0]?.text ?? "";
    const isThread = ctx.posts.length > 1;
    const input: Record<string, unknown> = {
      text,
      channelId,
      schedulingType: new GqlEnum("automatic"),
      mode: new GqlEnum("shareNow"),
      ...(isThread ? { metadata: { threads: { thread: ctx.posts.map((p) => ({ text: p.text })) } } } : {}),
    };

    const data = await bufferGraphQL<CreatePostData>(
      `mutation {
        createPost(input: ${gql(input)}) {
          __typename
          ... on PostActionSuccess { post { id status } }
          ... on MutationError { message }
        }
      }`,
      {},
      this.fetchImpl,
    );
    const result = data.createPost;
    if (!("post" in result) || !result.post) {
      const message = "message" in result ? result.message : undefined;
      throw new PublishError("permanent", `Buffer did not accept the post: ${message ?? "unknown error"}`);
    }
    return {
      type: "done",
      status: "submitted",
      externalPostIds: [result.post.id],
      meta: { bufferStatus: result.post.status ?? null },
    };
  }

  private async findRecentPost(organizationId: string, channelId: string, text: string) {
    const data = await bufferGraphQL<{ posts: { edges: { node: { id: string; text: string; status?: string } }[] } }>(
      `query {
        posts(first: 20, input: ${gql({ organizationId, filter: { channelIds: [channelId] }, sort: [{ field: new GqlEnum("createdAt"), direction: new GqlEnum("desc") }] })}) { edges { node { id text status } } }
      }`,
      {},
      this.fetchImpl,
    );
    return data.posts.edges.map((e) => e.node).find((n) => n.text.trim() === text.trim()) ?? null;
  }

  async syncStatus(ctx: { account: AccountCredentials; externalPostIds: string[] }): Promise<SyncResult> {
    const organizationId = ctx.account.meta.organizationId;
    const channelId = ctx.account.meta.channelId;
    const postId = ctx.externalPostIds[0];
    if (!organizationId || !channelId || !postId) return { status: "failed", message: "Missing Buffer post reference" };
    const data = await bufferGraphQL<{ posts: { edges: { node: { id: string; status?: string } }[] } }>(
      `query {
        posts(first: 50, input: ${gql({ organizationId, filter: { channelIds: [channelId] }, sort: [{ field: new GqlEnum("dueAt"), direction: new GqlEnum("desc") }] })}) { edges { node { id status } } }
      }`,
      {},
      this.fetchImpl,
    );
    const node = data.posts.edges.map((e) => e.node).find((n) => n.id === postId);
    const status = node?.status?.toLowerCase();
    if (status === "sent") return { status: "published", meta: { reportedBy: "buffer" } };
    if (status === "error") return { status: "failed", message: "Buffer reported an error while sending this post." };
    return { status: "pending", meta: { bufferStatus: node?.status ?? "not_found" } };
  }
}
