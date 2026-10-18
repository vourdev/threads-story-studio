import {
  ACTIVE_PUBLICATION_STATUSES,
  applySuggestions,
  type CreateStoryInput,
  defaultParamConfig,
  editParam,
  type GenerationMode,
  isValidParamValue,
  type LibraryQuery,
  type ParamConfig,
  type ParamOperationInput,
  type ParamSuggestions,
  paramConfigSchema,
  type RefineInput,
  resolveParams,
  type StoryPost,
  setLocked,
} from "@tss/shared";
import { and, asc, desc, eq, gt, gte, ilike, inArray, isNull, lt, lte, or, type SQL, sql } from "drizzle-orm";

import type { ProductFacts } from "../ai/prompts/v1";
import type { ProductAnalysis, TopicAnalysis } from "../ai/schemas";
import { ai } from "../ai/service";
import { track } from "../analytics/events";
import { db, type Tx } from "../db/client";
import {
  affiliateLinks,
  appSettings,
  products,
  publications,
  stories,
  storyAnalyses,
  storyInputs,
  storyParameterConfigs,
  storyVariations,
  storyVersions,
} from "../db/schema";
import { getOwnedProduct, toProductFacts } from "../products/facts";
import { AppError, notFound } from "../security/errors";

const newPostId = () => crypto.randomUUID().slice(0, 12);
export const toPosts = (posts: { text: string }[]): StoryPost[] =>
  posts.map((p) => ({ id: newPostId(), text: p.text.trim() }));

// ---------------------------------------------------------------- loading

export async function getOwnedStory(userId: string, storyId: string, tx: Pick<Tx, "select"> = db) {
  const [row] = await tx
    .select()
    .from(stories)
    .where(and(eq(stories.id, storyId), eq(stories.userId, userId), isNull(stories.deletedAt)));
  if (!row) throw notFound("Story");
  return row;
}

export async function lockStory(tx: Tx, userId: string, storyId: string) {
  const [row] = await tx
    .select()
    .from(stories)
    .where(and(eq(stories.id, storyId), eq(stories.userId, userId), isNull(stories.deletedAt)))
    .for("update");
  if (!row) throw notFound("Story");
  return row;
}

async function latestAnalysis(storyId: string, kind: "topic" | "product") {
  const [row] = await db
    .select()
    .from(storyAnalyses)
    .where(and(eq(storyAnalyses.storyId, storyId), eq(storyAnalyses.kind, kind)))
    .orderBy(desc(storyAnalyses.createdAt))
    .limit(1);
  return row ?? null;
}

async function loadParams(storyId: string): Promise<{ params: ParamConfig; lastSuggestions: ParamSuggestions | null }> {
  const [row] = await db.select().from(storyParameterConfigs).where(eq(storyParameterConfigs.storyId, storyId));
  if (!row) throw notFound("Story parameters");
  return {
    params: paramConfigSchema.parse(row.params),
    lastSuggestions: (row.lastSuggestions as ParamSuggestions | null) ?? null,
  };
}

async function loadInput(storyId: string) {
  const [row] = await db.select().from(storyInputs).where(eq(storyInputs.storyId, storyId));
  return row ?? { rawInput: "", context: null, clarifications: [] as { question: string; answer: string }[] };
}

async function productContext(userId: string, story: typeof stories.$inferSelect) {
  if (!story.productId) return { product: null as ProductFacts | null, productRow: null };
  const productRow = await getOwnedProduct(userId, story.productId);
  return { product: toProductFacts(productRow), productRow };
}

