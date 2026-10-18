import { and, count, desc, eq, gte, isNull, sql, sum } from "drizzle-orm";

import { db } from "../db/client";
import {
  affiliateLinks,
  aiUsageLogs,
  analyticsEvents,
  appSettings,
  products,
  publications,
  stories,
} from "../db/schema";

export const RANGES = { "7d": 7, "30d": 30, "90d": 90, all: null } as const;
export type Range = keyof typeof RANGES;

function since(range: Range): Date {
  const days = RANGES[range];
  return days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : new Date(0);
}

const notBot = sql`coalesce((${analyticsEvents.meta}->>'bot')::boolean, false) = false`;

/** Dashboard metrics. Every number comes from persisted application data; sources are labelled for the UI. */
export async function dashboard(userId: string, range: Range) {
  // Timezone resolved inside SQL so the whole dashboard is one parallel round trip.
  const timezone = sql`coalesce((select ${appSettings.timezone} from ${appSettings} where ${appSettings.userId} = ${userId}), 'Asia/Jakarta')`;
  const from = since(range);
  const eventCount = (type: (typeof analyticsEvents.$inferSelect)["type"], extra = sql`true`) =>
    db
      .select({ n: count() })
      .from(analyticsEvents)
      .where(
        and(
          eq(analyticsEvents.userId, userId),
          eq(analyticsEvents.type, type),
          gte(analyticsEvents.occurredAt, from),
          extra,
        ),
      )
      .then((r) => r[0]?.n ?? 0);

  const [generated, clicks, pubCounts, [drafts], [links], posts, recent, aiUsage, topProducts, topStories, series] =
    await Promise.all([
      eventCount("story_generated"),
      eventCount("affiliate_link_clicked", notBot),
      db
        .select({ status: publications.status, n: count() })
        .from(publications)
        .where(and(eq(publications.userId, userId), gte(publications.updatedAt, from)))
        .groupBy(publications.status),
      db
        .select({ n: count() })
        .from(stories)
        .where(and(eq(stories.userId, userId), isNull(stories.deletedAt), eq(stories.status, "draft"))),
      db
        .select({ n: count() })
        .from(affiliateLinks)
        .where(and(eq(affiliateLinks.userId, userId), isNull(affiliateLinks.archivedAt))),
      db
        .select({
          id: publications.id,
          storyId: publications.storyId,
          title: stories.title,
          provider: publications.provider,
          status: publications.status,
          permalink: publications.permalink,
          publishedAt: publications.publishedAt,
          createdAt: publications.createdAt,
          preview: sql<string>`${publications.postsSnapshot}->0->>'text'`,
        })
        .from(publications)
        .innerJoin(stories, eq(stories.id, publications.storyId))
        .where(eq(publications.userId, userId))
        .orderBy(desc(publications.createdAt))
        .limit(8),
      db
        .select({
          id: analyticsEvents.id,
          type: analyticsEvents.type,
          occurredAt: analyticsEvents.occurredAt,
          storyId: analyticsEvents.storyId,
          storyTitle: stories.title,
          productName: products.name,
          provider: analyticsEvents.provider,
        })
        .from(analyticsEvents)
        .leftJoin(stories, eq(stories.id, analyticsEvents.storyId))
        .leftJoin(products, eq(products.id, analyticsEvents.productId))
        .where(and(eq(analyticsEvents.userId, userId), sql`${analyticsEvents.type} <> 'product_viewed'`, notBot))
        .orderBy(desc(analyticsEvents.occurredAt))
        .limit(15),
      db
        .select({
          provider: aiUsageLogs.provider,
          calls: count(),
          errors: sql<number>`count(*) filter (where ${aiUsageLogs.status} = 'error')`.mapWith(Number),
          cached: sql<number>`count(*) filter (where ${aiUsageLogs.cached})`.mapWith(Number),
          inputTokens: sum(aiUsageLogs.inputTokens).mapWith(Number),
          outputTokens: sum(aiUsageLogs.outputTokens).mapWith(Number),
          lastError: sql<
            string | null
          >`(array_agg(${aiUsageLogs.errorCode} order by ${aiUsageLogs.createdAt} desc) filter (where ${aiUsageLogs.status} = 'error'))[1]`,
        })
        .from(aiUsageLogs)
        .where(and(eq(aiUsageLogs.userId, userId), gte(aiUsageLogs.createdAt, from)))
        .groupBy(aiUsageLogs.provider),
      db
        .select({ productId: products.id, name: products.name, imageUrl: products.imageUrl, clicks: count() })
        .from(analyticsEvents)
        .innerJoin(products, eq(products.id, analyticsEvents.productId))
        .where(
          and(
            eq(analyticsEvents.userId, userId),
            eq(analyticsEvents.type, "affiliate_link_clicked"),
            gte(analyticsEvents.occurredAt, from),
            notBot,
          ),
        )
        .groupBy(products.id)
        .orderBy(desc(count()))
        .limit(5),
      db
        .select({ storyId: stories.id, title: stories.title, clicks: count() })
        .from(analyticsEvents)
        .innerJoin(stories, eq(stories.affiliateLinkId, analyticsEvents.affiliateLinkId))
        .where(
          and(
            eq(analyticsEvents.userId, userId),
            eq(analyticsEvents.type, "affiliate_link_clicked"),
            gte(analyticsEvents.occurredAt, from),
            notBot,
            isNull(stories.deletedAt),
          ),
        )
        .groupBy(stories.id)
        .orderBy(desc(count()))
        .limit(5),
      db
        .select({
          day: sql<string>`to_char(${analyticsEvents.occurredAt} at time zone ${timezone}, 'YYYY-MM-DD')`,
          generated: sql<number>`count(*) filter (where ${analyticsEvents.type} = 'story_generated')`.mapWith(Number),
          published: sql<number>`count(*) filter (where ${analyticsEvents.type} = 'story_published')`.mapWith(Number),
          clicks: sql<number>`count(*) filter (where ${analyticsEvents.type} = 'affiliate_link_clicked')`.mapWith(
            Number,
          ),
        })
        .from(analyticsEvents)
        .where(
          and(
            eq(analyticsEvents.userId, userId),
            gte(analyticsEvents.occurredAt, since(range === "all" ? "90d" : range)),
            notBot,
          ),
        )
        .groupBy(sql`1`)
        .orderBy(sql`1`),
    ]);

  const byStatus = Object.fromEntries(pubCounts.map((p) => [p.status, p.n])) as Record<string, number>;
  const published = byStatus.published ?? 0;
  const failed = byStatus.failed ?? 0;
  return {
    range,
    sources: {
      appEvents: "Counted from events recorded by this app",
      redirectClicks: "Clicks through tracked /r/ links (bots excluded). Not sales.",
      providerStatus: "Publication status as reported by Threads or Buffer",
    },
    kpis: {
      generated,
      published,
      failed,
      inProgress: (byStatus.publishing ?? 0) + (byStatus.submitted ?? 0),
      drafts: drafts?.n ?? 0,
      affiliateLinks: links?.n ?? 0,
      clicks,
      successRate: published + failed > 0 ? published / (published + failed) : null,
    },
    posts,
    recent,
    aiUsage,
    topProducts,
    topStories,
    series,
  };
}
