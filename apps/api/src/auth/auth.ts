import { expo } from "@better-auth/expo";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { count } from "drizzle-orm";

import { db } from "../db/client";
import * as schema from "../db/schema";
import { env } from "../env";

/** First account becomes the owner; afterwards sign-up is closed unless ALLOW_SIGNUP=true. */
export async function isSignupOpen(): Promise<boolean> {
  if (env.ALLOW_SIGNUP) return true;
  const [row] = await db.select({ n: count() }).from(schema.users);
  return (row?.n ?? 0) === 0;
}

export const auth = betterAuth({
  baseURL: env.API_BASE_URL,
  basePath: "/api/auth",
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    usePlural: true,
    schema: {
      users: schema.users,
      sessions: schema.sessions,
      accounts: schema.accounts,
      verifications: schema.verifications,
    },
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    maxPasswordLength: 128,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  trustedOrigins: [
    `${env.APP_SCHEME}://`,
    ...(env.NODE_ENV === "development" ? ["exp://", "exp://**", "http://localhost:8081"] : []),
  ],
  advanced: {
    useSecureCookies: env.API_BASE_URL.startsWith("https://"),
    database: { generateId: () => crypto.randomUUID() },
  },
  telemetry: { enabled: false },
  plugins: [expo()],
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (!(await isSignupOpen())) {
            throw new APIError("FORBIDDEN", { message: "Sign-up is closed for this workspace." });
          }
          return { data: user };
        },
      },
    },
  },
});

export type AuthSession = typeof auth.$Infer.Session;
