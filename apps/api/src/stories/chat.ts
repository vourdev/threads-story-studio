import { asc, desc, eq } from "drizzle-orm";

import { ai } from "../ai/service";
import { track } from "../analytics/events";
import { db } from "../db/client";
import { storyInputs, storyMessages } from "../db/schema";
import { AppError } from "../security/errors";
import { appendVersion, generationContext, getOwnedStory, lockStory, toPosts } from "./service";

const HISTORY_TURNS = 12;

export async function listMessages(userId: string, storyId: string) {
  await getOwnedStory(userId, storyId);
  return db
    .select()
    .from(storyMessages)
    .where(eq(storyMessages.storyId, storyId))
    .orderBy(asc(storyMessages.createdAt))
    .limit(200);
}

/**
 * Chat-based revision: the user asks for a change in plain language and the AI editor
 * applies it to the current story as a new version (so every chat edit can be undone).
 * Messages are stored only after the AI succeeds, so a failed turn can simply be resent.
 */
export async function sendChatMessage(userId: string, storyId: string, message: string) {
  const story = await getOwnedStory(userId, storyId);
  if (story.posts.length === 0) throw new AppError("bad_request", "Pick a variation or write the story first.");
  const ctx = await generationContext(userId, story);

  const recent = await db
    .select({ role: storyMessages.role, content: storyMessages.content })
    .from(storyMessages)
    .where(eq(storyMessages.storyId, storyId))
    .orderBy(desc(storyMessages.createdAt))
    .limit(HISTORY_TURNS);
  const history = recent.reverse();

  const userFacts = [...(ctx.topic?.userFacts ?? []), ...ctx.input.clarifications.map((c) => c.answer)];
  const result = await ai.chatRevision(userId, {
    mode: story.mode,
    message,
    history,
    posts: story.posts,
    cta: story.cta,
    params: ctx.resolved,
    rawInput: ctx.input.rawInput,
    userFacts,
    product: ctx.product,
  });
  const reply = result.data;
  const revised = reply.action === "revise" && reply.posts.length > 0;

  return db.transaction(async (tx) => {
    const locked = await lockStory(tx, userId, storyId);
    let updatedStory = locked;
    if (revised) {
      updatedStory = await appendVersion(tx, locked, toPosts(reply.posts), "chat", {
        note: reply.changeSummary || message.slice(0, 120),
        cta: locked.mode === "affiliate" ? reply.cta || locked.cta : null,
        warnings: reply.warnings,
      });
      await track({ userId, type: "story_saved", storyId, productId: locked.productId, meta: { source: "chat" } }, tx);
    }
    if (reply.newFacts.length) {
      // Facts the user stated in chat become part of the story input for future generations.
      await tx
        .update(storyInputs)
        .set({
          clarifications: [
            ...ctx.input.clarifications,
            ...reply.newFacts.map((fact) => ({ question: "Stated in revision chat", answer: fact })),
          ].slice(-30),
        })
        .where(eq(storyInputs.storyId, storyId));
    }
    const [userMsg] = await tx.insert(storyMessages).values({ storyId, role: "user", content: message }).returning();
    const [assistantMsg] = await tx
      .insert(storyMessages)
      .values({
        storyId,
        role: "assistant",
        content: reply.reply,
        action: reply.action,
        versionNo: revised ? updatedStory.currentVersionNo : null,
        provider: result.provider,
      })
      .returning();
    return { story: updatedStory, messages: [userMsg, assistantMsg], action: reply.action, warnings: reply.warnings };
  });
}
