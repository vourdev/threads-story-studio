import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "../env";
import * as schema from "./schema";

declare global {
  var __tssSql: postgres.Sql | undefined;
}

/** Transaction-mode poolers reject named prepared statements; everything else benefits from them. */
export function preparedStatementsEnabled(url: string, override?: boolean): boolean {
  if (override !== undefined) return override;
  try {
    const u = new URL(url);
    const pooled = u.port === "6543" || u.hostname.includes("-pooler") || u.searchParams.get("pgbouncer") === "true";
    return !pooled;
  } catch {
    return false;
  }
}

// Reuse one pool per process (dev hot reload, warm serverless instances).
const sql =
  globalThis.__tssSql ??
  postgres(env.DATABASE_URL, {
    max: env.DATABASE_POOL_MAX,
    prepare: preparedStatementsEnabled(env.DATABASE_URL, env.DATABASE_PREPARE),
    idle_timeout: 20,
    onnotice: () => undefined,
    ...(env.LOG_SQL && env.NODE_ENV !== "production"
      ? { debug: (_conn: number, query: string) => console.log(`[sql] ${query.replace(/\s+/g, " ").slice(0, 160)}`) }
      : {}),
  });
globalThis.__tssSql = sql;

export const db = drizzle(sql, { schema, casing: "snake_case" });
export type DB = typeof db;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export { sql as pgClient };
