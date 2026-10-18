import { createMiddleware } from "hono/factory";

import { AppError } from "../security/errors";
import { type AuthSession, auth } from "./auth";

export type AuthedEnv = {
  Variables: {
    user: AuthSession["user"];
    session: AuthSession["session"];
  };
};

/** Rejects unauthenticated requests. Every non-public route must sit behind this middleware. */
export const requireUser = createMiddleware<AuthedEnv>(async (c, next) => {
  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!result) throw new AppError("unauthorized", "Please sign in to continue.");
  c.set("user", result.user);
  c.set("session", result.session);
  await next();
});

/** Rejects non-admin requests. Protects platform administration endpoints. */
export const requireAdmin = createMiddleware<AuthedEnv>(async (c, next) => {
  const user = c.get("user") as AuthSession["user"] & { role?: string };
  if (!user || user.role !== "admin") {
    throw new AppError("forbidden", "Administrator access required.");
  }
  await next();
});

