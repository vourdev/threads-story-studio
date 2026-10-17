import { and, eq, sql } from "drizzle-orm";

import { track } from "../analytics/events";
import { db } from "../db/client";
import { publications, publishingAttempts, publishingJobs } from "../db/schema";
import { notify } from "../notifications/notify";
import { getCredentials, markAccountStatus } from "../publishing/accounts";
import { getPublishingProvider } from "../publishing/registry";
import { syncStoryStatus } from "../publishing/service";
import { type PublishContext, PublishError, type StepResult } from "../publishing/types";
import { errorSummary, log } from "../security/redact";

export type Job = typeof publishingJobs.$inferSelect;

const LEASE_SECONDS = 120;
/** Publishing is immediate, so transient failures retry quickly (within one background run when possible). */
const BACKOFF_MS = [15_000, 45_000, 120_000];
/** Buffer usually sends a "share now" post within a minute; check soon, then every few minutes. */
const FIRST_SYNC_MS = 45_000;
const SYNC_INTERVAL_MS = 3 * 60_000;
const SYNC_GIVE_UP_MS = 72 * 60 * 60_000;

/**
 * Atomically claims due jobs. `FOR UPDATE SKIP LOCKED` + a lease guarantees that concurrent ticks
 * (overlapping cron runs, manual triggers) never process the same job twice. Jobs whose lease
 * expired (worker crashed mid-step) are reclaimed and their step is reconciled.
 */
export async function claimDueJobs(
  limit: number,
  scope: { userId?: string; publicationId?: string } = {},
): Promise<Job[]> {
  const lockToken = crypto.randomUUID();
  const rows = await db.execute<{ id: string }>(sql`
    update publishing_jobs set
      status = 'running',
      lock_token = ${lockToken},
      locked_until = now() + make_interval(secs => ${LEASE_SECONDS}),
      step_state = case when publishing_jobs.status = 'running'
        then publishing_jobs.step_state || '{"__reconcile": true}'::jsonb
        else publishing_jobs.step_state end,
      updated_at = now()
    where id in (
      select id from publishing_jobs
      where (
        (status in ('pending', 'waiting') and run_at <= now())
        or (status = 'running' and locked_until < now())
      )
      ${scope.userId ? sql`and user_id = ${scope.userId}` : sql``}
      ${scope.publicationId ? sql`and publication_id = ${scope.publicationId}` : sql``}
      order by run_at
      for update skip locked
      limit ${limit}
    )
    returning id
  `);
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  return db.query.publishingJobs.findMany({
    where: (j, { inArray, and: a, eq: e }) => a(inArray(j.id, ids), e(j.lockToken, lockToken)),
  });
}

async function recordAttempt(
  job: Job,
  outcome: (typeof publishingAttempts.$inferInsert)["outcome"],
  started: number,
  err?: unknown,
) {
  await db.insert(publishingAttempts).values({
    jobId: job.id,
    publicationId: job.publicationId,
    step: job.step,
    outcome,
    httpStatus: err instanceof PublishError ? (err.httpStatus ?? null) : null,
    errorCode: err instanceof PublishError ? (err.providerCode ?? err.kind) : err ? "error" : null,
    message: err ? errorSummary(err) : null,
    durationMs: Date.now() - started,
  });
}

/** Writes only while we still hold the lease (lock token match). */
const ownJob = (job: Job) => and(eq(publishingJobs.id, job.id), eq(publishingJobs.lockToken, job.lockToken ?? ""));

async function failPublication(
  job: Job,
  pub: typeof publications.$inferSelect,
  err: unknown,
  terminal: "dead" | "done",
) {
  const message = err instanceof Error ? err.message : "Publishing failed";
  await db.transaction(async (tx) => {
    await tx
      .update(publishingJobs)
      .set({ status: terminal, lastError: errorSummary(err), lockToken: null, lockedUntil: null })
      .where(ownJob(job));
    await tx
      .update(publications)
      .set({
        status: "failed",
        lastErrorCode: err instanceof PublishError ? (err.providerCode ?? err.kind) : "error",
        lastErrorMessage: message.slice(0, 500),
        attempts: sql`${publications.attempts} + 1`,
      })
      .where(eq(publications.id, pub.id));
    await syncStoryStatus(pub.storyId, tx);
  });
  await track({
    userId: pub.userId,
    type: "publication_failed",
    storyId: pub.storyId,
    publicationId: pub.id,
    provider: pub.provider,
    meta: { reason: err instanceof PublishError ? err.kind : "error" },
  });
  await notify(pub.userId, "publication.failed", {
    title: "Publishing failed",
    body: message.slice(0, 160),
    data: { storyId: pub.storyId, publicationId: pub.id },
  });
}

