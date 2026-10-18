import { expo } from "@better-auth/expo";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { count } from "drizzle-orm";

import { db } from "../db/client";
import * as schema from "../db/schema";
import { env } from "../env";

/** Multi-user SaaS sign-up: open by default unless explicitly disabled with ALLOW_SIGNUP=false. */
export async function isSignupOpen(): Promise<boolean> {
  if (env.ALLOW_SIGNUP === false) {
    const [row] = await db.select({ n: count() }).from(schema.users);
    return (row?.n ?? 0) === 0;
  }
  return true;
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
  user: {
    additionalFields: {
      role: {
        type: "string",
        defaultValue: "user",
        input: false,
      },
      onboardingCompleted: {
        type: "boolean",
        defaultValue: false,
        input: false,
      },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    // Signed session snapshot in a cookie: most requests skip the session/user lookups entirely.
    // A revoked session stays usable for at most this long.
    cookieCache: { enabled: true, maxAge: 5 * 60 },
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
          const [row] = await db.select({ n: count() }).from(schema.users);
          const isFirstUser = (row?.n ?? 0) === 0;
          return {
            data: {
              ...user,
              role: isFirstUser ? "admin" : "user",
              onboardingCompleted: false,
            },
          };
        },
        after: async (user) => {
          try {
            await db.insert(schema.appSettings).values({ userId: user.id }).onConflictDoNothing();
            await db.insert(schema.userWritingProfiles).values({
              userId: user.id,
              displayName: user.name,
            }).onConflictDoNothing();
          } catch (err) {
            console.error("Failed to seed initial user profile/settings:", err);
          }
        },
      },
    },
  },
});

export type AuthSession = typeof auth.$Infer.Session;
