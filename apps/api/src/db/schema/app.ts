import {
  ANALYTICS_EVENT_TYPES,
  GENERATION_MODES,
  PUBLICATION_STATUSES,
  PUBLISHING_PROVIDERS,
  STORY_STATUSES,
  type StoryPost,
} from "@tss/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth";

const timestamps = {
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};

const ownerId = () =>
  text()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });

export const generationModeEnum = pgEnum("generation_mode", GENERATION_MODES);
export const storyStatusEnum = pgEnum("story_status", STORY_STATUSES);
export const publicationStatusEnum = pgEnum("publication_status", PUBLICATION_STATUSES);
export const publishingProviderEnum = pgEnum("publishing_provider", PUBLISHING_PROVIDERS);
export const analyticsEventEnum = pgEnum("analytics_event_type", ANALYTICS_EVENT_TYPES);
export const jobStatusEnum = pgEnum("job_status", ["pending", "running", "waiting", "done", "dead", "cancelled"]);
export const attemptOutcomeEnum = pgEnum("attempt_outcome", [
  "success",
  "transient_error",
  "permanent_error",
  "unknown",
]);
export const productSourceEnum = pgEnum("product_data_source", ["manual", "og_meta", "affiliate_api"]);
export const versionSourceEnum = pgEnum("story_version_source", [
  "generated",
  "variation_select",
  "edit",
  "refine",
  "restore",
  "chat",
]);
export const accountStatusEnum = pgEnum("account_status", ["connected", "expired", "revoked", "error"]);

// ---------------------------------------------------------------- settings / AI

export const appSettings = pgTable("app_settings", {
  userId: ownerId().primaryKey(),
  timezone: text().notNull().default("Asia/Jakarta"),
  defaultVariationCount: integer().notNull().default(3),
  dailyGenerationLimit: integer().notNull().default(60),
  providerByWorkflow: jsonb().$type<Record<string, "gemini" | "omniroute">>().notNull().default({}),
  fallbackEnabled: boolean().notNull().default(true),
  disabledProviders: jsonb().$type<string[]>().notNull().default([]),
  defaultParams: jsonb().$type<Record<string, string>>().notNull().default({}),
  ...timestamps,
});

export const userWritingProfiles = pgTable("user_writing_profiles", {
  userId: ownerId().primaryKey(),
  displayName: text(),
  preferredName: text(),
  bio: text(),
  occupation: text(),
  industry: text(),
  currentActivities: text(),
  interests: jsonb().$type<string[]>().notNull().default([]),
  contentTopics: jsonb().$type<string[]>().notNull().default([]),
  goals: text(),
  targetAudience: text(),
  preferredLanguage: text().notNull().default("id_casual"),
  tone: text(),
  writingStyle: text(),
  formalityLevel: text(),
  sentenceLength: text(),
  slangPreference: text(),
  humorPreference: text(),
  emojiPreference: text(),
  storytellingPerspective: text(),
  ctaStyle: text(),
  favoriteExpressions: jsonb().$type<string[]>().notNull().default([]),
  avoidExpressions: jsonb().$type<string[]>().notNull().default([]),
  writingExamples: jsonb().$type<string[]>().notNull().default([]),
  factualBoundaries: text(),
  forbiddenTopics: jsonb().$type<string[]>().notNull().default([]),
  personalizationEnabled: boolean().notNull().default(true),
  ...timestamps,
});

export const aiUsageLogs = pgTable(
  "ai_usage_logs",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: text().references(() => users.id, { onDelete: "set null" }),
    provider: text().notNull(),
    model: text().notNull(),
    workflow: text().notNull(),
    promptVersion: text().notNull(),
    inputTokens: integer(),
    outputTokens: integer(),
    latencyMs: integer().notNull(),
    status: text().$type<"success" | "error">().notNull(),
    errorCode: text(),
    cached: boolean().notNull().default(false),
    repaired: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index().on(t.userId, t.createdAt), index().on(t.provider, t.createdAt)],
);

