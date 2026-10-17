import { type GenerationMode, getParamDefinition, isValidParamValue, type ParamConfig, paramsForMode } from "./params";

export type ParamSuggestion = {
  value: string;
  reason?: string;
  confidence?: number;
  sourceFacts?: string[];
};
export type ParamSuggestions = Record<string, ParamSuggestion>;

export type SuggestionChange = { key: string; from: string; to: string; reason?: string };

/**
 * Applies AI suggestions to a parameter config.
 * - `locked` entries are never changed.
 * - `user_customized` entries are only replaced when `overrideCustomized` is true (explicit "Reset to AI").
 * - Invalid or non-applicable suggestions are ignored.
 */
export function applySuggestions(
  mode: GenerationMode,
  current: ParamConfig,
  suggestions: ParamSuggestions,
  options: { overrideCustomized?: boolean } = {},
): ParamConfig {
  const next: ParamConfig = { ...current };
  for (const def of paramsForMode(mode)) {
    const suggestion = suggestions[def.key];
    const entry = next[def.key];
    if (!suggestion || !isValidParamValue(def.key, suggestion.value)) continue;
    if (entry?.state === "locked") continue;
    if (entry?.state === "user_customized" && !options.overrideCustomized) continue;
    next[def.key] = {
      value: suggestion.value,
      state: "ai_suggested",
      reason: suggestion.reason,
      confidence: suggestion.confidence,
      sourceFacts: suggestion.sourceFacts,
    };
  }
  return next;
}

/** Lists what `applySuggestions` would change, so a re-suggestion can be reviewed before it is accepted. */
export function diffSuggestions(
  mode: GenerationMode,
  current: ParamConfig,
  suggestions: ParamSuggestions,
  options: { overrideCustomized?: boolean } = {},
): SuggestionChange[] {
  const next = applySuggestions(mode, current, suggestions, options);
  const changes: SuggestionChange[] = [];
  for (const [key, entry] of Object.entries(next)) {
    const before = current[key];
    if (before?.value !== entry.value) {
      changes.push({ key, from: before?.value ?? "", to: entry.value, reason: entry.reason });
    }
  }
  return changes;
}

/** A manual edit. Locked entries stay locked (the user chose the value); everything else becomes `user_customized`. */
export function editParam(current: ParamConfig, key: string, value: string): ParamConfig {
  if (!getParamDefinition(key)) throw new Error(`Unknown parameter: ${key}`);
  if (!isValidParamValue(key, value)) throw new Error(`Invalid value for ${key}`);
  const entry = current[key];
  return {
    ...current,
    [key]: {
      value,
      state: entry?.state === "locked" ? "locked" : "user_customized",
      reason: undefined,
      confidence: undefined,
      sourceFacts: undefined,
    },
  };
}

export function setLocked(current: ParamConfig, key: string, locked: boolean): ParamConfig {
  const entry = current[key];
  if (!entry) throw new Error(`Unknown parameter: ${key}`);
  if (locked) return { ...current, [key]: { ...entry, state: "locked" } };
  // Unlocking keeps the user's value and protects it from silent AI overwrites.
  return { ...current, [key]: { ...entry, state: entry.state === "locked" ? "user_customized" : entry.state } };
}

/** Flattens a config to `{key: value}` — what generation actually uses. */
export function resolveParams(config: ParamConfig): Record<string, string> {
  return Object.fromEntries(Object.entries(config).map(([k, e]) => [k, e.value]));
}