export async function getStoryDetail(userId: string, storyId: string) {
  // One parallel round trip. Ownership is enforced on the story row before anything is returned,
  // so the sibling queries for a foreign id are simply discarded.
  const [[row], input, topic, product, paramRow, variations, pubs] = await Promise.all([
    db
      .select({
        story: stories,
        product: { id: products.id, name: products.name, imageUrl: products.imageUrl, shopeeUrl: products.shopeeUrl },
        link: {
          id: affiliateLinks.id,
          slug: affiliateLinks.slug,
          destinationUrl: affiliateLinks.destinationUrl,
          isVerifiedAffiliate: affiliateLinks.isVerifiedAffiliate,
        },
      })
      .from(stories)
      .leftJoin(products, eq(products.id, stories.productId))
      .leftJoin(affiliateLinks, eq(affiliateLinks.id, stories.affiliateLinkId))
      .where(and(eq(stories.id, storyId), eq(stories.userId, userId), isNull(stories.deletedAt))),
    loadInput(storyId),
    latestAnalysis(storyId, "topic"),
    latestAnalysis(storyId, "product"),
    db.select().from(storyParameterConfigs).where(eq(storyParameterConfigs.storyId, storyId)),
    db
      .select()
      .from(storyVariations)
      .where(eq(storyVariations.storyId, storyId))
      .orderBy(desc(storyVariations.createdAt), asc(storyVariations.position))
      .limit(15),
    db
      .select({
        id: publications.id,
        provider: publications.provider,
        status: publications.status,
        permalink: publications.permalink,
        lastErrorMessage: publications.lastErrorMessage,
        publishedAt: publications.publishedAt,
        createdAt: publications.createdAt,
      })
      .from(publications)
      .where(eq(publications.storyId, storyId))
      .orderBy(desc(publications.createdAt))
      .limit(20),
  ]);
  if (!row) throw notFound("Story");
  const config = paramRow[0];
  if (!config) throw notFound("Story parameters");
  return {
    story: row.story,
    input: { rawInput: input.rawInput, context: input.context, clarifications: input.clarifications },
    analysis: {
      topic: (topic?.payload as TopicAnalysis | undefined) ?? null,
      product: (product?.payload as ProductAnalysis | undefined) ?? null,
    },
    params: paramConfigSchema.parse(config.params),
    lastSuggestions: (config.lastSuggestions as ParamSuggestions | null) ?? null,
    variations,
    publications: pubs,
    product: row.product,
    affiliateLink: row.link,
  };
}

// ---------------------------------------------------------------- create / input

export async function createStory(userId: string, input: CreateStoryInput) {
  if (input.mode === "affiliate" && !input.productId) {
    throw new AppError("bad_request", "Affiliate stories need a product.");
  }
  if (input.mode === "general" && !input.rawInput) {
    throw new AppError("bad_request", "Describe a topic or experience first.");
  }
  if (input.productId) await getOwnedProduct(userId, input.productId);

  const [settings] = await db.select().from(appSettings).where(eq(appSettings.userId, userId));
  const params = defaultParamConfig(input.mode);
  for (const [key, value] of Object.entries(settings?.defaultParams ?? {})) {
    if (params[key] && isValidParamValue(key, value)) params[key] = { value, state: "default" };
  }

  return db.transaction(async (tx) => {
    const [story] = await tx
      .insert(stories)
      .values({
        userId,
        mode: input.mode,
        productId: input.productId ?? null,
        title: deriveTitle(input.rawInput) ?? "Untitled story",
      })
      .returning();
    if (!story) throw new AppError("internal", "Could not create story");
    await tx
      .insert(storyInputs)
      .values({ storyId: story.id, rawInput: input.rawInput, context: input.context ?? null });
    await tx.insert(storyParameterConfigs).values({ storyId: story.id, params });
    return story;
  });
}

