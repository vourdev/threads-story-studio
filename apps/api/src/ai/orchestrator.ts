import { AI_PROVIDERS, type AIProviderId, type AIWorkflow } from "@tss/shared";
import { and, count, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/client";
import { aiCache, aiUsageLogs, appSettings } from "../db/schema";
import { env } from "../env";
import { sha256 } from "../security/crypto";
import { AppError } from "../security/errors";
import { log } from "../security/redact";
import { extractAndParseJson } from "./json";
import type { PromptPair } from "./prompts/v1";
import { GeminiProvider } from "./providers/gemini";
import { OmniRouteProvider } from "./providers/omniroute";
import { withRetry } from "./retry";
import { AIError, type AIProvider, type ModelTier } from "./types";

let providers: Record<AIProviderId, AIProvider> = {
  gemini: new GeminiProvider(),
  omniroute: new OmniRouteProvider(),
};

/** Test hook: swap provider implementations. */
export function setProvidersForTests(next: Partial<Record<AIProviderId, AIProvider>>) {
  providers = { ...providers, ...next } as Record<AIProviderId, AIProvider>;
}

export function providerStatuses() {
  return AI_PROVIDERS.map((id) => providers[id].status());
}

export function getProvider(id: AIProviderId): AIProvider {
  return providers[id];
}

const CACHEABLE: ReadonlySet<AIWorkflow> = new Set(["analyze", "suggest"]);
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Total time a request may spend across retries, repair and fallback (interactive budget). */
const BUDGET_MS: Record<AIWorkflow, number> = {
  analyze: 45_000,
  suggest: 45_000,
  evaluate: 45_000,
  generate: 110_000,
  refine: 90_000,
};
const TIER: Record<AIWorkflow, ModelTier> = {
  analyze: "fast",
  suggest: "fast",
  generate: "quality",
  refine: "quality",
  evaluate: "fast",
};

export type RunOptions<T> = {
  userId: string;
  workflow: AIWorkflow;
  schema: z.ZodType<T>;
  prompt: PromptPair;
  temperature?: number;
  maxOutputTokens?: number;
  /** Force a provider (e.g. "Test connection"); disables fallback. */
  provider?: AIProviderId;
  skipCache?: boolean;
  /** Override the per-workflow time budget (ms). */
  budgetMs?: number;
};

export type RunResult<T> = {
  data: T;
  provider: AIProviderId;
  model: string;
  promptVersion: string;
  cached: boolean;
};

type Settings = {
  providerByWorkflow: Record<string, AIProviderId>;
  fallbackEnabled: boolean;
  disabledProviders: string[];
  dailyGenerationLimit: number;
};

async function loadSettings(userId: string): Promise<Settings> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.userId, userId));
  return {
    providerByWorkflow: row?.providerByWorkflow ?? {},
    fallbackEnabled: row?.fallbackEnabled ?? true,
    disabledProviders: row?.disabledProviders ?? [],
    dailyGenerationLimit: row?.dailyGenerationLimit ?? 60,
  };
}

/** Ordered list of providers to try for a workflow. */
export function providerOrder(settings: Settings, workflow: AIWorkflow, forced?: AIProviderId): AIProviderId[] {
  const usable = (id: AIProviderId) => providers[id].isConfigured() && !settings.disabledProviders.includes(id);
  if (forced) return [forced];
  const preferred = settings.providerByWorkflow[workflow];
  const defaults = [
    ...env.AI_PROVIDER_PRIORITY,
    ...AI_PROVIDERS.filter((id) => !env.AI_PROVIDER_PRIORITY.includes(id)),
  ];
  const ordered = [...(preferred ? [preferred] : []), ...defaults.filter((id) => id !== preferred)].filter(usable);
  return settings.fallbackEnabled ? ordered : ordered.slice(0, 1);
}

