import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "../env";
import * as schema from "./schema";

declare global {
  var __tssSql: postgres.Sql | undefined;
}

// Reuse one pool per process (dev hot reload, warm serverless instances).
const sql =
  globalThis.__tssSql ??
  postgres(env.DATABASE_URL, {
    max: env.DATABASE_POOL_MAX,
    prepare: false, // compatible with transaction-mode poolers (Neon pooled URL)
    idle_timeout: 20,
    onnotice: () => undefined,
  });
globalThis.__tssSql = sql;

export const db = drizzle(sql, { schema, casing: "snake_case" });
export type DB = typeof db;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export { sql as pgClient };
