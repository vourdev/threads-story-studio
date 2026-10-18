import {
  ACTIVE_PUBLICATION_STATUSES,
  composeForPublishing,
  isWithinThreadsLimit,
  type PublicationStatus,
  type PublishInput,
  type StoryStatus,
} from "@tss/shared";
import { and, asc, desc, eq, gte, inArray, lte, type SQL } from "drizzle-orm";

import { db, type Tx } from "../db/client";
import { affiliateLinks, publications, publishingAttempts, publishingJobs, stories } from "../db/schema";
import { env } from "../env";
import { AppError, notFound } from "../security/errors";
import { getOwnedStory } from "../stories/service";
import { getAccountRow } from "./accounts";
import { getPublishingProvider } from "./registry";

/** Transient failures are retried this many times (with backoff) before a publication is marked failed. */
export const MAX_PUBLISH_ATTEMPTS = 3;

/** Story status mirrors its most relevant publication: published wins, then in-flight, then the latest failure. */
export async function syncStoryStatus(storyId: string, tx: Pick<Tx, "select" | "update"> = db) {
  const rows = await tx
    .select({ status: publications.status })
    .from(publications)
    .where(eq(publications.storyId, storyId))
    .orderBy(desc(publications.createdAt))
    .limit(20);
  let status: StoryStatus = "draft";
  if (rows.some((r) => r.status === "published")) status = "published";
  else if (rows.some((r) => r.status === "publishing")) status = "publishing";
  else if (rows.some((r) => r.status === "submitted")) status = "submitted";
  else if (rows[0]?.status === "failed") status = "failed";
  await tx.update(stories).set({ status }).where(eq(stories.id, storyId));
}

/** Public link for a story: the tracked redirect when the API is publicly reachable, else the raw affiliate URL. */
export async function storyLink(story: { affiliateLinkId: string | null }): Promise<string | null> {
  if (!story.affiliateLinkId) return null;
  const [link] = await db.select().from(affiliateLinks).where(eq(affiliateLinks.id, story.affiliateLinkId));
  if (!link || link.archivedAt) return null;
  return env.API_BASE_URL.startsWith("https://") ? `${env.API_BASE_URL}/r/${link.slug}` : link.destinationUrl;
}

/** Exactly what will be sent to the provider (posts + CTA + link). */
export async function composeStoryForPublishing(story: typeof stories.$inferSelect) {
  const link = story.mode === "affiliate" ? await storyLink(story) : null;
  return composeForPublishing(story.posts, story.mode === "affiliate" ? story.cta : null, link);
}

function assertPublishable(posts: { text: string }[]) {
  if (posts.length === 0) throw new AppError("bad_request", "The story has no content yet.");
  const tooLong = posts.findIndex((p) => !isWithinThreadsLimit(p.text));
  if (tooLong >= 0) throw new AppError("bad_request", `Post ${tooLong + 1} is longer than Threads allows (500).`);
  if (posts.some((p) => !p.text.trim())) throw new AppError("bad_request", "Remove empty posts before publishing.");
}

/**
 * Publishes the story's current version immediately. A duplicate request (double tap, retry,
 * same Idempotency-Key) returns the existing in-flight publication instead of posting twice.
 * The caller drives the returned publication to completion (see jobs/drive.ts).
 */
export async function requestPublish(userId: string, storyId: string, input: PublishInput, idempotencyKey?: string) {
  const provider = getPublishingProvider(input.provider);
  if (!provider.isConfigured())
    throw new AppError("not_configured", `${provider.label} is not configured on the server.`);
  const account = await getAccountRow(userId, input.provider);
  if (account?.status !== "connected") {
    throw new AppError("not_configured", `Connect ${provider.label} in Settings before publishing.`);
  }

  const clientKey = idempotencyKey ? `client:${userId}:${idempotencyKey}` : null;
  if (clientKey) {
    const [existing] = await db
      .select()
      .from(publications)
      .where(and(eq(publications.idempotencyKey, clientKey), eq(publications.userId, userId)));
    if (existing) return { publication: existing, duplicate: true };
  }

  return db.transaction(async (tx) => {
    const story = await getOwnedStory(userId, storyId, tx);
    if (story.mode === "affiliate" && !story.affiliateLinkId) {
      throw new AppError("bad_request", "Attach an affiliate link to this story before publishing.");
    }
    const finalPosts = await composeStoryForPublishing(story);
    assertPublishable(finalPosts);
    if (finalPosts.length > 1 && !provider.capabilities().thread) {
      throw new AppError("unsupported", `${provider.label} can't publish multi-post threads.`);
    }

    const activeFilter = and(
      eq(publications.storyId, storyId),
      eq(publications.storyVersionNo, story.currentVersionNo),
      eq(publications.provider, input.provider),
      inArray(publications.status, [...ACTIVE_PUBLICATION_STATUSES]),
    );
    const [active] = await tx.select().from(publications).where(activeFilter);
    if (active) return { publication: active, duplicate: true };

    const isScheduled = Boolean(input.scheduledFor && new Date(input.scheduledFor).getTime() > Date.now());
    const scheduledDate = isScheduled ? new Date(input.scheduledFor!) : null;

    const [publication] = await tx
      .insert(publications)
      .values({
        userId,
        storyId,
        storyVersionNo: story.currentVersionNo,
        postsSnapshot: finalPosts,
        provider: input.provider,
        status: isScheduled ? "scheduled" : "publishing",
        scheduledFor: scheduledDate,
        idempotencyKey: clientKey ?? crypto.randomUUID(),
      })
      .onConflictDoNothing()
      .returning();
    if (!publication) {
      // Lost a race with an identical request: return the publication that won.
      const [winner] = await tx.select().from(publications).where(activeFilter);
      if (!winner) throw new AppError("conflict", "This story is already being published.");
      return { publication: winner, duplicate: true };
    }

    await tx.insert(publishingJobs).values({
      userId,
      publicationId: publication.id,
      kind: "publish",
      step: provider.initialStep(),
      status: isScheduled ? "waiting" : "pending",
      runAt: scheduledDate ?? new Date(),
      maxAttempts: MAX_PUBLISH_ATTEMPTS,
    });
    await syncStoryStatus(storyId, tx);
    return { publication, duplicate: false };
  });
}

