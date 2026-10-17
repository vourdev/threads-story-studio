import { z } from "zod";

export const GENERATION_MODES = ["general", "affiliate"] as const;
export type GenerationMode = (typeof GENERATION_MODES)[number];

export const PARAM_STATES = ["ai_suggested", "user_customized", "locked", "default"] as const;
export type ParamState = (typeof PARAM_STATES)[number];

type Option = { value: string; label: string };

export type ParamDefinition = {
  key: string;
  label: string;
  description: string;
  /** "select" = one of `options`; "text" = free text (product facts, custom audience…). */
  kind: "select" | "text";
  options: readonly Option[];
  appliesTo: readonly GenerationMode[];
  /** Allows a free-text value in addition to the listed options (e.g. custom audience). */
  allowCustom?: boolean;
  defaultValue: string;
};

const opts = (...pairs: [string, string][]): Option[] => pairs.map(([value, label]) => ({ value, label }));

const BOTH = ["general", "affiliate"] as const;
const AFFILIATE = ["affiliate"] as const;

export const PARAM_DEFINITIONS = [
  {
    key: "storyType",
    label: "Story type",
    description: "The kind of story being told.",
    kind: "select",
    appliesTo: BOTH,
    defaultValue: "personal_experience",
    options: opts(
      ["personal_experience", "Personal experience"],
      ["career", "Career"],
      ["educational", "Educational"],
      ["funny", "Funny"],
      ["emotional", "Emotional"],
      ["inspirational", "Inspirational"],
      ["opinion", "Opinion"],
      ["daily_life", "Daily life"],
      ["confession", "Confession"],
      ["life_lesson", "Life lesson"],
      ["personal_branding", "Personal branding"],
      ["other", "Other"],
    ),
  },
  {
    key: "emotion",
    label: "Emotion",
    description: "The dominant feeling the reader should take away.",
    kind: "select",
    appliesTo: BOTH,
    defaultValue: "relatable",
    options: opts(
      ["relatable", "Relatable"],
      ["sad", "Sad"],
      ["happy", "Happy"],
      ["proud", "Proud"],
      ["curious", "Curious"],
      ["frustrated", "Frustrated"],
      ["hopeful", "Hopeful"],
      ["funny", "Funny"],
      ["surprised", "Surprised"],
      ["reflective", "Reflective"],
      ["inspirational", "Inspirational"],
    ),
  },
  {
    key: "targetAudience",
    label: "Target audience",
    description: "Who the story is written for.",
    kind: "select",
    appliesTo: BOTH,
    allowCustom: true,
    defaultValue: "general_audience",
    options: opts(
      ["students", "Students"],
      ["fresh_graduates", "Fresh graduates"],
      ["developers", "Developers"],
      ["employees", "Employees"],
      ["entrepreneurs", "Entrepreneurs"],
      ["content_creators", "Content creators"],
      ["job_seekers", "Job seekers"],
      ["general_audience", "General audience"],
    ),
  },
  {
    key: "storyAngle",
    label: "Story angle",
    description: "The narrative structure.",
    kind: "select",
    appliesTo: BOTH,
    defaultValue: "relatable_situation",
    options: opts(
      ["problem_to_solution", "Problem to solution"],
      ["struggle_to_progress", "Struggle to progress"],
      ["turning_point", "Turning point"],
      ["confession", "Confession"],
      ["lesson_learned", "Lesson learned"],
      ["unexpected_discovery", "Unexpected discovery"],
      ["personal_reflection", "Personal reflection"],
      ["opinion", "Opinion"],
      ["before_and_after", "Before and after"],
      ["relatable_situation", "Relatable situation"],
    ),
  },
  {
    key: "hookStyle",
    label: "Hook style",
    description: "How the first line grabs attention.",
    kind: "select",
    appliesTo: BOTH,
    defaultValue: "relatable_opening",
    options: opts(
      ["curiosity", "Curiosity"],
      ["relatable_opening", "Relatable opening"],
      ["emotional_opening", "Emotional opening"],
      ["question", "Question"],
      ["bold_statement", "Bold statement"],
      ["unexpected_observation", "Unexpected observation"],
      ["contrarian", "Contrarian perspective"],
      ["direct_opening", "Direct opening"],
    ),
  },
  {
    key: "writingStyle",
    label: "Writing style",
    description: "Voice and tone of the writing.",
    kind: "select",
    appliesTo: BOTH,
    defaultValue: "conversational",
    options: opts(
      ["casual", "Casual"],
      ["conversational", "Conversational"],
      ["humorous", "Humorous"],
      ["emotional", "Emotional"],
      ["reflective", "Reflective"],
      ["bold", "Bold"],
      ["educational", "Educational"],
      ["minimalist", "Minimalist"],
      ["professional_natural", "Professional but natural"],
    ),
  },
  {
    key: "pointOfView",
    label: "Point of view",
    description: "Narrative perspective.",
    kind: "select",
    appliesTo: BOTH,
    defaultValue: "first_person",
    options: opts(
      ["first_person", "First person"],
      ["third_person", "Third person"],
      ["observer", "Observer"],
      ["neutral_explanatory", "Neutral explanatory"],
    ),
  },
  {
    key: "contentObjective",
    label: "Content objective",
    description: "What the post should achieve.",
    kind: "select",
    appliesTo: BOTH,
    defaultValue: "relatability",
    options: opts(
      ["engagement", "Engagement"],
      ["relatability", "Relatability"],
      ["personal_branding", "Personal branding"],
      ["storytelling", "Storytelling"],
      ["discussion", "Discussion"],
      ["education", "Education"],
      ["audience_growth", "Audience growth"],
    ),
  },
  {
    key: "outputFormat",
    label: "Output format",
    description: "Length and post structure.",
    kind: "select",
    appliesTo: BOTH,
    defaultValue: "multi_post_thread",
    options: opts(
      ["single_post", "Single post"],
      ["multi_post_thread", "Multi-post thread"],
      ["short_story", "Short story"],
      ["medium_story", "Medium story"],
      ["long_story", "Long story"],
    ),
  },
  {
    key: "endingStyle",
    label: "Ending style",
    description: "How the story closes.",
    kind: "select",
    appliesTo: BOTH,
    defaultValue: "memorable_takeaway",
    options: opts(
      ["reflection", "Reflection"],
      ["memorable_takeaway", "Memorable takeaway"],
      ["discussion_question", "Discussion question"],
      ["open_ended", "Open-ended conclusion"],
      ["practical_lesson", "Practical lesson"],
    ),
  },
  {
    key: "factualityMode",
    label: "Factuality",
    description: "How strictly the story sticks to supplied facts.",
    kind: "select",
    appliesTo: BOTH,
    defaultValue: "user_facts_only",
    options: opts(
      ["user_facts_only", "Personal experience — only my facts"],
      ["hypothetical", "Clearly framed hypothetical"],
      ["opinion_educational", "Opinion or educational"],
    ),
  },
  {
    key: "language",
    label: "Language",
    description: "Output language.",
    kind: "select",
    appliesTo: BOTH,
    allowCustom: true,
    defaultValue: "id_casual",
    options: opts(
      ["id", "Indonesian"],
      ["id_casual", "Casual Indonesian"],
      ["en", "English"],
      ["bilingual", "Bilingual (ID + EN)"],
    ),
  },
  // ---- Affiliate-only ----
  {
    key: "productCategory",
    label: "Product category",
    description: "Category of the promoted product.",
    kind: "text",
    appliesTo: AFFILIATE,
    defaultValue: "",
    options: [],
  },
  {
    key: "targetBuyer",
    label: "Target buyer",
    description: "Who is likely to buy this product.",
    kind: "text",
    appliesTo: AFFILIATE,
    defaultValue: "",
    options: [],
  },
  {
    key: "customerPainPoint",
    label: "Customer pain point",
    description: "The problem the product plausibly addresses.",
    kind: "text",
    appliesTo: AFFILIATE,
    defaultValue: "",
    options: [],
  },
  {
    key: "benefitEmphasis",
    label: "Benefit emphasis",
    description: "Which verified benefit to highlight.",
    kind: "text",
    appliesTo: AFFILIATE,
    defaultValue: "",
    options: [],
  },
  {
    key: "productIntroStrategy",
    label: "Product introduction",
    description: "How the product enters the story.",
    kind: "select",
    appliesTo: AFFILIATE,
    defaultValue: "after_problem",
    options: opts(
      ["after_problem", "After describing the problem"],
      ["possible_solution", "As a possible solution"],
      ["product_discovery", "As a product discovery"],
      ["specific_benefit", "Explain a specific benefit"],
      ["compare_attributes", "Compare supported attributes"],
      ["informational", "Informational recommendation"],
    ),
  },
  {
    key: "promotionIntensity",
    label: "Promotion intensity",
    description: "How strongly the post sells.",
    kind: "select",
    appliesTo: AFFILIATE,
    defaultValue: "soft_selling",
    options: opts(["soft_selling", "Soft selling"], ["balanced", "Balanced promotion"], ["direct", "Direct selling"]),
  },
  {
    key: "ctaStrategy",
    label: "CTA strategy",
    description: "Call to action wording.",
    kind: "select",
    appliesTo: AFFILIATE,
    allowCustom: true,
    defaultValue: "view_product",
    options: opts(
      ["view_product", "View product"],
      ["check_details", "Check the product details"],
      ["see_here", "See the product here"],
      ["explore", "Explore the product"],
      ["contextual", "Contextual CTA (AI)"],
    ),
  },
  {
    key: "audienceAwareness",
    label: "Audience awareness",
    description: "How aware the reader is of the problem/product.",
    kind: "select",
    appliesTo: AFFILIATE,
    defaultValue: "problem_aware",
    options: opts(
      ["unaware", "Unaware"],
      ["problem_aware", "Problem aware"],
      ["solution_aware", "Solution aware"],
      ["product_aware", "Product aware"],
    ),
  },
  {
    key: "storyProductBalance",
    label: "Story vs product",
    description: "Balance between narrative and product content.",
    kind: "select",
    appliesTo: AFFILIATE,
    defaultValue: "story_heavy",
    options: opts(["story_heavy", "Mostly story"], ["balanced", "Balanced"], ["product_heavy", "Mostly product"]),
  },
  {
    key: "productInfoConfidence",
    label: "Product info confidence",
    description: "How complete and verified the product data is.",
    kind: "select",
    appliesTo: AFFILIATE,
    defaultValue: "low",
    options: opts(["high", "High"], ["medium", "Medium"], ["low", "Low"]),
  },
] as const satisfies readonly ParamDefinition[];

