import { and, eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../src/db/client";
import { connectedAccounts, oauthStates, publications, publishingJobs, stories } from "../src/db/schema";
import { drive } from "../src/jobs/drive";
import { claimDueJobs, processJob } from "../src/jobs/runner";
import { consumeOAuthState } from "../src/publishing/accounts";
import { BufferProvider, GqlEnum, gql } from "../src/publishing/providers/buffer";
import { ThreadsProvider } from "../src/publishing/providers/threads";
import { setPublishingProvidersForTests } from "../src/publishing/registry";
import { requestPublish, retryPublication } from "../src/publishing/service";
import { encryptSecret, sha256 } from "../src/security/crypto";
import { createUser, json, resetDb, routeFetch } from "./helpers";

// Mock-only: Threads and Buffer HTTP is stubbed. This does NOT verify live publishing.

async function seed(posts = ["Post one", "Post two"]) {
  const userId = await createUser();
  const [story] = await db
    .insert(stories)
    .values({
      userId,
      mode: "general",
      title: "T",
      posts: posts.map((text, i) => ({ id: `p${i}`, text })),
      currentVersionNo: 1,
    })
    .returning();
  await db.insert(connectedAccounts).values({
    userId,
    provider: "threads",
    externalAccountId: "999",
    encryptedToken: encryptSecret("threads-token"),
    status: "connected",
  });
  await db.insert(connectedAccounts).values({
    userId,
    provider: "buffer",
    externalAccountId: "ch1",
    status: "connected",
    meta: { organizationId: "org1", channelId: "ch1" },
  });
  if (!story) throw new Error("seed failed");
  return { userId, storyId: story.id };
}

/** Test sleep: instead of waiting, makes every pending step due immediately. */
const fastForward = async () => {
  await db
    .update(publishingJobs)
    .set({ runAt: new Date(Date.now() - 1000) })
    .where(inArray(publishingJobs.status, ["pending", "waiting"]));
};

const driveAll = (publicationId: string) => drive({ publicationId }, { sleep: fastForward, budgetMs: 600_000 });

function threadsApi(overrides: { publish?: () => Response | Promise<Response>; status?: () => Response } = {}) {
  let container = 0;
  let media = 100;
  return routeFetch([
    [/\/999\/threads_publish/, () => (overrides.publish ? overrides.publish() : json({ id: String(media++) }))],
    [
      /\/999\/threads(\?|$)/,
      (_u, init) => (init?.method === "POST" ? json({ id: `c${container++}` }) : json({ data: [] })),
    ],
    [/\/c\d+\?/, () => (overrides.status ? overrides.status() : json({ status: "FINISHED" }))],
    [/\/\d+\?.*fields=permalink/, () => json({ permalink: "https://www.threads.com/@me/post/abc" })],
  ]);
}

async function getPub(id: string) {
  const [pub] = await db.select().from(publications).where(eq(publications.id, id));
  return pub;
}

describe("Threads direct publishing", () => {
  beforeEach(resetDb);

  it("publishes immediately as a reply chain and stores external ids", async () => {
    const { userId, storyId } = await seed();
    const api = threadsApi();
    setPublishingProvidersForTests({ threads: new ThreadsProvider(api.impl) });

    const { publication } = await requestPublish(userId, storyId, { provider: "threads" });
    expect(publication.status).toBe("publishing");
    const result = await driveAll(publication.id);
    expect(result.completed).toBe(true);

    expect(await getPub(publication.id)).toMatchObject({
      status: "published",
      externalPostIds: ["100", "101"],
      permalink: "https://www.threads.com/@me/post/abc",
    });
    const creates = api.calls.filter((c) => c.init?.method === "POST" && /\/999\/threads$/.test(c.url));
    expect(String(creates[0]?.init?.body)).not.toContain("reply_to_id");
    expect(String(creates[1]?.init?.body)).toContain("reply_to_id=100");
    const [story] = await db.select().from(stories).where(eq(stories.id, storyId));
    expect(story?.status).toBe("published");
  });

  it("is idempotent: a double tap returns the same publication", async () => {
    const { userId, storyId } = await seed();
    setPublishingProvidersForTests({ threads: new ThreadsProvider(threadsApi().impl) });
    const [a, b] = await Promise.all([
      requestPublish(userId, storyId, { provider: "threads" }),
      requestPublish(userId, storyId, { provider: "threads" }),
    ]);
    expect(a.publication.id).toBe(b.publication.id);
    expect(await db.select().from(publications)).toHaveLength(1);
  });

  it("honours the client idempotency key", async () => {
    const { userId, storyId } = await seed();
    setPublishingProvidersForTests({ threads: new ThreadsProvider(threadsApi().impl) });
    const first = await requestPublish(userId, storyId, { provider: "threads" }, "key-1");
    const second = await requestPublish(userId, storyId, { provider: "threads" }, "key-1");
    expect(second).toMatchObject({ duplicate: true, publication: { id: first.publication.id } });
  });

  it("never lets two drivers claim the same job", async () => {
    const { userId, storyId } = await seed(["only"]);
    setPublishingProvidersForTests({ threads: new ThreadsProvider(threadsApi().impl) });
    await requestPublish(userId, storyId, { provider: "threads" });
    const [a, b, c] = await Promise.all([claimDueJobs(5), claimDueJobs(5), claimDueJobs(5)]);
    expect(a.length + b.length + c.length).toBe(1);
  });

  it("concurrent drivers still publish exactly once", async () => {
    const { userId, storyId } = await seed(["once"]);
    const api = threadsApi();
    setPublishingProvidersForTests({ threads: new ThreadsProvider(api.impl) });
    const { publication } = await requestPublish(userId, storyId, { provider: "threads" });
    await Promise.all([
      driveAll(publication.id),
      driveAll(publication.id),
      drive({ userId }, { sleep: fastForward, budgetMs: 600_000 }),
    ]);
    expect(api.calls.filter((c) => c.url.includes("threads_publish"))).toHaveLength(1);
    expect((await getPub(publication.id))?.status).toBe("published");
  });

  it("reconciles an unknown publish outcome instead of publishing twice", async () => {
    const { userId, storyId } = await seed(["only post"]);
    let publishCalls = 0;
    let published = false;
    const api = routeFetch([
      [
        /threads_publish/,
        () => {
          publishCalls++;
          published = true;
          throw new Error("socket hang up"); // request reached Threads, response lost
        },
      ],
      [/\/999\/threads\?/, () => json({ data: [{ id: "555", text: "only post" }] })],
      [/\/999\/threads$/, () => json({ id: "c0" })],
      [/\/c0\?/, () => json({ status: published ? "PUBLISHED" : "FINISHED" })],
      [/\/555\?/, () => json({ permalink: "https://www.threads.com/@me/post/x" })],
    ]);
    setPublishingProvidersForTests({ threads: new ThreadsProvider(api.impl) });
    const { publication } = await requestPublish(userId, storyId, { provider: "threads" });
    await driveAll(publication.id);
    expect(publishCalls).toBe(1);
    expect(await getPub(publication.id)).toMatchObject({ status: "published", externalPostIds: ["555"] });
  });

  it("recovers a job whose worker died mid-step (lease expiry) via reconciliation", async () => {
    const { userId, storyId } = await seed(["one"]);
    setPublishingProvidersForTests({ threads: new ThreadsProvider(threadsApi().impl) });
    const { publication } = await requestPublish(userId, storyId, { provider: "threads" });
    await db
      .update(publishingJobs)
      .set({
        step: "publish",
        stepState: { containers: ["c0"], published: [] },
        status: "running",
        lockToken: "dead-worker",
        lockedUntil: new Date(Date.now() - 1000),
      })
      .where(eq(publishingJobs.publicationId, publication.id));
    const [job] = await claimDueJobs(5);
    expect(job?.stepState).toMatchObject({ __reconcile: true });
    if (job) await processJob(job);
  });

  it("fails permanently (no retries) when Threads rejects the container", async () => {
    const { userId, storyId } = await seed(["bad"]);
    const api = threadsApi({ status: () => json({ status: "ERROR", error_message: "Invalid text" }) });
    setPublishingProvidersForTests({ threads: new ThreadsProvider(api.impl) });
    const { publication } = await requestPublish(userId, storyId, { provider: "threads" });
    await driveAll(publication.id);
    const pub = await getPub(publication.id);
    expect(pub?.status).toBe("failed");
    expect(pub?.lastErrorMessage).toContain("Invalid text");
  });

  it("marks the account expired on an auth error", async () => {
    const { userId, storyId } = await seed(["x"]);
    const api = routeFetch([
      [/threads/, () => json({ error: { message: "Error validating access token", code: 190 } }, 400)],
    ]);
    setPublishingProvidersForTests({ threads: new ThreadsProvider(api.impl) });
    const { publication } = await requestPublish(userId, storyId, { provider: "threads" });
    await driveAll(publication.id);
    const [account] = await db
      .select()
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, "threads")));
    expect(account?.status).toBe("expired");
  });

  it("retries transient failures with a bound, then allows a manual retry", async () => {
    const { userId, storyId } = await seed(["x"]);
    let fail = true;
    const api = routeFetch([
      [
        /\/999\/threads$/,
        () => (fail ? json({ error: { message: "temporarily unavailable", code: 2 } }, 503) : json({ id: "c0" })),
      ],
      [/\/c0\?/, () => json({ status: "FINISHED" })],
      [/threads_publish/, () => json({ id: "777" })],
      [/\/777\?/, () => json({ permalink: null })],
    ]);
    setPublishingProvidersForTests({ threads: new ThreadsProvider(api.impl) });
    const { publication } = await requestPublish(userId, storyId, { provider: "threads" });
    await driveAll(publication.id);
    expect((await getPub(publication.id))?.status).toBe("failed");
    expect(api.calls.filter((c) => /\/999\/threads$/.test(c.url))).toHaveLength(3);

    fail = false;
    await retryPublication(userId, publication.id);
    await driveAll(publication.id);
    expect((await getPub(publication.id))?.status).toBe("published");
  });

  it("rejects posts over the Threads limit before contacting the provider", async () => {
    const { userId, storyId } = await seed(["😀".repeat(130)]); // 130 emoji × 4 bytes = 520
    await expect(requestPublish(userId, storyId, { provider: "threads" })).rejects.toThrow(/500/);
  });

  it("refuses to publish when the account is not connected", async () => {
    const { userId, storyId } = await seed();
    await db.delete(connectedAccounts).where(eq(connectedAccounts.userId, userId));
    await expect(requestPublish(userId, storyId, { provider: "threads" })).rejects.toMatchObject({
      code: "not_configured",
    });
  });

  it("stops at the time budget and leaves the job for the next trigger", async () => {
    const { userId, storyId } = await seed(["slow"]);
    const api = threadsApi({ status: () => json({ status: "IN_PROGRESS" }) });
    setPublishingProvidersForTests({ threads: new ThreadsProvider(api.impl) });
    const { publication } = await requestPublish(userId, storyId, { provider: "threads" });
    const result = await drive({ publicationId: publication.id }, { budgetMs: 1_000 });
    expect(result.completed).toBe(false);
    const [job] = await db.select().from(publishingJobs).where(eq(publishingJobs.publicationId, publication.id));
    expect(job?.status).toBe("waiting");
  });
});

