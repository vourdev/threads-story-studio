import { z } from "zod";

const text = (max = 600) => z.string().max(max);
const list = (maxItems = 10, max = 300) => z.array(z.string().max(max)).max(maxItems);

export const topicAnalysisSchema = z.object({
  coreMessage: text(),
  mainTheme: text(200),
  narrativePremise: text(),
  emotionalJourney: text(),
  conflict: text().describe("Conflict or tension; empty string if none is present in the input"),
  turningPoint: text().describe("Turning point; empty string if the input does not contain one"),
  resolution: text().describe("Resolution or takeaway"),
  targetAudiences: list(5, 120),
  recommendedAngle: text(200),
  recommendedHookStrategy: text(300),
  recommendedWritingStyle: text(200),
  recommendedObjective: text(200),
  suggestedLength: z.enum(["single_post", "short", "medium", "long", "multi_post"]),
  suggestedEnding: text(200),
  userFacts: list(20, 300).describe("Facts explicitly stated by the user, quoted or closely paraphrased"),
  missingDetails: list(10).describe("Details a story might want but that the user did NOT supply; never invent them"),
  clarifyingQuestions: list(4).describe("Only questions that would materially improve the story"),
  inputSufficiency: z.enum(["sufficient", "thin", "insufficient"]),
});
export type TopicAnalysis = z.infer<typeof topicAnalysisSchema>;

export const productAnalysisSchema = z.object({
  productName: text(300),
  category: text(120),
  description: text(1000),
  benefits: list(10).describe("Only benefits supported by the provided product data"),
  features: list(15),
  customerProblems: list(8),
  targetAudiences: list(6, 120),
  useCases: list(8),
  differentiators: list(6).describe("Only differentiators supported by the provided data"),
  claimsNeedingVerification: list(10),
  recommendedAngles: list(5),
  dataSufficiency: z.enum(["high", "medium", "low"]),
  comparisonSupported: z.boolean().describe("True only if the data contains concrete comparable attributes"),
});
export type ProductAnalysis = z.infer<typeof productAnalysisSchema>;

export const parameterSuggestionsSchema = z.object({
  suggestions: z
    .array(
      z.object({
        key: z.string().max(60),
        value: z.string().max(300),
        reason: z.string().max(300),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(30),
});
export type ParameterSuggestionsOutput = z.infer<typeof parameterSuggestionsSchema>;

const postSchema = z.object({ text: z.string().min(1).max(2000) });

export const generatedStoriesSchema = z.object({
  variations: z
    .array(
      z.object({
        strategy: text(120).describe("Short name of the storytelling strategy, e.g. 'Emotional & relatable'"),
        angle: text(200),
        hook: text(500).describe("The opening line"),
        rationale: text(400).describe("Why this variation is different from the others"),
        posts: z.array(postSchema).min(1).max(12),
        cta: text(300).describe("Call to action line for affiliate stories; empty string otherwise"),
        usedFacts: list(20),
        warnings: list(6).describe("Anything the user should double-check before publishing"),
      }),
    )
    .min(1)
    .max(5),
});
export type GeneratedStories = z.infer<typeof generatedStoriesSchema>;

export const refinedStorySchema = z.object({
  posts: z.array(postSchema).min(1).max(12),
  cta: text(300),
  changeSummary: text(300),
  warnings: list(6),
});
export type RefinedStory = z.infer<typeof refinedStorySchema>;

export const selectionRewriteSchema = z.object({
  replacement: z.string().min(1).max(2000),
  changeSummary: text(300),
});
export type SelectionRewrite = z.infer<typeof selectionRewriteSchema>;

export const storyEvaluationSchema = z.object({
  hookStrength: z.number().int().min(1).max(10),
  readability: z.number().int().min(1).max(10),
  unsupportedClaims: list(10).describe("Statements not supported by the user's facts or verified product data"),
  fabricationRisk: z.enum(["low", "medium", "high"]),
  misleadingPromotion: list(6).describe("False urgency, fake scarcity, fake discounts, invented reviews"),
  suggestions: list(5),
});
export type StoryEvaluation = z.infer<typeof storyEvaluationSchema>;

export const chatRevisionSchema = z.object({
  action: z
    .enum(["revise", "answer", "clarify"])
    .describe(
      "revise = story changed; answer = question answered, story unchanged; clarify = need info before changing",
    ),
  reply: z.string().min(1).max(1200).describe("Short conversational reply to the user, in the user's language"),
  posts: z.array(postSchema).max(12).describe("Full updated story when action=revise; empty array otherwise"),
  cta: text(300).describe("Updated CTA for affiliate stories (unchanged unless asked); empty string otherwise"),
  changeSummary: text(300),
  newFacts: list(10).describe("New facts about the user's experience stated in this chat message"),
  warnings: list(6),
});
export type ChatRevision = z.infer<typeof chatRevisionSchema>;
