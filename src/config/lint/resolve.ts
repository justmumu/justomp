import { createHash } from "node:crypto";
import { LintError } from "../../lint/model";
import { GO_DEFAULTS } from "./go/defaults";
import { JAVASCRIPT_DEFAULTS } from "./javascript/defaults";
import type {
  GoPolicy,
  JavascriptPolicy,
  LintPolicy,
  PythonPolicy,
} from "./model";
import { PYTHON_DEFAULTS } from "./python/defaults";

const defaults: LintPolicy = {
  python: PYTHON_DEFAULTS,
  javascript: JAVASCRIPT_DEFAULTS,
  go: GO_DEFAULTS,
};
const ruleMaps = new Set([
  "lint.javascript.eslint.rules",
  "lint.javascript.eslint.typed_rules",
  "lint.javascript.eslint.test_rules",
  "lint.javascript.eslint.react_rules",
  "lint.javascript.eslint.next_rules",
]);
const severities = new Set<unknown>(["off", "warn", "error", 0, 1, 2]);
function invalid(path: string, type: string): never {
  throw new LintError("invalid-config", `${path} must be ${type}`);
}
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(path, "an object");
  return value as Record<string, unknown>;
}
function strings(value: unknown, path: string): void {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    invalid(path, "an array of strings");
}

/** Fill structural fields, while treating user-keyed maps and arrays as values. */
export function resolveLintConfig(value?: unknown): {
  policy: LintPolicy;
  missing: boolean;
} {
  let missing = false;
  function merge(input: unknown, fallback: unknown, path: string): unknown {
    if (input === undefined) {
      missing = true;
      return structuredClone(fallback);
    }
    if (path === "lint.javascript.eslint.globals") {
      const globals = object(input, path);
      for (const [name, value] of Object.entries(globals))
        if (!["readonly", "writable", "off"].includes(String(value)))
          invalid(`${path}.${name}`, "readonly, writable or off");
      return structuredClone(globals);
    }
    if (ruleMaps.has(path)) {
      const rules = object(input, path);
      for (const [rule, setting] of Object.entries(rules)) {
        const severity = Array.isArray(setting) ? setting[0] : setting;
        if (!severities.has(severity))
          invalid(
            `${path}.${rule}`,
            "a rule severity or a non-empty severity/options array",
          );
      }
      return structuredClone(rules);
    }
    if (path === "lint.python.ruff.lint.per-file-ignores") {
      const patterns = object(input, path);
      for (const [pattern, rules] of Object.entries(patterns))
        strings(rules, `${path}.${pattern}`);
      return structuredClone(patterns);
    }
    if (Array.isArray(fallback)) {
      strings(input, path);
      return structuredClone(input);
    }
    if (fallback && typeof fallback === "object") {
      const supplied = object(input, path);
      const result = structuredClone(supplied);
      for (const [key, defaultValue] of Object.entries(fallback))
        result[key] = merge(
          Object.hasOwn(supplied, key) ? supplied[key] : undefined,
          defaultValue,
          `${path}.${key}`,
        );
      return result;
    }
    if (
      typeof input !== typeof fallback ||
      (typeof input === "number" && !Number.isFinite(input))
    )
      invalid(path, `a ${typeof fallback}`);
    return input;
  }
  const policy = merge(value, defaults, "lint") as LintPolicy;
  return { policy, missing };
}

/** Object ordering is immaterial; native rule option and pattern arrays retain order. */
export function lintPolicyKey(
  policy: LintPolicy | PythonPolicy | JavascriptPolicy | GoPolicy,
): string {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(policy)))
    .digest("hex");
}