async function completePublication(
  job: Job,
  pub: typeof publications.$inferSelect,
  result: Extract<StepResult, { type: "done" }>,
) {
  const provider = getPublishingProvider(pub.provider);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(publishingJobs)
      .set({ status: "done", lockToken: null, lockedUntil: null, lastError: null })
      .where(ownJob(job));
    await tx
      .update(publications)
      .set({
        status: result.status,
        externalPostIds: result.externalPostIds,
        permalink: result.permalink ?? null,
        providerMeta: { ...pub.providerMeta, ...(result.meta ?? {}) },
        submittedAt: now,
        publishedAt: result.status === "published" ? now : null,
        lastErrorCode: null,
        lastErrorMessage: null,
      })
      .where(eq(publications.id, pub.id));
    if (result.status === "submitted" && provider.capabilities().statusSync) {
      await tx
        .insert(publishingJobs)
        .values({
          userId: pub.userId,
          publicationId: pub.id,
          kind: "sync_status",
          step: "sync",
          runAt: new Date(now.getTime() + FIRST_SYNC_MS),
          maxAttempts: 50,
        })
        .onConflictDoNothing();
    }
    await syncStoryStatus(pub.storyId, tx);
  });
  if (result.status === "published") await onPublished(pub, result.permalink ?? null);
}

async function onPublished(pub: typeof publications.$inferSelect, permalink: string | null) {
  await track({
    userId: pub.userId,
    type: "story_published",
    storyId: pub.storyId,
    publicationId: pub.id,
    provider: pub.provider,
  });
  const confirmed = getPublishingProvider(pub.provider).capabilities().confirmsPublication;
  await notify(pub.userId, "publication.published", {
    title: confirmed ? "Published to Threads" : "Sent by Buffer",
    body: confirmed ? "Your story is live." : "Buffer reports the post was sent to Threads.",
    data: { storyId: pub.storyId, publicationId: pub.id, permalink },
  });
}

async function handleError(job: Job, pub: typeof publications.$inferSelect, err: unknown, started: number) {
  const perr = err instanceof PublishError ? err : new PublishError("transient", errorSummary(err), { cause: err });
  const attempts = job.attempts + 1;

  if (perr.kind === "auth" || perr.kind === "not_configured") {
    await recordAttempt(job, "permanent_error", started, perr);
    if (perr.kind === "auth") await markAccountStatus(pub.userId, pub.provider, "expired", perr.message);
    return failPublication(job, pub, perr, "done");
  }
  if (perr.kind === "permanent") {
    await recordAttempt(job, "permanent_error", started, perr);
    return failPublication(job, pub, perr, "done");
  }

  const unknown = perr.kind === "unknown";
  await recordAttempt(job, unknown ? "unknown" : "transient_error", started, perr);
  if (attempts >= job.maxAttempts) {
    const final = unknown
      ? new PublishError(
          "permanent",
          "Couldn't confirm whether the post went out. Check your Threads profile before retrying.",
        )
      : perr;
    return failPublication(job, pub, final, "dead");
  }
  const delay = Math.max(perr.retryAfterMs ?? 0, BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)] ?? 60_000);
  await db
    .update(publishingJobs)
    .set({
      status: "waiting",
      attempts,
      runAt: new Date(Date.now() + delay),
      lastError: errorSummary(perr),
      lockToken: null,
      lockedUntil: null,
      // An unknown outcome must be reconciled before the step is attempted again.
      stepState: unknown ? { ...job.stepState, __reconcile: true } : job.stepState,
    })
    .where(ownJob(job));
  await db
    .update(publications)
    .set({ attempts: sql`${publications.attempts} + 1`, lastErrorMessage: perr.message.slice(0, 500) })
    .where(eq(publications.id, pub.id));
}