export type ParamKey = (typeof PARAM_DEFINITIONS)[number]["key"];

export const PARAM_KEYS = PARAM_DEFINITIONS.map((d) => d.key) as ParamKey[];

const DEF_BY_KEY = new Map<string, ParamDefinition>(PARAM_DEFINITIONS.map((d) => [d.key, d]));

export function getParamDefinition(key: string): ParamDefinition | undefined {
  return DEF_BY_KEY.get(key);
}

export function paramsForMode(mode: GenerationMode): ParamDefinition[] {
  return PARAM_DEFINITIONS.filter((d) => (d.appliesTo as readonly string[]).includes(mode));
}

export function optionLabel(key: string, value: string): string {
  const def = DEF_BY_KEY.get(key);
  return def?.options.find((o) => o.value === value)?.label ?? value;
}

/** True when `value` is acceptable for the parameter (a listed option, or custom/free text where allowed). */
export function isValidParamValue(key: string, value: string): boolean {
  const def = DEF_BY_KEY.get(key);
  if (!def) return false;
  if (def.kind === "text") return value.length <= 300;
  if (def.options.some((o) => o.value === value)) return true;
  return Boolean(def.allowCustom) && value.trim().length > 0 && value.length <= 200;
}

export const paramEntrySchema = z.object({
  value: z.string().max(300),
  state: z.enum(PARAM_STATES),
  reason: z.string().max(500).optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceFacts: z.array(z.string().max(300)).max(10).optional(),
});
export type ParamEntry = z.infer<typeof paramEntrySchema>;

export const paramConfigSchema = z.record(z.string(), paramEntrySchema);
/** Map of parameter key → entry. Only keys applicable to the story's mode are present. */
export type ParamConfig = Record<string, ParamEntry>;

export function defaultParamConfig(mode: GenerationMode): ParamConfig {
  const config: ParamConfig = {};
  for (const def of paramsForMode(mode)) {
    config[def.key] = { value: def.defaultValue, state: "default" };
  }
  return config;
}

export const PARAM_STATE_LABELS: Record<ParamState, string> = {
  ai_suggested: "AI",
  user_customized: "Edited",
  locked: "Locked",
  default: "Default",
};
