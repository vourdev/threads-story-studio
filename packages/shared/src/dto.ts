import { z } from "zod";

import { GENERATION_MODES } from "./params";
import { PUBLISHING_PROVIDERS, STORY_STATUSES } from "./status";
import { THREADS_MAX_CHARS, THREADS_MAX_POSTS_PER_THREAD } from "./threads-length";

export const storyPostSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().max(THREADS_MAX_CHARS * 4),
});
export type StoryPost = z.infer<typeof storyPostSchema>;

export const storyPostsSchema = z.array(storyPostSchema).min(1).max(THREADS_MAX_POSTS_PER_THREAD);

export const createStoryInput = z.object({
  mode: z.enum(GENERATION_MODES),
  rawInput: z.string().trim().max(6000).default(""),
  context: z.string().trim().max(3000).optional(),
  productId: z.uuid().optional(),
});
export type CreateStoryInput = z.infer<typeof createStoryInput>;

export const updateStoryInputInput = z.object({
  rawInput: z.string().trim().min(1).max(6000).optional(),
  context: z.string().trim().max(3000).optional(),
  clarifications: z
    .array(z.object({ question: z.string().max(500), answer: z.string().max(1000) }))
    .max(10)
    .optional(),
});

export const paramOperationInput = z.discriminatedUnion("op", [
  z.object({ op: z.literal("edit"), key: z.string(), value: z.string().max(300) }),
  z.object({ op: z.literal("lock"), key: z.string(), locked: z.boolean() }),
  z.object({ op: z.literal("accept_suggestions") }),
  z.object({ op: z.literal("reset_to_ai") }),
]);
export type ParamOperationInput = z.infer<typeof paramOperationInput>;

export const generateInput = z.object({
  count: z.number().int().min(1).max(5).default(3),
  disablePersonalization: z.boolean().optional().default(false),
});
export type GenerateInput = z.infer<typeof generateInput>;

export const saveContentInput = z.object({
  posts: storyPostsSchema,
  note: z.string().max(200).optional(),
});

export const REFINE_ACTIONS = [
  "stronger_hook",
  "more_emotional",
  "more_relatable",
  "more_concise",
  "more_natural",
  "funnier",
  "better_progression",
  "change_angle",
  "different_audience",
  "different_ending",
  "change_tone",
  "shorten",
  "expand",
  "change_cta",
  "rewrite_selection",
  "custom",
] as const;
export type RefineAction = (typeof REFINE_ACTIONS)[number];

export const REFINE_ACTION_LABELS: Record<RefineAction, string> = {
  stronger_hook: "Make the hook stronger",
  more_emotional: "More emotional",
  more_relatable: "More relatable",
  more_concise: "More concise",
  more_natural: "Sound more natural",
  funnier: "Make it funnier",
  better_progression: "Improve narrative progression",
  change_angle: "Change the angle",
  different_audience: "Rewrite for another audience",
  different_ending: "Different ending",
  change_tone: "Change tone",
  shorten: "Shorten",
  expand: "Expand",
  change_cta: "Change CTA",
  rewrite_selection: "Rewrite selected text",
  custom: "Custom instruction",
};

export const refineInput = z.object({
  action: z.enum(REFINE_ACTIONS),
  /** Free text: target audience / tone / angle / custom instruction. */
  instruction: z.string().trim().max(500).optional(),
  selection: z
    .object({ postId: z.string(), start: z.number().int().min(0), end: z.number().int().min(0) })
    .refine((s) => s.end > s.start, "Empty selection")
    .optional(),
});
export type RefineInput = z.infer<typeof refineInput>;

/** Publishing can be immediate or scheduled. */
export const publishInput = z.object({
  provider: z.enum(PUBLISHING_PROVIDERS),
  scheduledFor: z.string().datetime().optional(),
});
export type PublishInput = z.infer<typeof publishInput>;

