import { isDeepStrictEqual } from "node:util";
import { LintError } from "../../../lint/model";
import type { BiomeRuleMap, BiomeRuleSetting } from "../model";
import { JAVASCRIPT_DEFAULTS } from "./defaults";
import { LEGACY_ESLINT_DEFAULTS } from "./legacy-defaults";
import { LEGACY_RULES } from "./legacy-rules";

const fields = [
  "rules",
  "typed_rules",
  "test_rules",
  "react_rules",
  "next_rules",
] as const;
type Field = (typeof fields)[number];
// ESLint disables these core rules in favor of their TypeScript extensions.
// Their shipped `off` values are not competing user overrides.
const typedReplacements: Record<string, string> = {
  "no-array-constructor": "@typescript-eslint/no-array-constructor",
  "no-implied-eval": "@typescript-eslint/no-implied-eval",
  "no-unused-expressions": "@typescript-eslint/no-unused-expressions",
  "no-unused-vars": "@typescript-eslint/no-unused-vars",
  "no-useless-constructor": "@typescript-eslint/no-useless-constructor",
  "no-throw-literal": "@typescript-eslint/only-throw-error",
  "prefer-promise-reject-errors":
    "@typescript-eslint/prefer-promise-reject-errors",
  "require-await": "@typescript-eslint/require-await",
};

function fail(path: string, reason: string): never {
  throw new LintError(
    "invalid-config",
    `${path}: ${reason}; provide lint.javascript.biome policy or remove this legacy customization`,
  );
}
function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(path, "expected an object");
  return value as Record<string, unknown>;
}
function level(value: unknown, path: string): "off" | "warn" | "error" {
  if (value === "off" || value === 0) return "off";
  if (value === "warn" || value === 1) return "warn";
  if (value === "error" || value === 2) return "error";
  return fail(path, "unsupported rule severity");
}
function setting(
  rule: string,
  value: unknown,
  field: Field,
  path: string,
): BiomeRuleSetting {
  const tuple = Array.isArray(value) ? value : [value];
  const severity = level(tuple[0], path);
  if (severity === "off") return "off";
  const shipped = isDeepStrictEqual(value, LEGACY_ESLINT_DEFAULTS[field][rule]);
  // Known shipped option deltas are intentional policy changes; custom options
  // require an exact supported translation rather than a best-effort guess.
  if (
    rule === "eqeqeq" &&
    (tuple.length === 1 || isDeepStrictEqual(tuple.slice(1), ["always"]))
  )
    return { level: severity, options: { ignoreNull: false } };
  if (rule === "no-console" && tuple.length === 2) {
    const options = record(tuple[1], path);
    if (
      Object.keys(options).length === 1 &&
      Array.isArray(options.allow) &&
      options.allow.every((item) => typeof item === "string")
    )
      return {
        level: severity,
        options: { allow: structuredClone(options.allow) },
      };
  }
  if (rule === "@typescript-eslint/consistent-type-imports" && shipped)
    return { level: severity, options: { style: "inlineType" } };
  if (rule === "complexity" && shipped)
    return { level: severity, options: { maxAllowedComplexity: 10 } };
  if (
    tuple.length > 1 &&
    !shipped &&
    !(rule === "curly" && isDeepStrictEqual(tuple.slice(1), ["all"]))
  )
    fail(path, "custom options have no verified Biome translation");
  return severity;
}
function rules(
  value: unknown,
  field: Field,
): { rules: BiomeRuleMap; assist?: "off" | "on" } {
  const path = `lint.javascript.eslint.${field}`;
  const input = record(value, path);
  if (isDeepStrictEqual(input, LEGACY_ESLINT_DEFAULTS[field]))
    return {
      rules: structuredClone(JAVASCRIPT_DEFAULTS.biome[field]),
      ...(field === "rules" ? { assist: "on" as const } : {}),
    };
  const result: BiomeRuleMap = {};
  const seen = new Map<
    string,
    { value: BiomeRuleSetting; rule: string; shipped: boolean }
  >();
  let assist: "off" | "on" | undefined = field === "rules" ? "off" : undefined;
  for (const [rule, value] of Object.entries(input)) {
    const rulePath = `${path}.${rule}`;
    const targets = Object.hasOwn(LEGACY_RULES, rule)
      ? LEGACY_RULES[rule]
      : undefined;
    if (!targets) fail(rulePath, "no verified Biome counterpart");
    const converted = setting(rule, value, field, rulePath);
    const shipped = isDeepStrictEqual(
      value,
      LEGACY_ESLINT_DEFAULTS[field][rule],
    );
    const replacement = Object.hasOwn(typedReplacements, rule)
      ? typedReplacements[rule]
      : undefined;
    if (
      field === "typed_rules" &&
      shipped &&
      converted === "off" &&
      replacement &&
      Object.hasOwn(input, replacement)
    )
      continue;
    if (targets.length === 0 && !shipped && converted !== "off")
      fail(rulePath, "no verified Biome counterpart");
    for (const target of targets) {
      const previous = seen.get(target);
      if (
        previous &&
        !isDeepStrictEqual(previous.value, converted) &&
        !(previous.shipped && shipped)
      )
        fail(rulePath, `conflicts with ${path}.${previous.rule} at ${target}`);
      seen.set(target, { value: converted, rule, shipped });
      if (target === "assist/source/organizeImports") {
        if (field !== "rules")
          fail(
            rulePath,
            "scoped import assists cannot be represented by the shared organize_imports setting",
          );
        if (converted === "warn")
          fail(rulePath, "import assists do not have warning severity");
        assist = converted === "off" ? "off" : "on";
      } else {
        const [group, name] = target.split(".");
        if (!group || !name)
          throw new Error(`Invalid reviewed migration target: ${target}`);
        result[group] ??= {};
        result[group][name] = converted;
      }
    }
  }
  return { rules: result, ...(assist === undefined ? {} : { assist }) };
}

/** Preserve legacy data; add native policy only when none was explicitly supplied. */
export function migrateJavascriptPolicy(value: unknown): {
  value: unknown;
  migrated: boolean;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { value, migrated: false };
  const lint = value as Record<string, unknown>;
  if (
    !lint.javascript ||
    typeof lint.javascript !== "object" ||
    Array.isArray(lint.javascript)
  )
    return { value, migrated: false };
  const javascript = lint.javascript as Record<string, unknown>;
  if (
    Object.hasOwn(javascript, "biome") ||
    !Object.hasOwn(javascript, "eslint")
  )
    return { value, migrated: false };
  const legacy = record(javascript.eslint, "lint.javascript.eslint");
  const biome: Record<string, unknown> = {};
  for (const key of Object.keys(legacy))
    if (key !== "globals" && !fields.includes(key as Field))
      fail(`lint.javascript.eslint.${key}`, "unsupported legacy policy field");
  for (const field of fields) {
    if (!Object.hasOwn(legacy, field)) continue;
    const converted = rules(legacy[field], field);
    biome[field] = converted.rules;
    if (converted.assist !== undefined)
      biome.organize_imports = converted.assist;
  }
  if (Object.hasOwn(legacy, "globals")) {
    const globals = record(legacy.globals, "lint.javascript.eslint.globals");
    biome.globals = Object.entries(globals).flatMap(([name, permission]) => {
      if (permission === "off") return [];
      if (permission !== "readonly")
        fail(
          `lint.javascript.eslint.globals.${name}`,
          "global write permissions have no verified native equivalent",
        );
      return [name];
    });
  }
  return {
    value: { ...lint, javascript: { ...javascript, biome } },
    migrated: true,
  };
}