export async function cancelPublication(userId: string, publicationId: string) {
  const publication = await getOwnedPublication(userId, publicationId);
  if (publication.status !== "scheduled") {
    throw new AppError("bad_request", "Only scheduled publications can be cancelled.");
  }
  await db.delete(publishingJobs).where(eq(publishingJobs.publicationId, publicationId));
  await db
    .update(publications)
    .set({ status: "failed", lastErrorMessage: "Cancelled by user" })
    .where(eq(publications.id, publicationId));
  await syncStoryStatus(publication.storyId);
  return { ok: true };
}

export async function getOwnedPublication(userId: string, publicationId: string) {
  const [row] = await db
    .select()
    .from(publications)
    .where(and(eq(publications.id, publicationId), eq(publications.userId, userId)));
  if (!row) throw notFound("Publication");
  return row;
}

/**
 * Manual retry of a failed publication. Continues from saved progress (already-published posts of a
 * thread are never re-sent) and reconciles the last step first in case it actually went through.
 */
export async function retryPublication(userId: string, publicationId: string) {
  const pub = await getOwnedPublication(userId, publicationId);
  if (pub.status !== "failed") throw new AppError("conflict", "Only failed publications can be retried.");
  const account = await getAccountRow(userId, pub.provider);
  if (account?.status !== "connected") {
    throw new AppError("not_configured", "Reconnect the publishing account before retrying.");
  }
  const [lastJob] = await db
    .select()
    .from(publishingJobs)
    .where(and(eq(publishingJobs.publicationId, pub.id), eq(publishingJobs.kind, "publish")))
    .orderBy(desc(publishingJobs.createdAt))
    .limit(1);
  const provider = getPublishingProvider(pub.provider);
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(publications)
      .set({ status: "publishing", lastErrorCode: null, lastErrorMessage: null })
      .where(and(eq(publications.id, pub.id), eq(publications.status, "failed")))
      .returning();
    if (!updated) throw new AppError("conflict", "Publication state changed. Refresh and try again.");
    await tx.insert(publishingJobs).values({
      userId,
      publicationId: pub.id,
      kind: "publish",
      step: lastJob?.step ?? provider.initialStep(),
      stepState: { ...(lastJob?.stepState ?? {}), __reconcile: true },
      maxAttempts: MAX_PUBLISH_ATTEMPTS,
    });
    await syncStoryStatus(pub.storyId, tx);
  });
}

export type PublicationFilters = { status?: PublicationStatus; from?: Date; to?: Date; limit?: number };

export async function listPublications(userId: string, filters: PublicationFilters) {
  const where: SQL[] = [eq(publications.userId, userId)];
  if (filters.status) where.push(eq(publications.status, filters.status));
  if (filters.from) where.push(gte(publications.createdAt, filters.from));
  if (filters.to) where.push(lte(publications.createdAt, filters.to));
  return db
    .select({
      id: publications.id,
      storyId: publications.storyId,
      storyTitle: stories.title,
      provider: publications.provider,
      status: publications.status,
      permalink: publications.permalink,
      preview: publications.postsSnapshot,
      lastErrorMessage: publications.lastErrorMessage,
      attempts: publications.attempts,
      submittedAt: publications.submittedAt,
      publishedAt: publications.publishedAt,
      createdAt: publications.createdAt,
      providerMeta: publications.providerMeta,
    })
    .from(publications)
    .innerJoin(stories, eq(stories.id, publications.storyId))
    .where(and(...where))
    .orderBy(desc(publications.createdAt))
    .limit(filters.limit ?? 100);
}

export async function getPublicationDetail(userId: string, publicationId: string) {
  const pub = await getOwnedPublication(userId, publicationId);
  const [attempts, jobs] = await Promise.all([
    db
      .select()
      .from(publishingAttempts)
      .where(eq(publishingAttempts.publicationId, pub.id))
      .orderBy(desc(publishingAttempts.createdAt))
      .limit(50),
    db
      .select()
      .from(publishingJobs)
      .where(eq(publishingJobs.publicationId, pub.id))
      .orderBy(asc(publishingJobs.createdAt)),
  ]);
  return {
    publication: pub,
    attempts,
    jobs: jobs.map(({ stepState: _s, lockToken: _l, ...j }) => j),
    capabilities: getPublishingProvider(pub.provider).capabilities(),
  };
}