export const aiCache = pgTable("ai_cache", {
  key: text().primaryKey(),
  workflow: text().notNull(),
  response: jsonb().notNull(),
  provider: text().notNull(),
  model: text().notNull(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

// ---------------------------------------------------------------- products

export const products = pgTable(
  "products",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: ownerId(),
    shopeeUrl: text().notNull(),
    canonicalUrl: text(),
    shopId: text(),
    itemId: text(),
    name: text().notNull(),
    category: text(),
    description: text(),
    imageUrl: text(),
    priceMin: numeric({ precision: 12, scale: 2 }),
    priceMax: numeric({ precision: 12, scale: 2 }),
    currency: text(),
    benefits: jsonb().$type<string[]>().notNull().default([]),
    features: jsonb().$type<string[]>().notNull().default([]),
    dataSource: productSourceEnum().notNull().default("manual"),
    /** Which fields came from a verified source (affiliate API / page metadata) vs manual entry. */
    verifiedFields: jsonb().$type<string[]>().notNull().default([]),
    extractionStatus: text().$type<"success" | "partial" | "failed" | "skipped">().notNull().default("skipped"),
    extractionMessage: text(),
    analysis: jsonb(),
    archivedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index().on(t.userId, t.updatedAt), index().on(t.userId, t.shopId, t.itemId)],
);

export const affiliateLinks = pgTable(
  "affiliate_links",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: ownerId(),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    slug: text().notNull().unique(),
    label: text(),
    /** Stored verbatim — tracking parameters are never rewritten. */
    destinationUrl: text().notNull(),
    isVerifiedAffiliate: boolean().notNull().default(false),
    source: text().$type<"manual" | "affiliate_api">().notNull().default("manual"),
    clickCount: integer().notNull().default(0),
    archivedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index().on(t.productId)],
);

// ---------------------------------------------------------------- stories

export const stories = pgTable(
  "stories",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: ownerId(),
    mode: generationModeEnum().notNull(),
    title: text().notNull().default("Untitled story"),
    status: storyStatusEnum().notNull().default("draft"),
    productId: uuid().references(() => products.id, { onDelete: "set null" }),
    affiliateLinkId: uuid().references(() => affiliateLinks.id, { onDelete: "set null" }),
    cta: text(),
    /** Current editable content (latest version). */
    posts: jsonb().$type<StoryPost[]>().notNull().default([]),
    currentVersionNo: integer().notNull().default(0),
    selectedVariationId: uuid(),
    warnings: jsonb().$type<string[]>().notNull().default([]),
    deletedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index().on(t.userId, t.updatedAt), index().on(t.userId, t.status), index().on(t.productId)],
);

export const storyInputs = pgTable("story_inputs", {
  storyId: uuid()
    .primaryKey()
    .references(() => stories.id, { onDelete: "cascade" }),
  rawInput: text().notNull().default(""),
  context: text(),
  clarifications: jsonb().$type<{ question: string; answer: string }[]>().notNull().default([]),
  ...timestamps,
});

export const storyAnalyses = pgTable(
  "story_analyses",
  {
    id: uuid().primaryKey().defaultRandom(),
    storyId: uuid()
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    kind: text().$type<"topic" | "product">().notNull(),
    payload: jsonb().notNull(),
    provider: text().notNull(),
    model: text().notNull(),
    promptVersion: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index().on(t.storyId, t.createdAt)],
);

export const storyParameterConfigs = pgTable("story_parameter_configs", {
  storyId: uuid()
    .primaryKey()
    .references(() => stories.id, { onDelete: "cascade" }),
  params: jsonb().$type<Record<string, unknown>>().notNull(),
  lastSuggestions: jsonb().$type<Record<string, unknown>>(),
  revision: integer().notNull().default(0),
  ...timestamps,
});

export const storyVariations = pgTable(
  "story_variations",
  {
    id: uuid().primaryKey().defaultRandom(),
    storyId: uuid()
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    batchId: uuid().notNull(),
    position: integer().notNull(),
    strategy: text().notNull(),
    angle: text(),
    hook: text(),
    rationale: text(),
    posts: jsonb().$type<StoryPost[]>().notNull(),
    warnings: jsonb().$type<string[]>().notNull().default([]),
    paramsSnapshot: jsonb().$type<Record<string, string>>().notNull(),
    provider: text().notNull(),
    model: text().notNull(),
    promptVersion: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index().on(t.storyId, t.createdAt)],
);

export const storyVersions = pgTable(
  "story_versions",
  {
    id: uuid().primaryKey().defaultRandom(),
    storyId: uuid()
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    versionNo: integer().notNull(),
    posts: jsonb().$type<StoryPost[]>().notNull(),
    cta: text(),
    source: versionSourceEnum().notNull(),
    note: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex().on(t.storyId, t.versionNo)],
);

/** Revision chat between the user and the AI editor, per story. */
export const storyMessages = pgTable(
  "story_messages",
  {
    id: uuid().primaryKey().defaultRandom(),
    storyId: uuid()
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    role: text().$type<"user" | "assistant">().notNull(),
    content: text().notNull(),
    /** Version created by this assistant turn, when it revised the story. */
    versionNo: integer(),
    action: text().$type<"revise" | "answer" | "clarify">(),
    provider: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index().on(t.storyId, t.createdAt)],
);

// ---------------------------------------------------------------- publishing

