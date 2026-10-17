import { waitUntil } from "@vercel/functions";
import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "../db/client";
import { publishingJobs } from "../db/schema";
import { errorSummary, log } from "../security/redact";
import { claimDueJobs, processJobSafely } from "./runner";

/** Stays under Vercel's default 300s function limit (Fluid compute, all plans). */
export const BACKGROUND_BUDGET_MS = 270_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type DriveScope = { publicationId?: string; userId?: string };

/**
 * Drives jobs in `scope` to completion: runs whatever is due, then sleeps until the next step
 * (e.g. the ~seconds Threads needs to process a container) — as long as that fits the budget.
 * Claims use row locks, so several drivers (request + app trigger + cron) never run a job twice.
 * Anything left when the budget ends is picked up by the next app trigger or the daily cron.
 */
export async function drive(
  scope: DriveScope,
  options: { budgetMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ completed: boolean; processed: number }> {
  const deadline = Date.now() + (options.budgetMs ?? BACKGROUND_BUDGET_MS);
  const sleep = options.sleep ?? defaultSleep;
  let processed = 0;
  while (Date.now() < deadline) {
    const jobs = await claimDueJobs(5, scope);
    if (jobs.length) {
      for (const job of jobs) await processJobSafely(job);
      processed += jobs.length;
      continue;
    }
    const filters = [inArray(publishingJobs.status, ["pending", "waiting", "running"])];
    if (scope.publicationId) filters.push(eq(publishingJobs.publicationId, scope.publicationId));
    if (scope.userId) filters.push(eq(publishingJobs.userId, scope.userId));
    const [next] = await db
      .select({ runAt: publishingJobs.runAt, status: publishingJobs.status, lockedUntil: publishingJobs.lockedUntil })
      .from(publishingJobs)
      .where(and(...filters))
      .orderBy(asc(publishingJobs.runAt))
      .limit(1);
    if (!next) return { completed: true, processed };
    // A job held by another driver: wait for its lease; otherwise wait until it is due.
    const wakeAt =
      next.status === "running" ? (next.lockedUntil?.getTime() ?? Date.now() + 5_000) : next.runAt.getTime();
    const wait = Math.max(250, wakeAt - Date.now());
    if (Date.now() + wait > deadline) return { completed: false, processed };
    await sleep(Math.min(wait, 5_000));
  }
  return { completed: false, processed };
}

/**
 * Runs work after the HTTP response is sent. On Vercel, `waitUntil` keeps the function alive
 * until the promise settles (bounded by maxDuration); locally the promise simply keeps running.
 */
export function inBackground(label: string, work: () => Promise<unknown>) {
  const promise = work().catch((err) => log.error("background work failed", { label, err: errorSummary(err) }));
  waitUntil(promise);
}
