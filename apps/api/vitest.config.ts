import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    // DB-backed tests share one database: run files sequentially.
    fileParallelism: false,
    testTimeout: 20_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: process.env.DATABASE_URL_TEST ?? "postgres://localhost:5432/threads_story_studio_test",
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123456",
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      API_BASE_URL: "http://localhost:3000",
      CRON_SECRET: "cron-test-secret",
      // Providers are faked in tests; keys only mark them "configured". No live calls are made.
      GEMINI_API_KEY: "test-gemini",
      OMNIROUTE_API_KEY: "test-omni",
      OMNIROUTE_BASE_URL: "http://omniroute.test",
      OMNIROUTE_MODEL: "test-combo",
      AI_PROVIDER_PRIORITY: "omniroute,gemini",
      THREADS_APP_ID: "123",
      THREADS_APP_SECRET: "threads-secret",
      BUFFER_API_KEY: "buffer-key",
    },
  },
});
