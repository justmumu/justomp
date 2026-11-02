import { createHash } from "node:crypto";
import picomatch from "picomatch";
import { TestError } from "../../testing/model";
import { mergeFields } from "../merge";
import { GO_DEFAULTS } from "./go/defaults";
import { JAVASCRIPT_DEFAULTS } from "./javascript/defaults";
import { type TestPolicy } from "./model";
import { PYTHON_DEFAULTS } from "./python/defaults";

const defaults: TestPolicy = {
  python: PYTHON_DEFAULTS,
  javascript: JAVASCRIPT_DEFAULTS,
  go: GO_DEFAULTS,
};
function invalid(path: string): never {
  throw new TestError("invalid-config", `Invalid test policy at ${path}`);
}
function patterns(input: unknown, path: string): string[] {
  if (!Array.isArray(input)) {
    invalid(path);
  }
  for (const item of input) {
    validatePattern(item, path);
  }
  return [...input];
}
function validatePattern(item: unknown, path: string): void {
  if (
    typeof item !== "string" ||
    !item ||
    item.startsWith("/") ||
    /^[a-zA-Z]:/.test(item) ||
    item.includes("\\") ||
    item.split("/").includes("..") ||
    item.startsWith("!") ||
    item.includes("\0")
  ) {
    invalid(path);
  }
  try {
    picomatch.makeRe(item, { strictBrackets: true });
  } catch {
    invalid(path);
  }
}
function scalar(input: unknown, fallback: unknown, path: string): unknown {
  if (typeof input !== typeof fallback) {
    invalid(path);
  }
  if (
    typeof fallback === "number" &&
    (typeof input !== "number" || !Number.isFinite(input) || input < 0 || input > 100)
  ) {
    invalid(path);
  }
  return input;
}
function record(input: unknown, path: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    invalid(path);
  }
  return input as Record<string, unknown>;
}
export function resolveTestPolicy(
  value: unknown,
  defaults: TestPolicy,
  label: string,
): {
  policy: TestPolicy;
  missing: boolean;
} {
  let missing = false;
  function merge(input: unknown, fallback: unknown, path: string): unknown {
    if (input === undefined) {
      missing = true;
      return structuredClone(fallback);
    }
    if (Array.isArray(fallback)) {
      return patterns(input, path);
    }
    if (fallback && typeof fallback === "object") {
      const result = mergeFields(record(input, path), fallback, path, merge);
      return result;
    }
    return scalar(input, fallback, path);
  }
  return { policy: merge(value, defaults, label) as TestPolicy, missing };
}
export function testPolicyKey(policy: unknown): string {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(canonical);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, canonical(v)]),
      );
    }
    return value;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(policy)))
    .digest("hex");
}

export function resolveTestConfig(value?: unknown) {
  return resolveTestPolicy(value, defaults, "test");
}
