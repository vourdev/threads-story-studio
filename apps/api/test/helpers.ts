import { sql } from "drizzle-orm";

import { db } from "../src/db/client";
import { users } from "../src/db/schema";

export async function resetDb() {
  await db.execute(sql`
    truncate table users, ai_cache, rate_limit_buckets restart identity cascade
  `);
}

export async function createUser(id = crypto.randomUUID()) {
  await db.insert(users).values({ id, name: "Test", email: `${id}@test.local` });
  return id;
}

/** Fetch stub routed by URL substring. Records calls. */
export function routeFetch(
  routes: [match: string | RegExp, handler: (url: string, init?: RequestInit) => Response | Promise<Response>][],
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    for (const [match, handler] of routes) {
      if (typeof match === "string" ? url.includes(match) : match.test(url)) return handler(url, init);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { impl, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