function deriveTitle(text: string | undefined | null): string | null {
  const line = text
    ?.split("\n")
    .find((l) => l.trim())
    ?.trim();
  if (!line) return null;
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

export async function updateInput(
  userId: string,
  storyId: string,
  input: { rawInput?: string; context?: string; clarifications?: { question: string; answer: string }[] },
) {
  await getOwnedStory(userId, storyId);
  await db
    .update(storyInputs)
    .set({
      ...(input.rawInput !== undefined ? { rawInput: input.rawInput } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
      ...(input.clarifications !== undefined ? { clarifications: input.clarifications } : {}),
    })
    .where(eq(storyInputs.storyId, storyId));
}

// ---------------------------------------------------------------- analysis & parameters

export async function analyzeStory(userId: string, storyId: string) {
  const story = await getOwnedStory(userId, storyId);
  const input = await loadInput(storyId);

  if (story.mode === "affiliate") {
    const { product, productRow } = await productContext(userId, story);
    if (!product || !productRow) throw new AppError("bad_request", "Attach a product first.");
    const result = await ai.analyzeProduct(userId, { product, shopeeUrl: productRow.shopeeUrl });
    await db.insert(storyAnalyses).values({
      storyId,
      kind: "product",
      payload: result.data,
      provider: result.provider,
      model: result.model,
      promptVersion: result.promptVersion,
    });
    await db.update(products).set({ analysis: result.data }).where(eq(products.id, productRow.id));
    return { kind: "product" as const, analysis: result.data, provider: result.provider };
  }

  if (!input.rawInput.trim()) throw new AppError("bad_request", "Describe a topic or experience first.");
  const result = await ai.analyzeTopic(userId, {
    rawInput: input.rawInput,
    context: input.context,
    clarifications: input.clarifications,
  });
  await db.insert(storyAnalyses).values({
    storyId,
    kind: "topic",
    payload: result.data,
    provider: result.provider,
    model: result.model,
    promptVersion: result.promptVersion,
  });
  return { kind: "topic" as const, analysis: result.data, provider: result.provider };
}

async function saveParams(storyId: string, params: ParamConfig, lastSuggestions?: ParamSuggestions) {
  await db
    .update(storyParameterConfigs)
    .set({
      params,
      ...(lastSuggestions ? { lastSuggestions } : {}),
      revision: sql`${storyParameterConfigs.revision} + 1`,
    })
    .where(eq(storyParameterConfigs.storyId, storyId));
}

/**
 * Asks the AI for parameters and applies them to unlocked, non-customized entries.
 * User edits and locks are never overwritten here.
 */
export async function suggestParams(userId: string, storyId: string) {
  const story = await getOwnedStory(userId, storyId);
  const [input, topic, product, { params }] = await Promise.all([
    loadInput(storyId),
    latestAnalysis(storyId, "topic"),
    latestAnalysis(storyId, "product"),
    loadParams(storyId),
  ]);
  if (story.mode === "general" && !topic) throw new AppError("bad_request", "Analyze the input first.");
  if (story.mode === "affiliate" && !product) throw new AppError("bad_request", "Analyze the product first.");

  const result = await ai.suggestParameters(userId, {
    mode: story.mode,
    rawInput: input.rawInput,
    topicAnalysis: (topic?.payload as TopicAnalysis | undefined) ?? null,
    productAnalysis: (product?.payload as ProductAnalysis | undefined) ?? null,
    current: params,
  });
  const next = applySuggestions(story.mode, params, result.data);
  await saveParams(storyId, next, result.data);
  return { params: next, suggestions: result.data };
}

export async function applyParamOperation(userId: string, storyId: string, op: ParamOperationInput) {
  const story = await getOwnedStory(userId, storyId);
  const { params, lastSuggestions } = await loadParams(storyId);
  let next: ParamConfig;
  try {
    switch (op.op) {
      case "edit":
        if (!params[op.key]) throw new Error(`Parameter ${op.key} does not apply to this story`);
        next = editParam(params, op.key, op.value);
        break;
      case "lock":
        next = setLocked(params, op.key, op.locked);
        break;
      case "accept_suggestions":
        next = applySuggestions(story.mode, params, lastSuggestions ?? {});
        break;
      case "reset_to_ai":
        if (!lastSuggestions) throw new Error("No AI suggestions yet");
        next = applySuggestions(story.mode, params, lastSuggestions, { overrideCustomized: true });
        break;
    }
  } catch (err) {
    throw new AppError("bad_request", err instanceof Error ? err.message : "Invalid parameter operation");
  }
  await saveParams(storyId, next);
  return next;
}

// ---------------------------------------------------------------- generation

export async function generationContext(userId: string, story: typeof stories.$inferSelect) {
  const [input, topic, productAnalysis, { params }, { product }] = await Promise.all([
    loadInput(story.id),
    latestAnalysis(story.id, "topic"),
    latestAnalysis(story.id, "product"),
    loadParams(story.id),
    productContext(userId, story),
  ]);
  return {
    input,
    topic: (topic?.payload as TopicAnalysis | undefined) ?? null,
    productAnalysis: (productAnalysis?.payload as ProductAnalysis | undefined) ?? null,
    params,
    resolved: resolveParams(params),
    product,
  };
}

export async function generateVariations(
  userId: string,
  storyId: string,
  count: number,
  options: { avoidExistingHooks?: boolean } = {},
) {
  const story = await getOwnedStory(userId, storyId);
  const ctx = await generationContext(userId, story);
  if (story.mode === "general" && !ctx.input.rawInput.trim()) {
    throw new AppError("bad_request", "Describe a topic or experience first.");
  }
  if (story.mode === "affiliate" && !ctx.product) throw new AppError("bad_request", "Attach a product first.");

  let avoidHooks: string[] = [];
  if (options.avoidExistingHooks) {
    const existing = await db
      .select({ hook: storyVariations.hook })
      .from(storyVariations)
      .where(eq(storyVariations.storyId, storyId))
      .orderBy(desc(storyVariations.createdAt))
      .limit(10);
    avoidHooks = existing.map((e) => e.hook).filter((h): h is string => Boolean(h));
  }

  const result = await ai.generateStories(userId, {
    mode: story.mode,
    rawInput: ctx.input.rawInput,
    context: ctx.input.context,
    clarifications: ctx.input.clarifications,
    topicAnalysis: ctx.topic,
    productAnalysis: ctx.productAnalysis,
    product: ctx.product,
    params: ctx.resolved,
    count,
    avoidHooks,
  });

  const batchId = crypto.randomUUID();
  const rows = await db
    .insert(storyVariations)
    .values(
      result.data.variations.slice(0, count).map((v, position) => ({
        storyId,
        batchId,
        position,
        strategy: v.strategy,
        angle: v.angle,
        hook: v.hook,
        rationale: v.rationale,
        posts: toPosts(v.posts),
        warnings: [...v.warnings, ...(story.mode === "affiliate" && v.cta ? [] : [])],
        paramsSnapshot: { ...ctx.resolved, ...(v.cta ? { __cta: v.cta } : {}) },
        provider: result.provider,
        model: result.model,
        promptVersion: result.promptVersion,
      })),
    )
    .returning();

  await db.update(stories).set({ updatedAt: new Date() }).where(eq(stories.id, storyId));
  await track({
    userId,
    type: "story_generated",
    storyId,
    productId: story.productId,
    provider: result.provider,
    meta: { variations: rows.length, mode: story.mode, model: result.model },
  });
  return rows;
}

/** Appends a version and makes it the story's current content. Caller holds the story row lock. */
export async function appendVersion(
  tx: Tx,
  story: typeof stories.$inferSelect,
  posts: StoryPost[],
  source: (typeof storyVersions.$inferInsert)["source"],
  extra: { cta?: string | null; note?: string; warnings?: string[]; selectedVariationId?: string; title?: string } = {},
) {
  const versionNo = story.currentVersionNo + 1;
  const cta = extra.cta === undefined ? story.cta : extra.cta;
  await tx.insert(storyVersions).values({ storyId: story.id, versionNo, posts, cta, source, note: extra.note });
  const [updated] = await tx
    .update(stories)
    .set({
      posts,
      cta,
      currentVersionNo: versionNo,
      ...(extra.warnings ? { warnings: extra.warnings } : {}),
      ...(extra.selectedVariationId ? { selectedVariationId: extra.selectedVariationId } : {}),
      ...(extra.title ? { title: extra.title } : {}),
    })
    .where(eq(stories.id, story.id))
    .returning();
  if (!updated) throw new AppError("internal", "Could not update story");
  return updated;
}

export async function selectVariation(userId: string, storyId: string, variationId: string) {
  return db.transaction(async (tx) => {
    const story = await lockStory(tx, userId, storyId);
    const [variation] = await tx
      .select()
      .from(storyVariations)
      .where(and(eq(storyVariations.id, variationId), eq(storyVariations.storyId, storyId)));
    if (!variation) throw notFound("Variation");
    const updated = await appendVersion(tx, story, variation.posts, "variation_select", {
      cta: story.mode === "affiliate" ? (variation.paramsSnapshot.__cta ?? story.cta) : null,
      warnings: variation.warnings,
      selectedVariationId: variation.id,
      note: variation.strategy,
      title: deriveTitle(variation.hook ?? variation.posts[0]?.text) ?? story.title,
    });
    await track(
      { userId, type: "story_saved", storyId, productId: story.productId, meta: { source: "variation_select" } },
      tx,
    );
    return updated;
  });
}

export async function saveContent(
  userId: string,
  storyId: string,
  posts: StoryPost[],
  note?: string,
  cta?: string | null,
) {
  return db.transaction(async (tx) => {
    const story = await lockStory(tx, userId, storyId);
    const updated = await appendVersion(tx, story, posts, "edit", { note, cta });
    await track({ userId, type: "story_saved", storyId, productId: story.productId, meta: { source: "edit" } }, tx);
    return updated;
  });
}

export async function refineStory(userId: string, storyId: string, input: RefineInput) {
  const story = await getOwnedStory(userId, storyId);
  if (story.posts.length === 0) throw new AppError("bad_request", "Select or write a story first.");
  const ctx = await generationContext(userId, story);

  if (input.action === "rewrite_selection") {
    const sel = input.selection;
    if (!sel) throw new AppError("bad_request", "Select some text first.");
    const post = story.posts.find((p) => p.id === sel.postId);
    if (!post || sel.end > post.text.length) throw new AppError("bad_request", "Selection is out of range.");
    const selected = post.text.slice(sel.start, sel.end);
    const result = await ai.rewriteSelection(userId, {
      selected,
      post: post.text,
      instruction: input.instruction,
      params: ctx.resolved,
    });
    const posts = story.posts.map((p) =>
      p.id === post.id
        ? { ...p, text: p.text.slice(0, sel.start) + result.data.replacement + p.text.slice(sel.end) }
        : p,
    );
    return db.transaction(async (tx) => {
      const locked = await lockStory(tx, userId, storyId);
      return appendVersion(tx, locked, posts, "refine", { note: result.data.changeSummary });
    });
  }

  if (["different_audience", "change_tone", "custom"].includes(input.action) && !input.instruction) {
    throw new AppError("bad_request", "Add an instruction for this rewrite.");
  }

  const result = await ai.refineStory(userId, {
    mode: story.mode,
    action: input.action,
    instruction: input.instruction,
    posts: story.posts,
    cta: story.cta,
    params: ctx.resolved,
    rawInput: ctx.input.rawInput,
    userFacts: ctx.topic?.userFacts ?? [],
    product: ctx.product,
  });
  // CTA-only change must not touch the posts.
  const posts = input.action === "change_cta" ? story.posts : toPosts(result.data.posts);
  return db.transaction(async (tx) => {
    const locked = await lockStory(tx, userId, storyId);
    return appendVersion(tx, locked, posts, "refine", {
      note: result.data.changeSummary,
      cta: story.mode === "affiliate" ? result.data.cta || locked.cta : null,
      warnings: result.data.warnings,
    });
  });
}

export async function evaluateStory(userId: string, storyId: string) {
  const story = await getOwnedStory(userId, storyId);
  if (story.posts.length === 0) throw new AppError("bad_request", "Nothing to evaluate yet.");
  const ctx = await generationContext(userId, story);
  const result = await ai.evaluateStory(userId, {
    posts: story.posts,
    cta: story.cta,
    rawInput: ctx.input.rawInput,
    userFacts: ctx.topic?.userFacts ?? [],
    product: ctx.product,
  });
  const warnings = [
    ...result.data.unsupportedClaims.map((c) => `Unsupported: ${c}`),
    ...result.data.misleadingPromotion.map((c) => `Misleading: ${c}`),
  ];
  await db.update(stories).set({ warnings }).where(eq(stories.id, storyId));
  return result.data;
}

// ---------------------------------------------------------------- versions

export async function listVersions(userId: string, storyId: string) {
  await getOwnedStory(userId, storyId);
  return db
    .select()
    .from(storyVersions)
    .where(eq(storyVersions.storyId, storyId))
    .orderBy(desc(storyVersions.versionNo))
    .limit(100);
}

export async function restoreVersion(userId: string, storyId: string, versionNo: number) {
  return db.transaction(async (tx) => {
    const story = await lockStory(tx, userId, storyId);
    const [version] = await tx
      .select()
      .from(storyVersions)
      .where(and(eq(storyVersions.storyId, storyId), eq(storyVersions.versionNo, versionNo)));
    if (!version) throw notFound("Version");
    return appendVersion(tx, story, version.posts, "restore", { cta: version.cta, note: `Restored v${versionNo}` });
  });
}

// ---------------------------------------------------------------- library operations

export async function duplicateStory(userId: string, storyId: string) {
  const source = await getStoryDetail(userId, storyId);
  return db.transaction(async (tx) => {
    const [copy] = await tx
      .insert(stories)
      .values({
        userId,
        mode: source.story.mode,
        title: `${source.story.title} (copy)`.slice(0, 200),
        productId: source.story.productId,
        affiliateLinkId: source.story.affiliateLinkId,
        cta: source.story.cta,
        posts: source.story.posts,
        currentVersionNo: source.story.posts.length ? 1 : 0,
      })
      .returning();
    if (!copy) throw new AppError("internal", "Could not duplicate story");
    await tx.insert(storyInputs).values({
      storyId: copy.id,
      rawInput: source.input.rawInput,
      context: source.input.context,
      clarifications: source.input.clarifications,
    });
    await tx.insert(storyParameterConfigs).values({
      storyId: copy.id,
      params: source.params,
      lastSuggestions: source.lastSuggestions,
    });
    if (source.story.posts.length) {
      await tx.insert(storyVersions).values({
        storyId: copy.id,
        versionNo: 1,
        posts: source.story.posts,
        cta: source.story.cta,
        source: "edit",
        note: "Duplicated",
      });
    }
    return copy;
  });
}

export async function deleteStory(userId: string, storyId: string) {
  await getOwnedStory(userId, storyId);
  const active = await db
    .select({ id: publications.id })
    .from(publications)
    .where(and(eq(publications.storyId, storyId), inArray(publications.status, [...ACTIVE_PUBLICATION_STATUSES])))
    .limit(1);
  if (active.length) {
    throw new AppError("conflict", "This story is being published right now. Try again when it's done.");
  }
  await db.update(stories).set({ deletedAt: new Date() }).where(eq(stories.id, storyId));
}

export async function setLink(userId: string, storyId: string, affiliateLinkId: string | null, cta?: string | null) {
  const story = await getOwnedStory(userId, storyId);
  if (affiliateLinkId) {
    const [link] = await db
      .select()
      .from(affiliateLinks)
      .where(and(eq(affiliateLinks.id, affiliateLinkId), eq(affiliateLinks.userId, userId)));
    if (!link) throw notFound("Affiliate link");
    if (story.productId && link.productId !== story.productId) {
      throw new AppError("bad_request", "This link belongs to a different product.");
    }
  }
  const [updated] = await db
    .update(stories)
    .set({ affiliateLinkId, ...(cta !== undefined ? { cta } : {}) })
    .where(eq(stories.id, storyId))
    .returning();
  return updated;
}

type Cursor = { v: string; id: string };
const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decodeCursor(raw?: string): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    return typeof parsed.v === "string" && typeof parsed.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export async function listStories(userId: string, query: LibraryQuery) {
  const filters: SQL[] = [eq(stories.userId, userId), isNull(stories.deletedAt)];
  if (query.mode) filters.push(eq(stories.mode, query.mode as GenerationMode));
  if (query.status) filters.push(eq(stories.status, query.status));
  if (query.productId) filters.push(eq(stories.productId, query.productId));
  if (query.from) filters.push(gte(stories.createdAt, new Date(query.from)));
  if (query.to) filters.push(lte(stories.createdAt, new Date(query.to)));
  if (query.q) {
    const pattern = `%${query.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const match = or(ilike(stories.title, pattern), sql`${stories.posts}::text ilike ${pattern}`);
    if (match) filters.push(match);
  }

  const sortCol = {
    updated_desc: stories.updatedAt,
    created_desc: stories.createdAt,
    created_asc: stories.createdAt,
    title_asc: stories.title,
  }[query.sort];
  const ascending = query.sort === "created_asc" || query.sort === "title_asc";
  const cursor = decodeCursor(query.cursor);
  if (cursor) {
    const value = query.sort === "title_asc" ? cursor.v : new Date(cursor.v);
    const cmp = ascending ? gt : lt;
    const tie = or(cmp(sortCol, value), and(eq(sortCol, value), cmp(stories.id, cursor.id)));
    if (tie) filters.push(tie);
  }

  const rows = await db
    .select({
      id: stories.id,
      mode: stories.mode,
      title: stories.title,
      status: stories.status,
      productId: stories.productId,
      posts: stories.posts,
      warnings: stories.warnings,
      createdAt: stories.createdAt,
      updatedAt: stories.updatedAt,
    })
    .from(stories)
    .where(and(...filters))
    .orderBy(ascending ? asc(sortCol) : desc(sortCol), ascending ? asc(stories.id) : desc(stories.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          v:
            query.sort === "title_asc"
              ? last.title
              : (query.sort === "updated_desc" ? last.updatedAt : last.createdAt).toISOString(),
          id: last.id,
        })
      : null;

  return {
    items: page.map(({ posts, ...rest }) => ({
      ...rest,
      preview: posts[0]?.text.slice(0, 220) ?? "",
      postCount: posts.length,
    })),
    nextCursor,
  };
}
