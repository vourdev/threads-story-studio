/**
 * E2E helper (development only): attaches a fake Threads account to a user so the publish flow can be
 * exercised against a local mock Graph server (THREADS_GRAPH_BASE_URL). Never use against production.
 *   npx tsx --env-file=.env scripts/e2e-seed-threads.ts owner@example.com
 */
import { eq } from "drizzle-orm";

import { db, pgClient } from "../src/db/client";
import { connectedAccounts, users } from "../src/db/schema";
import { env } from "../src/env";
import { encryptSecret } from "../src/security/crypto";

if (env.NODE_ENV === "production") throw new Error("Refusing to seed fake accounts in production");
const email = process.argv[2];
if (!email) throw new Error("Usage: e2e-seed-threads.ts <email>");
const [user] = await db.select().from(users).where(eq(users.email, email));
if (!user) throw new Error(`No user ${email}`);
const values = {
  userId: user.id,
  provider: "threads" as const,
  externalAccountId: "424242",
  username: "e2e_tester",
  displayName: "E2E Tester",
  scopes: ["threads_basic", "threads_content_publish"],
  encryptedToken: encryptSecret("e2e-token"),
  tokenIssuedAt: new Date(),
  tokenExpiresAt: new Date(Date.now() + 60 * 86_400_000),
  status: "connected" as const,
  statusMessage: null,
};
await db
  .insert(connectedAccounts)
  .values(values)
  .onConflictDoUpdate({ target: [connectedAccounts.userId, connectedAccounts.provider], set: values });
console.log(`Seeded fake Threads account for ${email}`);
await pgClient.end();