async function assertWithinDailyLimit(userId: string, limit: number) {
  const [row] = await db
    .select({ n: count() })
    .from(aiUsageLogs)
    .where(
      and(
        eq(aiUsageLogs.userId, userId),
        eq(aiUsageLogs.cached, false),
        gt(aiUsageLogs.createdAt, sql`now() - interval '24 hours'`),
      ),
    );
  if ((row?.n ?? 0) >= limit) {
    throw new AppError(
      "quota_exhausted",
      `Daily AI request limit (${limit}) reached. Raise it in Settings or try again later.`,
    );
  }
}

function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "openapi-3.0" }) as Record<string, unknown>;
}

async function recordUsage(entry: typeof aiUsageLogs.$inferInsert) {
  try {
    await db.insert(aiUsageLogs).values(entry);
  } catch (err) {
    log.warn("ai usage log failed", { err: String(err) });
  }
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 10)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
}

/** One provider: call → parse → validate → (one repair turn) → validated data. */
async function runWithProvider<T>(
  provider: AIProvider,
  options: RunOptions<T>,
  jsonSchema: Record<string, unknown>,
  deadline: number,
): Promise<{ data: T; model: string; repaired: boolean; inputTokens?: number; outputTokens?: number }> {
  const call = (system: string, prompt: string) =>
    withRetry(
      () => {
        const remaining = deadline - Date.now();
        if (remaining < 2_000) {
          throw new AIError("timeout", "AI request deadline reached", { provider: provider.id });
        }
        return provider.complete({
          system,
          prompt,
          jsonSchema,
          tier: TIER[options.workflow],
          maxOutputTokens: options.maxOutputTokens ?? env.AI_MAX_OUTPUT_TOKENS,
          temperature: options.temperature,
          signal: AbortSignal.timeout(Math.min(env.AI_TIMEOUT_MS, remaining)),
        });
      },
      { deadline },
    );

  const first = await call(options.prompt.system, options.prompt.prompt);
  const parse = (text: string) => {
    try {
      return options.schema.safeParse(extractAndParseJson(text));
    } catch (err) {
      return {
        success: false as const,
        error: new z.ZodError([{ code: "custom", message: String(err), path: [], input: text }]),
      };
    }
  };

  const parsed = parse(first.text);
  if (parsed.success) {
    return {
      data: parsed.data,
      model: first.model,
      repaired: false,
      inputTokens: first.inputTokens,
      outputTokens: first.outputTokens,
    };
  }

  // Controlled repair: one more call that sees the validation errors (only if there is time left).
  if (deadline - Date.now() < 10_000) {
    throw new AIError(
      "invalid_output",
      `Model output failed validation: ${formatZodIssues(parsed.error).slice(0, 300)}`,
      {
        provider: provider.id,
      },
    );
  }
  const repair = await call(
    `${options.prompt.system}\n\nYour previous reply did not match the required JSON schema. Return corrected JSON only.`,
    `Validation errors:\n${formatZodIssues(parsed.error)}\n\nPrevious reply:\n${first.text.slice(0, 12000)}\n\nOriginal request:\n${options.prompt.prompt}`,
  );
  const reparsed = parse(repair.text);
  if (reparsed.success) {
    return {
      data: reparsed.data,
      model: repair.model,
      repaired: true,
      inputTokens: (first.inputTokens ?? 0) + (repair.inputTokens ?? 0),
      outputTokens: (first.outputTokens ?? 0) + (repair.outputTokens ?? 0),
    };
  }
  throw new AIError(
    "invalid_output",
    `Model output failed validation: ${formatZodIssues(reparsed.error).slice(0, 300)}`,
    {
      provider: provider.id,
    },
  );
}

