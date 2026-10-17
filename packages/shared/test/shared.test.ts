import { describe, expect, it } from "vitest";

import {
  applySuggestions,
  composeForPublishing,
  defaultParamConfig,
  diffSuggestions,
  editParam,
  isValidParamValue,
  resolveParams,
  setLocked,
  threadsLength,
} from "../src";

describe("parameter engine", () => {
  const base = defaultParamConfig("general");
  const suggestions = {
    emotion: { value: "hopeful", reason: "fits", confidence: 0.8 },
    storyType: { value: "career", reason: "job story", confidence: 0.9 },
    outputFormat: { value: "single_post", reason: "short input", confidence: 0.6 },
  };

  it("applies suggestions to default params with reason and confidence", () => {
    const next = applySuggestions("general", base, suggestions);
    expect(next.emotion).toMatchObject({ value: "hopeful", state: "ai_suggested", reason: "fits", confidence: 0.8 });
  });

  it("never overwrites locked or user-customized params when re-suggesting", () => {
    let config = applySuggestions("general", base, suggestions);
    config = editParam(config, "emotion", "proud");
    config = setLocked(editParam(config, "outputFormat", "multi_post_thread"), "outputFormat", true);
    const again = applySuggestions("general", config, {
      emotion: { value: "sad" },
      outputFormat: { value: "long_story" },
      storyType: { value: "funny" },
    });
    expect(again.emotion).toMatchObject({ value: "proud", state: "user_customized" });
    expect(again.outputFormat).toMatchObject({ value: "multi_post_thread", state: "locked" });
    expect(again.storyType).toMatchObject({ value: "funny", state: "ai_suggested" });
  });

  it("reset to AI overrides edits but still respects locks", () => {
    let config = editParam(base, "emotion", "proud");
    config = setLocked(config, "storyType", true);
    const reset = applySuggestions("general", config, suggestions, { overrideCustomized: true });
    expect(reset.emotion?.value).toBe("hopeful");
    expect(reset.storyType).toMatchObject({ state: "locked", value: base.storyType?.value });
  });

  it("ignores invalid or non-applicable suggestions", () => {
    const next = applySuggestions("general", base, {
      emotion: { value: "nonsense" },
      promotionIntensity: { value: "direct" },
    });
    expect(next.emotion?.value).toBe(base.emotion?.value);
    expect(next).not.toHaveProperty("promotionIntensity");
  });

  it("unlocking keeps the value protected as a user choice", () => {
    const locked = setLocked(applySuggestions("general", base, suggestions), "emotion", true);
    expect(setLocked(locked, "emotion", false).emotion?.state).toBe("user_customized");
  });

  it("diffs pending changes and resolves values for generation", () => {
    expect(
      diffSuggestions("general", base, suggestions)
        .map((c) => c.key)
        .sort(),
    ).toEqual(["emotion", "outputFormat", "storyType"]);
    expect(resolveParams(applySuggestions("general", base, suggestions)).emotion).toBe("hopeful");
  });

  it("validates custom values only where allowed", () => {
    expect(isValidParamValue("targetAudience", "Ibu rumah tangga")).toBe(true);
    expect(isValidParamValue("emotion", "Ibu rumah tangga")).toBe(false);
    expect(() => editParam(base, "emotion", "bogus")).toThrow();
  });
});

describe("Threads length", () => {
  it("counts characters, with emoji by UTF-8 bytes", () => {
    expect(threadsLength("halo")).toBe(4);
    expect(threadsLength("é")).toBe(1);
    expect(threadsLength("😀")).toBe(4);
    expect(threadsLength("👍🏽")).toBe(8);
  });

  it("appends CTA and link to the last post, or adds a reply when it doesn't fit", () => {
    const short = composeForPublishing([{ id: "a", text: "Story" }], "Cek link di bawah", "https://x.test/r/abc");
    expect(short).toEqual([{ id: "a", text: "Story\n\nCek link di bawah\nhttps://x.test/r/abc" }]);
    const long = composeForPublishing([{ id: "a", text: "x".repeat(480) }], "Cek link", "https://x.test/r/abc");
    expect(long).toHaveLength(2);
    expect(long[1]?.text).toBe("Cek link\nhttps://x.test/r/abc");
    expect(composeForPublishing([{ id: "a", text: "s" }], null, null)).toEqual([{ id: "a", text: "s" }]);
  });
});
