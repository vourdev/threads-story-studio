import { env } from "../../env";
import { RequestGate } from "../gate";
import {
  AIError,
  type AIProvider,
  type CompletionRequest,
  type CompletionResult,
  classifyFetchFailure,
  classifyHttpError,
  type ProviderStatus,
} from "../types";

/** Accepts a host root, `.../v1` or `.../v1/chat/completions` (same rules as backend-vour-carousels). */
export function cleanBaseUrl(url: string): string {
  let cleaned = url.trim().replace(/\/+$/, "");
  if (cleaned.endsWith("/chat/completions")) cleaned = cleaned.slice(0, -"/chat/completions".length);
  if (!cleaned.endsWith("/v1") && !cleaned.includes("/v1/")) cleaned = `${cleaned}/v1`;
  return cleaned;
}

type ChatCompletion = {
  model?: string;
  choices?: { message?: { content?: string | null }; delta?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/** OmniRoute may answer with SSE even for non-streaming calls; collapse deltas into one message. */
export function collapseSse(raw: string): ChatCompletion {
  let content = "";
  let model: string | undefined;
  let usage: ChatCompletion["usage"];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:") || trimmed.includes("[DONE]")) continue;
    try {
      const chunk = JSON.parse(trimmed.slice(5).trim()) as ChatCompletion;
      model = chunk.model ?? model;
      usage = chunk.usage ?? usage;
      content += chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? "";
    } catch {
      // ignore malformed chunk
    }
  }
  return { model, usage, choices: [{ message: { content } }] };
}

const gate = new RequestGate(() => ({
  maxConcurrent: env.OMNIROUTE_MAX_CONCURRENT,
  minIntervalMs: env.OMNIROUTE_MIN_INTERVAL_MS,
}));

const JSON_INSTRUCTION =
  "\n\nIMPORTANT: Return ONLY valid JSON matching this JSON schema. No markdown code fences, no commentary.\nSchema:\n";

export class OmniRouteProvider implements AIProvider {
  readonly id = "omniroute" as const;

  isConfigured() {
    return Boolean(env.OMNIROUTE_API_KEY && env.OMNIROUTE_BASE_URL && env.OMNIROUTE_MODEL);
  }

  status(): ProviderStatus {
    const model = env.OMNIROUTE_MODEL ?? "";
    return {
      id: this.id,
      configured: this.isConfigured(),
      models: this.isConfigured() ? { quality: model, fast: env.OMNIROUTE_MODEL_FAST ?? model } : null,
      // OmniRoute combos reject `response_format`; JSON is requested in the prompt and validated after.
      structuredOutput: "prompted",
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!this.isConfigured() || !env.OMNIROUTE_BASE_URL || !env.OMNIROUTE_MODEL || !env.OMNIROUTE_API_KEY) {
      throw new AIError("not_configured", "OmniRoute is not configured", { provider: this.id });
    }
    const model = request.tier === "fast" ? (env.OMNIROUTE_MODEL_FAST ?? env.OMNIROUTE_MODEL) : env.OMNIROUTE_MODEL;
    const system = request.jsonSchema
      ? `${request.system}${JSON_INSTRUCTION}${JSON.stringify(request.jsonSchema)}`
      : request.system;
    const body = {
      model,
      stream: false,
      max_tokens: request.maxOutputTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: request.prompt },
      ],
    };
    const apiKey = env.OMNIROUTE_API_KEY;
    const url = `${cleanBaseUrl(env.OMNIROUTE_BASE_URL)}/chat/completions`;

    return gate.run(async () => {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: request.signal,
        });
      } catch (err) {
        throw classifyFetchFailure(this.id, err);
      }
      const raw = await response.text();
      if (!response.ok) throw classifyHttpError(this.id, response.status, raw, response.headers.get("retry-after"));

      let data: ChatCompletion;
      if ((response.headers.get("content-type") ?? "").includes("text/event-stream") || raw.startsWith("data:")) {
        data = collapseSse(raw);
      } else {
        try {
          data = JSON.parse(raw) as ChatCompletion;
        } catch (err) {
          throw new AIError("transient", "OmniRoute returned a non-JSON envelope", { provider: this.id, cause: err });
        }
      }
      const text = data.choices?.[0]?.message?.content ?? "";
      if (!text.trim()) throw new AIError("invalid_output", "OmniRoute returned an empty reply", { provider: this.id });
      return {
        text,
        model: data.model ?? model,
        inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens,
      };
    });
  }
}
