import { onboardingInput } from "@tss/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { type AuthedEnv, requireUser } from "../auth/require-user";
import { db } from "../db/client";
import {
  affiliateLinks,
  appSettings,
  connectedAccounts,
  devices,
  products,
  publications,
  stories,
  users,
  userWritingProfiles,
} from "../db/schema";
import { validate } from "../lib/validate";
import { AppError } from "../security/errors";

export const userProfileRoutes = new Hono<AuthedEnv>()
  .use(requireUser)
  .get("/me", async (c) => {
    const sessionUser = c.get("user");
    const [row] = await db.select().from(users).where(eq(users.id, sessionUser.id));
    if (!row) throw new AppError("not_found", "User not found.");
    return c.json({
      user: {
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        image: row.image,
        onboardingCompleted: row.onboardingCompleted,
        createdAt: row.createdAt,
      },
    });
  })
  .patch(
    "/profile",
    validate(
      "json",
      z.object({
        name: z.string().trim().min(1).max(100).optional(),
        image: z.string().url().max(1000).optional().nullable(),
      }),
    ),
    async (c) => {
      const userId = c.get("user").id;
      const input = c.req.valid("json");
      const [updated] = await db
        .update(users)
        .set({
          ...(input.name ? { name: input.name } : {}),
          ...(input.image !== undefined ? { image: input.image } : {}),
        })
        .where(eq(users.id, userId))
        .returning();
      if (!updated) throw new AppError("not_found", "User not found.");
      return c.json({
        user: {
          id: updated.id,
          email: updated.email,
          name: updated.name,
          role: updated.role,
          image: updated.image,
          onboardingCompleted: updated.onboardingCompleted,
        },
      });
    },
  )
  .post("/onboarding", validate("json", onboardingInput), async (c) => {
    const userId = c.get("user").id;
    const input = c.req.valid("json");

    await db
      .update(users)
      .set({ onboardingCompleted: input.completed ?? true })
      .where(eq(users.id, userId));

    if (input.displayName || input.preferredLanguage || input.writingStyle || input.tone || input.targetAudience) {
      await db
        .insert(userWritingProfiles)
        .values({
          userId,
          displayName: input.displayName,
          preferredLanguage: input.preferredLanguage ?? "id_casual",
          writingStyle: input.writingStyle,
          tone: input.tone,
          targetAudience: input.targetAudience,
        })
        .onConflictDoUpdate({
          target: userWritingProfiles.userId,
          set: {
            ...(input.displayName ? { displayName: input.displayName } : {}),
            ...(input.preferredLanguage ? { preferredLanguage: input.preferredLanguage } : {}),
            ...(input.writingStyle ? { writingStyle: input.writingStyle } : {}),
            ...(input.tone ? { tone: input.tone } : {}),
            ...(input.targetAudience ? { targetAudience: input.targetAudience } : {}),
          },
        });
    }

    return c.json({ ok: true, onboardingCompleted: true });
  })
  .delete("/account", async (c) => {
    const userId = c.get("user").id;

    // Transactionally clean up user resources
    await db.transaction(async (tx) => {
      await tx.delete(devices).where(eq(devices.userId, userId));
      await tx.delete(connectedAccounts).where(eq(connectedAccounts.userId, userId));
      await tx.delete(publications).where(eq(publications.userId, userId));
      await tx.delete(stories).where(eq(stories.userId, userId));
      await tx.delete(affiliateLinks).where(eq(affiliateLinks.userId, userId));
      await tx.delete(products).where(eq(products.userId, userId));
      await tx.delete(appSettings).where(eq(appSettings.userId, userId));
      await tx.delete(userWritingProfiles).where(eq(userWritingProfiles.userId, userId));
      await tx.delete(users).where(eq(users.id, userId));
    });

    return c.json({ ok: true, message: "Account and associated data deleted successfully." });
  });
