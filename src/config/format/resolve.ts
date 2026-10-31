import { lintPolicyKey } from "../lint/resolve";
import { FORMAT_DEFAULTS } from "./defaults";
import type { FormatPolicy } from "./model";

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}
/** Attribute-level compatibility: new setting, legacy setting, source default. */
export function resolveFormatConfig(
  value?: unknown,
  legacy?: unknown,
): { policy: FormatPolicy; missing: boolean } {
  const raw = value === undefined ? {} : object(value, "format");
  const prior =
    legacy === undefined ? {} : object(legacy, "lint.javascript.prettier");
  const supplied =
    raw.prettier === undefined ? {} : object(raw.prettier, "format.prettier");
  let missing = value === undefined;
  const policy = structuredClone(raw);
  for (const key of ["include", "exclude"] as const) {
    if (!Object.hasOwn(raw, key)) missing = true;
    const patterns = Object.hasOwn(raw, key) ? raw[key] : FORMAT_DEFAULTS[key];
    if (
      !Array.isArray(patterns) ||
      !patterns.every((item) => typeof item === "string")
    )
      throw new Error(`format.${key} must be an array of strings`);
    policy[key] = [...patterns];
  }
  const prettier = { ...structuredClone(prior), ...structuredClone(supplied) };
  for (const [key, fallback] of Object.entries(FORMAT_DEFAULTS.prettier)) {
    if (!Object.hasOwn(supplied, key)) missing = true;
    if (!Object.hasOwn(prettier, key)) prettier[key] = fallback;
    if (
      typeof prettier[key] !== typeof fallback ||
      (typeof prettier[key] === "number" && !Number.isFinite(prettier[key]))
    )
      throw new Error(`format.prettier.${key} must be a ${typeof fallback}`);
  }
  // Legacy extensions also need to be materialized, not lost during the first flush.
  if (Object.keys(prior).some((key) => !Object.hasOwn(supplied, key)))
    missing = true;
  policy.prettier = prettier;
  return { policy: policy as FormatPolicy, missing };
}
export const formatPolicyKey = (policy: FormatPolicy): string =>
  lintPolicyKey(policy);
