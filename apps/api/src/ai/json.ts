// Ported from backend-vour-carousels/src/lib/ai/generate.ts (extractAndParseJson / salvageJson).

/**
 * True when the last meaningful character ended a value and the next one starts another,
 * which means the comma between them is missing. Only a closed bracket or string counts,
 * so this cannot fire between a key and its value.
 */
function needsSeparator(out: string): boolean {
  const prev = out.replace(/\s+$/, "").slice(-1);
  return prev === "}" || prev === "]" || prev === '"';
}

export function salvageJson(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (const ch of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        out += ch;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      // Literal control characters are illegal inside JSON strings; escape rather than drop.
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      out += ch;
      continue;
    }

    if (ch === '"') {
      if (needsSeparator(out)) out += ",";
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (needsSeparator(out)) out += ",";
      stack.push(ch);
      out += ch;
      continue;
    }
    if (ch === "}" || ch === "]") {
      stack.pop();
      out += ch;
      continue;
    }
    out += ch;
  }

  if (inString) out += '"';
  out = out.replace(/,(\s*)$/, "$1");
  while (stack.length) out += stack.pop() === "{" ? "}" : "]";
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Extracts the JSON object from a model reply (code fences, prose, truncation tolerated). */
export function extractAndParseJson(rawText: string): unknown {
  let cleaned = rawText.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  } else if (firstBrace !== -1) {
    cleaned = cleaned.substring(firstBrace); // cut off — keep what arrived
  }

  try {
    return JSON.parse(cleaned);
  } catch (strict) {
    try {
      return JSON.parse(salvageJson(cleaned));
    } catch {
      throw strict; // the original fault says what the model actually got wrong
    }
  }
}