describe("Buffer publishing", () => {
  beforeEach(resetDb);

  it("shares a thread immediately, reports 'submitted', then syncs to published", async () => {
    const { userId, storyId } = await seed();
    let status = "sending";
    const api = routeFetch([
      [
        "api.buffer.com",
        (_u, init) => {
          const body = String(init?.body);
          if (body.includes("createPost")) {
            return json({
              data: { createPost: { __typename: "PostActionSuccess", post: { id: "b1", status: "buffer" } } },
            });
          }
          return json({ data: { posts: { edges: [{ node: { id: "b1", status } }] } } });
        },
      ],
    ]);
    setPublishingProvidersForTests({ buffer: new BufferProvider(api.impl) });
    const { publication } = await requestPublish(userId, storyId, { provider: "buffer" });

    const [job] = await claimDueJobs(5, { publicationId: publication.id });
    if (job) await processJob(job);
    expect((await getPub(publication.id))?.status).toBe("submitted");
    const body = String(api.calls[0]?.init?.body);
    expect(body).toContain('threads: {thread: [{text: \\"Post one\\"}, {text: \\"Post two\\"}]}');
    expect(body).toContain("mode: shareNow");

    status = "sent";
    await driveAll(publication.id);
    expect((await getPub(publication.id))?.status).toBe("published");
  });

  it("maps MutationError to a failed publication", async () => {
    const { userId, storyId } = await seed(["x"]);
    const api = routeFetch([
      [
        "api.buffer.com",
        () => json({ data: { createPost: { __typename: "MutationError", message: "Channel disconnected" } } }),
      ],
    ]);
    setPublishingProvidersForTests({ buffer: new BufferProvider(api.impl) });
    const { publication } = await requestPublish(userId, storyId, { provider: "buffer" });
    await driveAll(publication.id);
    const pub = await getPub(publication.id);
    expect(pub).toMatchObject({ status: "failed" });
    expect(pub?.lastErrorMessage).toContain("Channel disconnected");
  });

  it("serializes GraphQL literals safely", () => {
    expect(gql({ text: 'he said "hi"\n', mode: new GqlEnum("shareNow") })).toBe(
      '{text: "he said \\"hi\\"\\n", mode: shareNow}',
    );
    expect(() => new GqlEnum("bad value")).toThrow();
  });
});

