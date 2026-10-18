export const STORY_STATUSES = ["draft", "scheduled", "publishing", "submitted", "published", "failed"] as const;
export type StoryStatus = (typeof STORY_STATUSES)[number];

/**
 * Publishing is immediate or scheduled: a publication starts as `scheduled` or `publishing`,
 * becomes `published` (confirmed by Threads, or reported as sent by Buffer),
 * `submitted` (accepted by Buffer, not yet reported as sent) or `failed`.
 */
export const PUBLICATION_STATUSES = ["scheduled", "publishing", "submitted", "published", "failed"] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

/** Statuses where the publication is still in flight and must not be duplicated. */
export const ACTIVE_PUBLICATION_STATUSES = ["scheduled", "publishing", "submitted"] as const satisfies readonly PublicationStatus[];

export const PUBLISHING_PROVIDERS = ["threads", "buffer"] as const;
export type PublishingProviderId = (typeof PUBLISHING_PROVIDERS)[number];

export const AI_PROVIDERS = ["gemini", "omniroute"] as const;
export type AIProviderId = (typeof AI_PROVIDERS)[number];

export const AI_WORKFLOWS = ["analyze", "suggest", "generate", "refine", "evaluate"] as const;
export type AIWorkflow = (typeof AI_WORKFLOWS)[number];

export const STATUS_LABELS: Record<StoryStatus | PublicationStatus, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  publishing: "Publishing",
  submitted: "Sent to Buffer",
  published: "Published",
  failed: "Failed",
};

export type ProviderCapabilities = {
  thread: boolean;
  statusSync: boolean;
  metrics: boolean;
  /** True when "published" is confirmed by the platform itself rather than an intermediary. */
  confirmsPublication: boolean;
};

export const ANALYTICS_EVENT_TYPES = [
  "story_generated",
  "story_saved",
  "story_published",
  "publication_failed",
  "product_viewed",
  "affiliate_link_clicked",
] as const;
export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];