export const libraryQuery = z.object({
  q: z.string().trim().max(200).optional(),
  mode: z.enum(GENERATION_MODES).optional(),
  status: z.enum(STORY_STATUSES).optional(),
  productId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  sort: z.enum(["updated_desc", "created_desc", "created_asc", "title_asc"]).default("updated_desc"),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type LibraryQuery = z.infer<typeof libraryQuery>;

export const productInput = z.object({
  shopeeUrl: z.url().max(2000),
  name: z.string().trim().min(1).max(300),
  category: z.string().trim().max(120).optional(),
  description: z.string().trim().max(4000).optional(),
  imageUrl: z.url().max(2000).optional(),
  priceMin: z
    .string()
    .regex(/^\d{1,10}(\.\d{1,2})?$/)
    .optional(),
  priceMax: z
    .string()
    .regex(/^\d{1,10}(\.\d{1,2})?$/)
    .optional(),
  currency: z.string().length(3).optional(),
  benefits: z.array(z.string().trim().min(1).max(300)).max(15).default([]),
  features: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
});
export type ProductInput = z.infer<typeof productInput>;

export const affiliateLinkInput = z.object({
  destinationUrl: z.url().max(2000),
  label: z.string().trim().max(100).optional(),
});

export const appSettingsInput = z.object({
  timezone: z.string().min(1).max(64),
  defaultVariationCount: z.number().int().min(1).max(5),
  dailyGenerationLimit: z.number().int().min(1).max(500),
  providerByWorkflow: z.record(z.string(), z.enum(["gemini", "omniroute"])),
  fallbackEnabled: z.boolean(),
  disabledProviders: z.array(z.enum(["gemini", "omniroute"])),
  defaultParams: z.record(z.string(), z.string().max(300)),
});
export type AppSettingsInput = z.infer<typeof appSettingsInput>;

export const registerDeviceInput = z.object({
  expoPushToken: z.string().regex(/^Expo(nent)?PushToken\[[^\]]+\]$/),
  platform: z.enum(["ios", "android"]),
});

export const MAX_SINGLE_POST_CHARS = THREADS_MAX_CHARS;

export const userRoleEnum = z.enum(["user", "admin"]);
export type UserRole = z.infer<typeof userRoleEnum>;

export const writingProfileInput = z.object({
  displayName: z.string().trim().max(100).optional().nullable(),
  preferredName: z.string().trim().max(100).optional().nullable(),
  bio: z.string().trim().max(1000).optional().nullable(),
  occupation: z.string().trim().max(100).optional().nullable(),
  industry: z.string().trim().max(100).optional().nullable(),
  currentActivities: z.string().trim().max(1000).optional().nullable(),
  interests: z.array(z.string().trim().max(100)).max(20).default([]),
  contentTopics: z.array(z.string().trim().max(100)).max(20).default([]),
  goals: z.string().trim().max(1000).optional().nullable(),
  targetAudience: z.string().trim().max(500).optional().nullable(),
  preferredLanguage: z.string().max(20).default("id_casual"),
  tone: z.string().trim().max(100).optional().nullable(),
  writingStyle: z.string().trim().max(100).optional().nullable(),
  formalityLevel: z.string().trim().max(100).optional().nullable(),
  sentenceLength: z.string().trim().max(100).optional().nullable(),
  slangPreference: z.string().trim().max(100).optional().nullable(),
  humorPreference: z.string().trim().max(100).optional().nullable(),
  emojiPreference: z.string().trim().max(100).optional().nullable(),
  storytellingPerspective: z.string().trim().max(100).optional().nullable(),
  ctaStyle: z.string().trim().max(100).optional().nullable(),
  favoriteExpressions: z.array(z.string().trim().max(200)).max(30).default([]),
  avoidExpressions: z.array(z.string().trim().max(200)).max(30).default([]),
  writingExamples: z.array(z.string().trim().max(2000)).max(10).default([]),
  factualBoundaries: z.string().trim().max(1000).optional().nullable(),
  forbiddenTopics: z.array(z.string().trim().max(100)).max(30).default([]),
  personalizationEnabled: z.boolean().default(true),
});
export type WritingProfileInput = z.infer<typeof writingProfileInput>;

export const onboardingInput = z.object({
  step: z.number().int().min(1).max(10).optional(),
  completed: z.boolean().optional(),
  displayName: z.string().trim().max(100).optional(),
  preferredLanguage: z.string().max(20).optional(),
  writingStyle: z.string().trim().max(100).optional(),
  tone: z.string().trim().max(100).optional(),
  targetAudience: z.string().trim().max(500).optional(),
});
export type OnboardingInput = z.infer<typeof onboardingInput>;