describe("OAuth state", () => {
  beforeEach(resetDb);

  it("is single-use and expires", async () => {
    const userId = await createUser();
    await db
      .insert(oauthStates)
      .values({ userId, provider: "threads", stateHash: sha256("good"), expiresAt: new Date(Date.now() + 60_000) });
    await db
      .insert(oauthStates)
      .values({ userId, provider: "threads", stateHash: sha256("old"), expiresAt: new Date(Date.now() - 1) });
    await expect(consumeOAuthState("good", "threads")).resolves.toBe(userId);
    await expect(consumeOAuthState("good", "threads")).rejects.toThrow(/expired or was already used/);
    await expect(consumeOAuthState("old", "threads")).rejects.toThrow();
    await expect(consumeOAuthState("forged", "threads")).rejects.toThrow();
  });
});

describe("Buffer with a per-user token", () => {
  beforeEach(resetDb);

  it("publishes with the user's own Buffer token instead of the server key", async () => {
    const { userId, storyId } = await seed(["solo"]);
    await db
      .update(connectedAccounts)
      .set({ encryptedToken: encryptSecret("user-buffer-token") })
      .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, "buffer")));
    const api = routeFetch([
      ["api.buffer.com", () => json({ data: { createPost: { __typename: "PostActionSuccess", post: { id: "b9" } } } })],
    ]);
    setPublishingProvidersForTests({ buffer: new BufferProvider(api.impl) });

    const { publication } = await requestPublish(userId, storyId, { provider: "buffer" });
    const [job] = await claimDueJobs(5, { publicationId: publication.id });
    if (job) await processJob(job);

    const headers = new Headers(api.calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer user-buffer-token");
    expect((await getPub(publication.id))?.status).toBe("submitted");
  });
});
