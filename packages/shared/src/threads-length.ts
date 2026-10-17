/** Threads text post limit (characters, with emoji counted by UTF-8 byte length). */
export const THREADS_MAX_CHARS = 500;
export const THREADS_MAX_POSTS_PER_THREAD = 20;

const EMOJI_LIKE = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\ufe0f|\u20e3/u;

function utf8Bytes(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * Length as counted by the Threads API: one per character, except emoji
 * (and their joiners / modifiers / variation selectors) which count by UTF-8 byte length.
 */
export function threadsLength(text: string): number {
  let total = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    total += EMOJI_LIKE.test(char) ? utf8Bytes(cp) : 1;
  }
  return total;
}

export function isWithinThreadsLimit(text: string): boolean {
  return threadsLength(text) <= THREADS_MAX_CHARS;
}

/**
 * Final content for publishing: the CTA and link go at the end of the last post when they fit,
 * otherwise into one extra reply post. Pure so the app can preview exactly what will be published.
 */
export function composeForPublishing<T extends { id: string; text: string }>(
  posts: T[],
  cta: string | null | undefined,
  link: string | null | undefined,
): { id: string; text: string }[] {
  const tail = [cta?.trim(), link?.trim()].filter(Boolean).join("\n");
  if (!tail || posts.length === 0) return posts.map((p) => ({ id: p.id, text: p.text }));
  const out = posts.map((p) => ({ id: p.id, text: p.text }));
  const last = out[out.length - 1];
  if (last && isWithinThreadsLimit(`${last.text}\n\n${tail}`)) {
    last.text = `${last.text}\n\n${tail}`;
  } else {
    out.push({ id: `${last?.id ?? "post"}-cta`, text: tail });
  }
  return out;
}
