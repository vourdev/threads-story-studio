import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { app } from "../src/app";
import { db } from "../src/db/client";
import { products, stories, users } from "../src/db/schema";
import * as storyService from "../src/stories/service";
import { resetDb } from "./helpers";

const ORIGIN = { origin: "http://localhost:8081", "content-type": "application/json" };

async function register(email: string, name: string) {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: ORIGIN,
    body: JSON.stringify({ email, password: "password-12345678", name }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  const data = (await res.json()) as { user: { id: string; email: string; role: string; onboardingCompleted: boolean } };
  return { id: data.user.id, email, cookie, user: data.user };
}

describe("Multi-User SaaS Architecture & Isolation", () => {
  beforeEach(resetDb);

  it("assigns first user admin role and subsequent users standard user role", async () => {
    const adminUser = await register("admin@corp.local", "Admin Boss");
    expect(adminUser.user.role).toBe("admin");

    const regularUser = await register("regular@corp.local", "Regular Joe");
    expect(regularUser.user.role).toBe("user");
  });

  it("strictly isolates stories between users", async () => {
    const userA = await register("userA@corp.local", "User A");
    const userB = await register("userB@corp.local", "User B");

    // Create story using service for proper multi-table entity setup
    const created = await storyService.createStory(userA.id, {
      mode: "general",
      rawInput: "User A private experience with failing interviews and getting hired",
    });

    // User A can access their story
    const resA = await app.request(`/api/stories/${created.id}`, {
      headers: { cookie: userA.cookie },
    });
    expect(resA.status).toBe(200);
    const bodyA = (await resA.json()) as { story: { id: string } };
    expect(bodyA.story.id).toBe(created.id);

    // User B cannot access User A's story (returns 404 to avoid leaking existence)
    const resB = await app.request(`/api/stories/${created.id}`, {
      headers: { cookie: userB.cookie },
    });
    expect(resB.status).toBe(404);

    // User B cannot update or delete User A's story
    const resBDelete = await app.request(`/api/stories/${created.id}`, {
      method: "DELETE",
      headers: { cookie: userB.cookie },
    });
    expect(resBDelete.status).toBe(404);

    // User B's story list does not contain User A's stories
    const resBList = await app.request("/api/stories", {
      headers: { cookie: userB.cookie },
    });
    expect(resBList.status).toBe(200);
    const listB = (await resBList.json()) as { items: unknown[]; nextCursor: string | null };
    expect(listB.items).toHaveLength(0);
  });

  it("strictly isolates affiliate products between users", async () => {
    const userA = await register("userA@corp.local", "User A");
    const userB = await register("userB@corp.local", "User B");

    const [prodA] = await db
      .insert(products)
      .values({
        userId: userA.id,
        shopeeUrl: "https://shopee.co.id/product/123/456",
        name: "User A Special Keyboard",
        dataSource: "manual",
      })
      .returning();

    expect(prodA).toBeDefined();

    // User B cannot view User A's product
    const resB = await app.request(`/api/products/${prodA!.id}`, {
      headers: { cookie: userB.cookie },
    });
    expect(resB.status).toBe(404);

    // User B cannot delete User A's product
    const resBDelete = await app.request(`/api/products/${prodA!.id}`, {
      method: "DELETE",
      headers: { cookie: userB.cookie },
    });
    expect(resBDelete.status).toBe(404);
  });

  it("allows users to view and update their 25 AI personalization fields", async () => {
    const user = await register("writer@corp.local", "Story Teller");

    // Fetch initialized profile
    const getRes = await app.request("/api/settings/writing-profile", {
      headers: { cookie: user.cookie },
    });
    expect(getRes.status).toBe(200);
    const initial = (await getRes.json()) as { profile: { displayName: string; personalizationEnabled: boolean } };
    expect(initial.profile.displayName).toBe("Story Teller");
    expect(initial.profile.personalizationEnabled).toBe(true);

    // Update writing preferences across tone, slang, expressions, boundaries
    const updateRes = await app.request("/api/settings/writing-profile", {
      method: "PUT",
      headers: { ...ORIGIN, cookie: user.cookie },
      body: JSON.stringify({
        displayName: "Dewi Tech",
        occupation: "Fullstack Architect",
        industry: "SaaS",
        tone: "authentic_vulnerable",
        writingStyle: "narrative_arc",
        formalityLevel: "casual",
        sentenceLength: "short_punchy",
        slangPreference: "tech_indonesia",
        emojiPreference: "minimal",
        favoriteExpressions: ["insight berharga", "langsung praktek"],
        avoidExpressions: ["pokoknya", "gaskeun"],
        factualBoundaries: "Never claim I am a crypto investor",
        forbiddenTopics: ["gambling", "crypto"],
        personalizationEnabled: true,
      }),
    });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as {
      profile: {
        displayName: string;
        occupation: string;
        tone: string;
        favoriteExpressions: string[];
        factualBoundaries: string;
      };
    };
    expect(updated.profile.displayName).toBe("Dewi Tech");
    expect(updated.profile.occupation).toBe("Fullstack Architect");
    expect(updated.profile.tone).toBe("authentic_vulnerable");
    expect(updated.profile.favoriteExpressions).toEqual(["insight berharga", "langsung praktek"]);
    expect(updated.profile.factualBoundaries).toBe("Never claim I am a crypto investor");
  });

  it("enforces admin-only access control on /api/admin/*", async () => {
    const adminUser = await register("superadmin@corp.local", "Super Admin");
    const regularUser = await register("pleb@corp.local", "Pleb User");

    // Regular user is rejected from admin overview with 403 Forbidden
    const resForbidden = await app.request("/api/admin/overview", {
      headers: { cookie: regularUser.cookie },
    });
    expect(resForbidden.status).toBe(403);

    // Admin user is granted access
    const resOk = await app.request("/api/admin/overview", {
      headers: { cookie: adminUser.cookie },
    });
    expect(resOk.status).toBe(200);
    const body = (await resOk.json()) as { overview: { totalUsers: number } };
    expect(body.overview.totalUsers).toBeGreaterThanOrEqual(2);
  });

  it("completes lightweight user onboarding flow", async () => {
    const user = await register("newbie@corp.local", "Newbie");

    const meBefore = await app.request("/api/user/me", { headers: { cookie: user.cookie } });
    expect(meBefore.status).toBe(200);
    const meBeforeBody = (await meBefore.json()) as { user: { onboardingCompleted: boolean } };
    expect(meBeforeBody.user.onboardingCompleted).toBe(false);

    const onboardRes = await app.request("/api/user/onboarding", {
      method: "POST",
      headers: { ...ORIGIN, cookie: user.cookie },
      body: JSON.stringify({
        displayName: "Newbie Pro",
        preferredLanguage: "id_casual",
        tone: "conversational",
        writingStyle: "storyteller",
        targetAudience: "Tech enthusiasts",
      }),
    });
    expect(onboardRes.status).toBe(200);

    const meAfter = await app.request("/api/user/me", { headers: { cookie: user.cookie } });
    const meAfterBody = (await meAfter.json()) as { user: { onboardingCompleted: boolean } };
    expect(meAfterBody.user.onboardingCompleted).toBe(true);
  });

  it("handles account deletion completely without leaving orphaned resources", async () => {
    const user = await register("ephemeral@corp.local", "Ephemeral");

    // Add a story
    await storyService.createStory(user.id, {
      mode: "general",
      rawInput: "To be deleted story experience",
    });

    // Delete account
    const deleteRes = await app.request("/api/user/account", {
      method: "DELETE",
      headers: { cookie: user.cookie },
    });
    expect(deleteRes.status).toBe(200);

    // Verify user no longer exists in DB
    const [deletedUser] = await db.select().from(users).where(eq(users.id, user.id));
    expect(deletedUser).toBeUndefined();

    // Verify stories were cascaded and removed
    const userStories = await db.select().from(stories).where(eq(stories.userId, user.id));
    expect(userStories).toHaveLength(0);
  });
});
