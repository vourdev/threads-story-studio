import { env } from "../../env";
import {
  AIError,
  type AIProvider,
  type CompletionRequest,
  type CompletionResult,
  classifyFetchFailure,
  classifyHttpError,
  type ProviderStatus,
} from "../types";

/** Keys accepted by Gemini's `responseSchema` (OpenAPI 3.0 subset). Anything else is dropped. */
const ALLOWED_SCHEMA_KEYS = new Set([
  "type",
  "format",
  "description",
  "nullable",
  "enum",
  "maxItems",
  "minItems",
  "properties",
  "required",
  "items",
  "anyOf",
  "minimum",
  "maximum",
  "propertyOrdering",
]);

/** Reduces a JSON schema (from `z.toJSONSchema(..., { target: "openapi-3.0" })`) to what Gemini accepts. */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) continue;
    if (key === "properties" && value && typeof value === "object") {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toGeminiSchema(v)]));
      out.propertyOrdering = Object.keys(value);
    } else if (key === "items" || key === "anyOf") {
      out[key] = toGeminiSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
};

export class GeminiProvider implements AIProvider {
  readonly id = "gemini" as const;

  isConfigured() {
    return Boolean(env.GEMINI_API_KEY);
  }

  status(): ProviderStatus {
    return {
      id: this.id,
      configured: this.isConfigured(),
      models: this.isConfigured() ? { quality: env.GEMINI_MODEL, fast: env.GEMINI_MODEL_LITE } : null,
      structuredOutput: "native",
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!env.GEMINI_API_KEY) {
      throw new AIError("not_configured", "Gemini is not configured", { provider: this.id });
    }
    const model = request.tier === "fast" ? env.GEMINI_MODEL_LITE : env.GEMINI_MODEL;
    const url = `${env.GEMINI_BASE_URL.replace(/\/+$/, "")}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: "user", parts: [{ text: request.prompt }] }],
      generationConfig: {
        maxOutputTokens: request.maxOutputTokens,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.jsonSchema
          ? { responseMimeType: "application/json", responseSchema: toGeminiSchema(request.jsonSchema) }
          : {}),
      },
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (err) {
      throw classifyFetchFailure(this.id, err);
    }

    const raw = await response.text();
    if (!response.ok) throw classifyHttpError(this.id, response.status, raw, response.headers.get("retry-after"));

    let data: GeminiResponse;
    try {
      data = JSON.parse(raw) as GeminiResponse;
    } catch (err) {
      throw new AIError("transient", "Gemini returned a non-JSON envelope", { provider: this.id, cause: err });
    }
    if (data.promptFeedback?.blockReason) {
      throw new AIError("blocked", `Gemini blocked the request (${data.promptFeedback.blockReason})`, {
        provider: this.id,
      });
    }
    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    if (!text) {
      const reason = candidate?.finishReason ?? "EMPTY";
      throw new AIError(reason === "SAFETY" ? "blocked" : "invalid_output", `Gemini returned no text (${reason})`, {
        provider: this.id,
      });
    }
    return {
      text,
      model: data.modelVersion ?? model,
      inputTokens: data.usageMetadata?.promptTokenCount,
      outputTokens: data.usageMetadata?.candidatesTokenCount,
    };
  }
}
