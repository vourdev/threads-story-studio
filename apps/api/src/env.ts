import { z } from "zod";

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));
const bool = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(3000),

  // Core (required)
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  BETTER_AUTH_SECRET: z
    .string()
    .optional()
    .transform((v) => v || "TfkArlrSqrUmtyS8rMWJAcEGmPI0hZ/MnJ5CAjW36Cz20vPDaDszTR8XKf2uVH5k")
    .refine((v) => v.length >= 32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  /** Public base URL of this API (used for OAuth callbacks and tracked links). */
  API_BASE_URL: z
    .string()
    .optional()
    .transform((v) => {
      const trimmed = v?.trim();
      if (trimmed) return trimmed;
      if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
      if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
      return `http://localhost:${process.env.PORT || 3000}`;
    })
    .pipe(z.url()),
  /** 32-byte key, base64 encoded — encrypts stored integration tokens. */
  ENCRYPTION_KEY: z
    .string()
    .optional()
    .transform((v) => v || "nH/l+ySjzJA5xRpX/AwusljsrxRRzvD/f36fIvrZN1c=")
    .refine((v) => Buffer.from(v, "base64").length === 32, "ENCRYPTION_KEY must be 32 bytes, base64 encoded"),
  APP_SCHEME: z.string().default("threadsstory"),
  ALLOW_SIGNUP: bool,
  CLICK_IP_SALT: optionalString,

  // AI providers (optional; each is enabled only when configured)
  /** Default provider order when a workflow has no explicit choice in Settings. */
  AI_PROVIDER_PRIORITY: z
    .string()
    .default("omniroute,gemini")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s === "omniroute" || s === "gemini"),
    )
    .pipe(z.array(z.enum(["omniroute", "gemini"]))),
  GEMINI_API_KEY: optionalString,
  GEMINI_BASE_URL: z.url().default("https://generativelanguage.googleapis.com"),
  GEMINI_MODEL: z.string().default("gemini-3.8-flash"),
  GEMINI_MODEL_LITE: z.string().default("gemini-3.5-flash-lite"),
  OMNIROUTE_API_KEY: optionalString,
  OMNIROUTE_BASE_URL: optionalString,
  OMNIROUTE_MODEL: optionalString,
  /** Optional cheaper/faster OmniRoute model for analysis/suggestions; defaults to OMNIROUTE_MODEL. */
  OMNIROUTE_MODEL_FAST: optionalString,
  OMNIROUTE_MAX_CONCURRENT: z.coerce.number().int().min(1).max(10).default(1),
  OMNIROUTE_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(1000),
  AI_TIMEOUT_MS: z.coerce.number().int().min(5000).default(60000),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).default(4096),

  // Threads (direct)
  THREADS_APP_ID: optionalString,
  THREADS_APP_SECRET: optionalString,
  THREADS_REDIRECT_URI: optionalString,
  THREADS_REQUEST_INSIGHTS: bool,
  /** Development/test only: point the Graph API client at a local mock server. Ignored in production. */
  THREADS_GRAPH_BASE_URL: optionalString,

  // Buffer
  BUFFER_API_KEY: optionalString,

  // Shopee Affiliate Open API
  SHOPEE_AFFILIATE_APP_ID: optionalString,
  SHOPEE_AFFILIATE_SECRET: optionalString,
  SHOPEE_AFFILIATE_ENDPOINT: z.url().default("https://open-api.affiliate.shopee.co.id/graphql"),

  // Jobs / push
  CRON_SECRET: optionalString,
  EXPO_ACCESS_TOKEN: optionalString,
});

export type Env = z.infer<typeof schema>;

function loadEnv(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    console.error(`Invalid environment configuration:\n${issues}`);
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env = loadEnv();

export const integrations = {
  gemini: () => Boolean(env.GEMINI_API_KEY),
  omniroute: () => Boolean(env.OMNIROUTE_API_KEY && env.OMNIROUTE_BASE_URL && env.OMNIROUTE_MODEL),
  threads: () => Boolean(env.THREADS_APP_ID && env.THREADS_APP_SECRET),
  buffer: () => Boolean(env.BUFFER_API_KEY),
  shopeeAffiliate: () => Boolean(env.SHOPEE_AFFILIATE_APP_ID && env.SHOPEE_AFFILIATE_SECRET),
  cron: () => Boolean(env.CRON_SECRET),
};

export const threadsRedirectUri = () => env.THREADS_REDIRECT_URI ?? `${env.API_BASE_URL}/api/threads/oauth/callback`;
