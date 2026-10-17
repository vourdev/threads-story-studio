import type { AnalyticsEventType } from "@tss/shared";

import { db } from "../db/client";
import { analyticsEvents } from "../db/schema";
import { log } from "../security/redact";

type DbLike = Pick<typeof db, "insert">;

export type TrackInput = {
  userId: string;
  type: AnalyticsEventType;
  storyId?: string | null;
  productId?: string | null;
  publicationId?: string | null;
  affiliateLinkId?: string | null;
  provider?: string | null;
  meta?: Record<string, unknown>;
};

/** Records an application event. Never throws — analytics must not break the main flow. */
export async function track(input: TrackInput, tx: DbLike = db): Promise<void> {
  try {
    await tx.insert(analyticsEvents).values({
      userId: input.userId,
      type: input.type,
      storyId: input.storyId ?? null,
      productId: input.productId ?? null,
      publicationId: input.publicationId ?? null,
      affiliateLinkId: input.affiliateLinkId ?? null,
      provider: input.provider ?? null,
      meta: input.meta ?? {},
    });
  } catch (err) {
    log.warn("analytics event failed", { type: input.type, err: String(err) });
  }
}