async function runPublishJob(job: Job, pub: typeof publications.$inferSelect) {
  const provider = getPublishingProvider(pub.provider);
  const started = Date.now();
  const { __reconcile, ...stepState } = job.stepState;
  try {
    const account = await getCredentials(pub.userId, pub.provider);
    const ctx: PublishContext = {
      publicationId: pub.id,
      posts: pub.postsSnapshot,
      account,
      step: job.step,
      stepState,
      reconcile: __reconcile === true,
    };
    const result = await provider.runStep(ctx);
    await recordAttempt(job, "success", started);
    if (result.type === "continue") {
      await db
        .update(publishingJobs)
        .set({
          step: result.step,
          stepState: result.stepState,
          status: "waiting",
          runAt: new Date(Date.now() + result.delayMs),
          attempts: 0,
          lockToken: null,
          lockedUntil: null,
          lastError: null,
        })
        .where(ownJob(job));
      return { continued: true, delayMs: result.delayMs };
    }
    await completePublication(job, pub, result);
    return { continued: false, delayMs: 0 };
  } catch (err) {
    await handleError(job, pub, err, started);
    return { continued: false, delayMs: 0 };
  }
}

async function runSyncJob(job: Job, pub: typeof publications.$inferSelect) {
  const provider = getPublishingProvider(pub.provider);
  const done = () =>
    db.update(publishingJobs).set({ status: "done", lockToken: null, lockedUntil: null }).where(ownJob(job));
  if (pub.status !== "submitted" || !provider.syncStatus) return done();
  try {
    const account = await getCredentials(pub.userId, pub.provider);
    const result = await provider.syncStatus({ account, externalPostIds: pub.externalPostIds });
    if (result.status === "published") {
      await db.transaction(async (tx) => {
        await tx
          .update(publications)
          .set({
            status: "published",
            publishedAt: new Date(),
            permalink: result.permalink ?? pub.permalink,
            providerMeta: { ...pub.providerMeta, ...(result.meta ?? {}) },
          })
          .where(eq(publications.id, pub.id));
        await syncStoryStatus(pub.storyId, tx);
      });
      await done();
      await onPublished(pub, result.permalink ?? null);
      return;
    }
    if (result.status === "failed") {
      await failPublication(job, pub, new PublishError("permanent", result.message), "done");
      return;
    }
    const reference = (pub.submittedAt ?? pub.createdAt).getTime();
    if (Date.now() - reference > SYNC_GIVE_UP_MS) {
      await db
        .update(publications)
        .set({
          providerMeta: { ...pub.providerMeta, syncNote: "Buffer has not reported this post as sent. Check Buffer." },
        })
        .where(eq(publications.id, pub.id));
      return done();
    }
    await db
      .update(publishingJobs)
      .set({ status: "waiting", runAt: new Date(Date.now() + SYNC_INTERVAL_MS), lockToken: null, lockedUntil: null })
      .where(ownJob(job));
  } catch (err) {
    log.warn("status sync failed", { publicationId: pub.id, err: errorSummary(err) });
    await db
      .update(publishingJobs)
      .set({
        status: "waiting",
        runAt: new Date(Date.now() + SYNC_INTERVAL_MS),
        lastError: errorSummary(err),
        lockToken: null,
        lockedUntil: null,
      })
      .where(ownJob(job));
  }
}

export async function processJob(job: Job) {
  const [pub] = await db.select().from(publications).where(eq(publications.id, job.publicationId));
  if (!pub || (job.kind === "publish" && pub.status === "published")) {
    await db.update(publishingJobs).set({ status: "cancelled", lockToken: null, lockedUntil: null }).where(ownJob(job));
    return { continued: false, delayMs: 0 };
  }
  if (job.kind === "sync_status") {
    await runSyncJob(job, pub);
    return { continued: false, delayMs: 0 };
  }
  return runPublishJob(job, pub);
}

/** Runs one claimed job; a crash puts it back in the queue instead of losing it. */
export async function processJobSafely(job: Job) {
  try {
    await processJob(job);
  } catch (err) {
    log.error("job crashed", { jobId: job.id, err: errorSummary(err) });
    await db
      .update(publishingJobs)
      .set({
        status: "waiting",
        runAt: new Date(Date.now() + 30_000),
        lastError: errorSummary(err),
        lockToken: null,
        lockedUntil: null,
      })
      .where(ownJob(job));
  }
}

/** Processes whatever is due right now (no waiting). Used by the daily server cron. */
export async function processDueJobs(options: { budgetMs?: number; batch?: number } = {}) {
  const deadline = Date.now() + (options.budgetMs ?? 45_000);
  let processed = 0;
  while (Date.now() < deadline) {
    const jobs = await claimDueJobs(options.batch ?? 5);
    if (jobs.length === 0) break;
    for (const job of jobs) {
      await processJobSafely(job);
      processed++;
    }
  }
  return { processed };
}
