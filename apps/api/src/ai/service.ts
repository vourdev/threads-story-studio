import {
  type GenerationMode,
  isValidParamValue,
  type ParamConfig,
  type ParamSuggestions,
  paramsForMode,
} from "@tss/shared";

import { runAI } from "./orchestrator";
import {
  analyzeProductPrompt,
  analyzeTopicPrompt,
  chatRevisionPrompt,
  evaluateStoryPrompt,
  generateStoriesPrompt,
  inferProductPrompt,
  type ProductFacts,
  refineStoryPrompt,
  rewriteSelectionPrompt,
  suggestParametersPrompt,
} from "./prompts/v1";
import {
  chatRevisionSchema,
  generatedStoriesSchema,
  inferProductSchema,
  type ProductAnalysis,
  parameterSuggestionsSchema,
  productAnalysisSchema,
  refinedStorySchema,
  selectionRewriteSchema,
  storyEvaluationSchema,
  type TopicAnalysis,
  topicAnalysisSchema,
} from "./schemas";

/**
 * Story-level AI operations. Vendor-neutral: everything goes through `runAI`,
 * which picks the provider, validates output and logs usage.
 */
export const ai = {
  analyzeTopic(userId: string, input: Parameters<typeof analyzeTopicPrompt>[0]) {
    return runAI({
      userId,
      workflow: "analyze",
      schema: topicAnalysisSchema,
      prompt: analyzeTopicPrompt(input),
      temperature: 0.3,
    });
  },

  analyzeProduct(userId: string, input: { product: ProductFacts; shopeeUrl: string }) {
    return runAI({
      userId,
      workflow: "analyze",
      schema: productAnalysisSchema,
      prompt: analyzeProductPrompt(input),
      temperature: 0.2,
    });
  },

  inferProduct(userId: string, input: Parameters<typeof inferProductPrompt>[0]) {
    return runAI({
      userId,
      workflow: "analyze",
      schema: inferProductSchema,
      prompt: inferProductPrompt(input),
      temperature: 0.3,
    });
  },

  async suggestParameters(
    userId: string,
    input: {
      mode: GenerationMode;
      rawInput: string;
      topicAnalysis?: TopicAnalysis | null;
      productAnalysis?: ProductAnalysis | null;
      current: ParamConfig;
    },
  ) {
    const result = await runAI({
      userId,
      workflow: "suggest",
      schema: parameterSuggestionsSchema,
      prompt: suggestParametersPrompt(input),
      temperature: 0.2,
    });
    return { ...result, data: sanitizeSuggestions(input.mode, result.data.suggestions, input.productAnalysis) };
  },

  generateStories(userId: string, input: Parameters<typeof generateStoriesPrompt>[0]) {
    return runAI({
      userId,
      workflow: "generate",
      schema: generatedStoriesSchema,
      prompt: generateStoriesPrompt(input),
      temperature: 0.9,
      maxOutputTokens: 8192,
    });
  },

  refineStory(userId: string, input: Parameters<typeof refineStoryPrompt>[0]) {
    return runAI({
      userId,
      workflow: "refine",
      schema: refinedStorySchema,
      prompt: refineStoryPrompt(input),
      temperature: 0.7,
    });
  },

  rewriteSelection(userId: string, input: Parameters<typeof rewriteSelectionPrompt>[0]) {
    return runAI({
      userId,
      workflow: "refine",
      schema: selectionRewriteSchema,
      prompt: rewriteSelectionPrompt(input),
      temperature: 0.7,
    });
  },

  chatRevision(userId: string, input: Parameters<typeof chatRevisionPrompt>[0]) {
    return runAI({
      userId,
      workflow: "refine",
      schema: chatRevisionSchema,
      prompt: chatRevisionPrompt(input),
      temperature: 0.6,
    });
  },

  evaluateStory(userId: string, input: Parameters<typeof evaluateStoryPrompt>[0]) {
    return runAI({
      userId,
      workflow: "evaluate",
      schema: storyEvaluationSchema,
      prompt: evaluateStoryPrompt(input),
      temperature: 0,
    });
  },
};

/**
 * Keeps only suggestions for known, applicable parameters with valid values.
 * Comparison strategy is rejected in code (not just in the prompt) when the data cannot support it.
 */
export function sanitizeSuggestions(
  mode: GenerationMode,
  suggestions: { key: string; value: string; reason: string; confidence: number }[],
  productAnalysis?: ProductAnalysis | null,
): ParamSuggestions {
  const applicable = new Set(paramsForMode(mode).map((d) => d.key));
  const out: ParamSuggestions = {};
  for (const s of suggestions) {
    if (!applicable.has(s.key) || !isValidParamValue(s.key, s.value)) continue;
    if (s.key === "productIntroStrategy" && s.value === "compare_attributes" && !productAnalysis?.comparisonSupported) {
      continue;
    }
    out[s.key] = { value: s.value, reason: s.reason, confidence: s.confidence };
  }
  if (mode === "affiliate" && productAnalysis) {
    out.productInfoConfidence = {
      value: productAnalysis.dataSufficiency,
      reason: "Derived from how complete and verified the product data is.",
      confidence: 1,
    };
  }
  return out;
}
