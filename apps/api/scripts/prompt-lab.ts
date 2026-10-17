/**
 * Live prompt check against the configured AI providers (uses real quota).
 *   npx tsx --env-file=.env scripts/prompt-lab.ts [general|affiliate] [gemini|omniroute]
 */

import type { AIProviderId } from "@tss/shared";
import { applySuggestions, defaultParamConfig, resolveParams } from "@tss/shared";

import { runAI } from "../src/ai/orchestrator";
import {
  analyzeTopicPrompt,
  chatRevisionPrompt,
  evaluateStoryPrompt,
  generateStoriesPrompt,
  suggestParametersPrompt,
} from "../src/ai/prompts/v1";
import {
  chatRevisionSchema,
  generatedStoriesSchema,
  parameterSuggestionsSchema,
  storyEvaluationSchema,
  topicAnalysisSchema,
} from "../src/ai/schemas";
import { sanitizeSuggestions } from "../src/ai/service";
import { db, pgClient } from "../src/db/client";
import { users } from "../src/db/schema";

const provider = process.argv[3] as AIProviderId | undefined;
const LAB_USER = "prompt-lab";
await db
  .insert(users)
  .values({ id: LAB_USER, name: "Prompt lab", email: "prompt-lab@local.invalid" })
  .onConflictDoNothing();

const rawInput =
  "Akhirnya saya mendapatkan pekerjaan baru setelah berkali-kali gagal interview. Dulu saya sering merasa tidak cukup bagus, tetapi saya terus belajar sampai akhirnya diterima.";
const t0 = Date.now();
const lap = (label: string) => console.log(`\n=== ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

const analysis = await runAI({
  userId: LAB_USER,
  workflow: "analyze",
  schema: topicAnalysisSchema,
  prompt: analyzeTopicPrompt({ rawInput, clarifications: [] }),
  provider,
  skipCache: true,
});
lap(`analysis via ${analysis.provider}/${analysis.model}`);
console.log(JSON.stringify(analysis.data, null, 2));

const current = defaultParamConfig("general");
const suggestions = await runAI({
  userId: LAB_USER,
  workflow: "suggest",
  schema: parameterSuggestionsSchema,
  prompt: suggestParametersPrompt({ mode: "general", rawInput, topicAnalysis: analysis.data, current }),
  provider,
  skipCache: true,
});
const params = applySuggestions("general", current, sanitizeSuggestions("general", suggestions.data.suggestions));
lap(`suggestions via ${suggestions.provider}`);
console.log(
  Object.entries(params)
    .map(([k, v]) => `${k} = ${v.value} [${v.state}] ${v.reason ?? ""}`)
    .join("\n"),
);

const stories = await runAI({
  userId: LAB_USER,
  workflow: "generate",
  schema: generatedStoriesSchema,
  prompt: generateStoriesPrompt({
    mode: "general",
    rawInput,
    clarifications: [],
    topicAnalysis: analysis.data,
    params: resolveParams(params),
    count: 3,
  }),
  provider,
  temperature: 0.9,
  maxOutputTokens: 8192,
});
lap(`stories via ${stories.provider}/${stories.model}`);
for (const v of stories.data.variations) {
  console.log(`\n--- ${v.strategy} | ${v.angle}\nwarnings: ${v.warnings.join("; ")}`);
  for (const [i, p] of v.posts.entries()) console.log(`[${i + 1}] (${p.text.length}) ${p.text}`);
}

const first = stories.data.variations[0];
if (first) {
  const evaluation = await runAI({
    userId: LAB_USER,
    workflow: "evaluate",
    schema: storyEvaluationSchema,
    prompt: evaluateStoryPrompt({ posts: first.posts, rawInput, userFacts: analysis.data.userFacts }),
    provider,
  });
  lap("evaluation of variation 1");
  console.log(JSON.stringify(evaluation.data, null, 2));

  for (const message of [
    "hook-nya kurang nendang, bikin lebih bikin penasaran. post terakhir ganti jadi pertanyaan buat pembaca",
    "tambahin nama perusahaannya dan gaji saya biar lebih meyakinkan",
  ]) {
    const chat = await runAI({
      userId: LAB_USER,
      workflow: "refine",
      schema: chatRevisionSchema,
      prompt: chatRevisionPrompt({
        mode: "general",
        message,
        history: [],
        posts: first.posts,
        params: resolveParams(params),
        rawInput,
        userFacts: analysis.data.userFacts,
      }),
      provider,
    });
    lap(`chat: "${message}" → ${chat.data.action}`);
    console.log(`reply: ${chat.data.reply}`);
    for (const [i, p] of chat.data.posts.entries()) console.log(`[${i + 1}] ${p.text}`);
  }
}
await pgClient.end();
