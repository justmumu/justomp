import { createHash } from "node:crypto";
import { LintError } from "../../lint/model";
import { GO_DEFAULTS } from "./go/defaults";
import { JAVASCRIPT_DEFAULTS } from "./javascript/defaults";
import { migrateJavascriptPolicy } from "./javascript/migrate";
import { type LintPolicy } from "./model";
import { PYTHON_DEFAULTS } from "./python/defaults";

const defaults: LintPolicy = {
  python: PYTHON_DEFAULTS,
  javascript: JAVASCRIPT_DEFAULTS,
  go: GO_DEFAULTS,
};
const ruleMaps = new Set([
  "lint.javascript.biome.rules",
  "lint.javascript.biome.typed_rules",
  "lint.javascript.biome.test_rules",
  "lint.javascript.biome.react_rules",
  "lint.javascript.biome.next_rules",
]);
const severities = new Set<unknown>(["off", "info", "warn", "error"]);
const groups = new Set([
  "a11y",
  "complexity",
  "correctness",
  "nursery",
  "performance",
  "security",
  "style",
  "suspicious",
]);
function invalid(path: string, type: string): never {
  throw new LintError("invalid-config", `${path} must be ${type}`);
}
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(path, "an object");
  }
  return value as Record<string, unknown>;
}
function strings(value: unknown, path: string): void {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    invalid(path, "an array of strings");
  }
}

function validateSetting(value: unknown, path: string, levels: Set<unknown>, fixes: boolean): void {
  if (levels.has(value)) {
    return;
  }
  const setting = object(value, path);
  if (!levels.has(setting.level)) {
    invalid(`${path}.level`, "a native severity");
  }
  for (const key of Object.keys(setting)) {
    if (key !== "level" && key !== "options" && !(fixes && key === "fix")) {
      invalid(`${path}.${key}`, "a supported native rule attribute");
    }
  }
  if (Object.hasOwn(setting, "options")) {
    object(setting.options, `${path}.options`);
  }
  if (Object.hasOwn(setting, "fix") && !["none", "safe", "unsafe"].includes(String(setting.fix))) {
    invalid(`${path}.fix`, "none, safe or unsafe");
  }
}

/** Fill structural fields, while treating user-keyed maps and arrays as values. */
export function resolveLintConfig(value?: unknown): {
  policy: LintPolicy;
  missing: boolean;
} {
  const migration = migrateJavascriptPolicy(value);
  let missing = migration.migrated;
  function merge(input: unknown, fallback: unknown, path: string): unknown {
    if (input === undefined) {
      missing = true;
      return structuredClone(fallback);
    }
    if (path === "lint.javascript.biome") {
      const supplied = object(input, path);
      for (const key of ["extends", "plugins", "$schema", "root", "files", "overrides", "vcs"]) {
        if (Object.hasOwn(supplied, key)) {
          invalid(
            `${path}.${key}`,
            "absent from managed policy; configuration discovery and file scope are owned by Justomp",
          );
        }
      }
    }
    if (path === "lint.javascript.biome.organize_imports") {
      validateSetting(input, path, new Set(["on", "off"]), false);
      return structuredClone(input);
    }
    if (ruleMaps.has(path)) {
      const rules = object(input, path);
      for (const [group, settings] of Object.entries(rules)) {
        if (!groups.has(group)) {
          invalid(`${path}.${group}`, "a native rule group");
        }
        for (const [rule, setting] of Object.entries(object(settings, `${path}.${group}`))) {
          validateSetting(setting, `${path}.${group}.${rule}`, severities, true);
        }
      }
      return structuredClone(rules);
    }
    if (path === "lint.python.ruff.lint.per-file-ignores") {
      const patterns = object(input, path);
      for (const [pattern, rules] of Object.entries(patterns)) {
        strings(rules, `${path}.${pattern}`);
      }
      return structuredClone(patterns);
    }
    if (Array.isArray(fallback)) {
      strings(input, path);
      return structuredClone(input);
    }
    if (fallback && typeof fallback === "object") {
      const supplied = object(input, path);
      const result = structuredClone(supplied);
      for (const [key, defaultValue] of Object.entries(fallback)) {
        result[key] = merge(Object.hasOwn(supplied, key) ? supplied[key] : undefined, defaultValue, `${path}.${key}`);
      }
      return result;
    }
    if (typeof input !== typeof fallback || (typeof input === "number" && !Number.isFinite(input))) {
      invalid(path, `a ${typeof fallback}`);
    }
    return input;
  }
  const policy = merge(migration.value, defaults, "lint") as LintPolicy;
  return { policy, missing };
}

/** Object ordering is immaterial; native rule option and pattern arrays retain order. */
export function lintPolicyKey(policy: unknown): string {
  function activeJavascript(value: unknown): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "biome")) {
      return value;
    }
    const { eslint: _legacy, ...active } = value as Record<string, unknown>;
    return active;
  }
  const active =
    policy && typeof policy === "object" && !Array.isArray(policy) && Object.hasOwn(policy, "javascript")
      ? {
          ...policy,
          javascript: activeJavascript((policy as Record<string, unknown>).javascript),
        }
      : activeJavascript(policy);
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(canonical);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, canonical(item)]),
      );
    }
    return value;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(active)))
    .digest("hex");
}
