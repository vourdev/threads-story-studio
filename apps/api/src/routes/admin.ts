import { count, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { type AuthedEnv, requireAdmin, requireUser } from "../auth/require-user";
import { db } from "../db/client";
import { products, publications, stories, users } from "../db/schema";
import { validate } from "../lib/validate";
import { AppError } from "../security/errors";

export const adminRoutes = new Hono<AuthedEnv>()
  .use(requireUser)
  .use(requireAdmin)
  .get("/overview", async (c) => {
    const [userCount] = await db.select({ total: count() }).from(users);
    const [storyCount] = await db.select({ total: count() }).from(stories);
    const [pubCount] = await db.select({ total: count() }).from(publications);
    const [prodCount] = await db.select({ total: count() }).from(products);

    return c.json({
      overview: {
        totalUsers: Number(userCount?.total ?? 0),
        totalStories: Number(storyCount?.total ?? 0),
        totalPublications: Number(pubCount?.total ?? 0),
        totalProducts: Number(prodCount?.total ?? 0),
      },
    });
  })
  .get("/users", async (c) => {
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        image: users.image,
        onboardingCompleted: users.onboardingCompleted,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt))
      .limit(100);

    return c.json({ users: rows });
  })
  .patch(
    "/users/:id/role",
    validate("param", z.object({ id: z.string() })),
    validate("json", z.object({ role: z.enum(["user", "admin"]) })),
    async (c) => {
      const targetUserId = c.req.valid("param").id;
      const { role } = c.req.valid("json");
      const currentAdminId = c.get("user").id;

      if (targetUserId === currentAdminId && role !== "admin") {
        throw new AppError("bad_request", "You cannot demote yourself from admin.");
      }

      const [updated] = await db
        .update(users)
        .set({ role })
        .where(eq(users.id, targetUserId))
        .returning();

      if (!updated) throw new AppError("not_found", "User not found.");

      return c.json({
        user: {
          id: updated.id,
          name: updated.name,
          email: updated.email,
          role: updated.role,
        },
      });
    },
  );