function toAppError(err: AIError): AppError {
  switch (err.kind) {
    case "quota_exhausted":
      return new AppError(
        "quota_exhausted",
        "The AI provider's quota is exhausted. Try later or switch provider in Settings.",
        { cause: err },
      );
    case "rate_limited":
      return new AppError("rate_limited", "The AI provider is rate limiting requests. Please try again shortly.", {
        cause: err,
      });
    case "not_configured":
      return new AppError(
        "not_configured",
        "No AI provider is configured. Add a Gemini or OmniRoute key on the server.",
        { cause: err },
      );
    case "blocked":
      return new AppError("unsupported", "The AI provider declined this request. Try rephrasing the input.", {
        cause: err,
      });
    case "invalid_output":
      return new AppError("invalid_ai_output", "The AI returned an unusable answer. Please try again.", { cause: err });
    case "timeout":
      return new AppError("provider_unavailable", "The AI provider timed out. Please try again.", { cause: err });
    default:
      return new AppError("provider_error", "The AI provider failed to respond. Please try again.", { cause: err });
  }
}

/** Runs one AI workflow with provider selection, caching, retries, validation, fallback and usage logging. */
export async function runAI<T>(options: RunOptions<T>): Promise<RunResult<T>> {
  const settings = await loadSettings(options.userId);
  const order = providerOrder(settings, options.workflow, options.provider);
  if (order.length === 0) {
    throw new AppError("not_configured", "No AI provider is configured or enabled. Check Settings › AI providers.");
  }

  const jsonSchema = jsonSchemaFor(options.schema);
  const cacheable = CACHEABLE.has(options.workflow) && !options.skipCache && !options.provider;
  const cacheKey = sha256(
    JSON.stringify([options.workflow, options.prompt.version, options.prompt.system, options.prompt.prompt]),
  );

  if (cacheable) {
    const [hit] = await db
      .select()
      .from(aiCache)
      .where(and(eq(aiCache.key, cacheKey), gt(aiCache.expiresAt, new Date())));
    const valid = hit ? options.schema.safeParse(hit.response) : null;
    if (hit && valid?.success) {
      await recordUsage({
        userId: options.userId,
        provider: hit.provider,
        model: hit.model,
        workflow: options.workflow,
        promptVersion: options.prompt.version,
        latencyMs: 0,
        status: "success",
        cached: true,
      });
      return {
        data: valid.data,
        provider: hit.provider as AIProviderId,
        model: hit.model,
        promptVersion: options.prompt.version,
        cached: true,
      };
    }
  }

  await assertWithinDailyLimit(options.userId, settings.dailyGenerationLimit);

  let lastError: AIError | undefined;
  const deadline = Date.now() + (options.budgetMs ?? BUDGET_MS[options.workflow]);
  for (const id of order) {
    if (lastError && deadline - Date.now() < 8_000) break; // no time left for a meaningful fallback
    const provider = providers[id];
    const started = Date.now();
    try {
      const result = await runWithProvider(provider, options, jsonSchema, deadline);
      await recordUsage({
        userId: options.userId,
        provider: id,
        model: result.model,
        workflow: options.workflow,
        promptVersion: options.prompt.version,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: Date.now() - started,
        status: "success",
        repaired: result.repaired,
      });
      if (cacheable) {
        await db
          .insert(aiCache)
          .values({
            key: cacheKey,
            workflow: options.workflow,
            response: result.data as object,
            provider: id,
            model: result.model,
            expiresAt: new Date(Date.now() + CACHE_TTL_MS),
          })
          .onConflictDoNothing();
      }
      return {
        data: result.data,
        provider: id,
        model: result.model,
        promptVersion: options.prompt.version,
        cached: false,
      };
    } catch (err) {
      const aiErr = err instanceof AIError ? err : new AIError("transient", String(err), { provider: id, cause: err });
      await recordUsage({
        userId: options.userId,
        provider: id,
        model: provider.status().models?.[TIER[options.workflow]] ?? "unknown",
        workflow: options.workflow,
        promptVersion: options.prompt.version,
        latencyMs: Date.now() - started,
        status: "error",
        errorCode: aiErr.kind,
      });
      log.warn("ai provider failed", {
        provider: id,
        workflow: options.workflow,
        kind: aiErr.kind,
        status: aiErr.status,
      });
      lastError = aiErr;
      if (!aiErr.fallbackEligible) break;
    }
  }
  throw toAppError(lastError ?? new AIError("not_configured", "No provider", { provider: "orchestrator" }));
}