export const connectedAccounts = pgTable(
  "connected_accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: ownerId(),
    provider: publishingProviderEnum().notNull(),
    externalAccountId: text(),
    username: text(),
    displayName: text(),
    scopes: jsonb().$type<string[]>().notNull().default([]),
    /** AES-256-GCM ciphertext (never returned by the API). Buffer uses the server env key instead. */
    encryptedToken: text(),
    tokenIssuedAt: timestamp({ withTimezone: true }),
    tokenExpiresAt: timestamp({ withTimezone: true }),
    status: accountStatusEnum().notNull().default("connected"),
    statusMessage: text(),
    /** Provider-specific non-secret settings, e.g. Buffer organizationId/channelId. */
    meta: jsonb().$type<Record<string, string>>().notNull().default({}),
    lastValidatedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex().on(t.userId, t.provider)],
);

export const oauthStates = pgTable("oauth_states", {
  id: uuid().primaryKey().defaultRandom(),
  userId: ownerId(),
  provider: text().notNull(),
  stateHash: text().notNull().unique(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  usedAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export const publications = pgTable(
  "publications",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: ownerId(),
    storyId: uuid()
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    storyVersionNo: integer().notNull(),
    /** Exact content submitted — later edits to the story never change an in-flight publication. */
    postsSnapshot: jsonb().$type<StoryPost[]>().notNull(),
    provider: publishingProviderEnum().notNull(),
    status: publicationStatusEnum().notNull(),
    idempotencyKey: text().notNull().unique(),
    externalPostIds: jsonb().$type<string[]>().notNull().default([]),
    permalink: text(),
    providerMeta: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    lastErrorCode: text(),
    lastErrorMessage: text(),
    attempts: integer().notNull().default(0),
    submittedAt: timestamp({ withTimezone: true }),
    publishedAt: timestamp({ withTimezone: true }),
    scheduledFor: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index().on(t.userId, t.status),
    index().on(t.storyId),
    // At most one in-flight publication per story version and provider.
    uniqueIndex("publications_active_unique")
      .on(t.storyId, t.storyVersionNo, t.provider)
      .where(sql`status in ('scheduled','publishing','submitted')`),
  ],
);

export const publishingJobs = pgTable(
  "publishing_jobs",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: ownerId(),
    publicationId: uuid()
      .notNull()
      .references(() => publications.id, { onDelete: "cascade" }),
    kind: text().$type<"publish" | "sync_status">().notNull(),
    step: text().notNull(),
    stepState: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatusEnum().notNull().default("pending"),
    runAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp({ withTimezone: true }),
    lockToken: text(),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(3),
    lastError: text(),
    ...timestamps,
  },
  (t) => [
    index().on(t.status, t.runAt),
    uniqueIndex("publishing_jobs_active_unique")
      .on(t.publicationId, t.kind)
      .where(sql`status in ('pending','running','waiting')`),
  ],
);

export const publishingAttempts = pgTable(
  "publishing_attempts",
  {
    id: uuid().primaryKey().defaultRandom(),
    jobId: uuid()
      .notNull()
      .references(() => publishingJobs.id, { onDelete: "cascade" }),
    publicationId: uuid()
      .notNull()
      .references(() => publications.id, { onDelete: "cascade" }),
    step: text().notNull(),
    outcome: attemptOutcomeEnum().notNull(),
    httpStatus: integer(),
    errorCode: text(),
    message: text(),
    durationMs: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index().on(t.publicationId, t.createdAt)],
);

export const postMetrics = pgTable(
  "post_metrics",
  {
    id: uuid().primaryKey().defaultRandom(),
    publicationId: uuid()
      .notNull()
      .references(() => publications.id, { onDelete: "cascade" }),
    externalPostId: text().notNull(),
    source: text().$type<"threads_insights">().notNull(),
    views: integer(),
    likes: integer(),
    replies: integer(),
    reposts: integer(),
    quotes: integer(),
    fetchedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex().on(t.publicationId, t.externalPostId)],
);

// ---------------------------------------------------------------- analytics / integrations

export const analyticsEvents = pgTable(
  "analytics_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: ownerId(),
    type: analyticsEventEnum().notNull(),
    storyId: uuid().references(() => stories.id, { onDelete: "set null" }),
    productId: uuid().references(() => products.id, { onDelete: "set null" }),
    publicationId: uuid().references(() => publications.id, { onDelete: "set null" }),
    affiliateLinkId: uuid().references(() => affiliateLinks.id, { onDelete: "set null" }),
    provider: text(),
    meta: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index().on(t.userId, t.type, t.occurredAt), index().on(t.affiliateLinkId), index().on(t.storyId)],
);

export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    key: text().notNull(),
    windowStart: timestamp({ withTimezone: true }).notNull(),
    count: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);

export const devices = pgTable(
  "devices",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: ownerId(),
    expoPushToken: text().notNull().unique(),
    platform: text().$type<"ios" | "android">().notNull(),
    lastSeenAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    disabledAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index().on(t.userId)],
);

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid().primaryKey().defaultRandom(),
    deviceId: uuid()
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    ticketId: text(),
    status: text().$type<"sent" | "ok" | "error">().notNull(),
    error: text(),
    receiptCheckedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index().on(t.status, t.createdAt)],
);
