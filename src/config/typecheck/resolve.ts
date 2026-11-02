import { createHash } from "node:crypto";
import { TypecheckError } from "../../typecheck/model";
import { GO_DEFAULTS } from "./go/defaults";
import { JAVASCRIPT_DEFAULTS } from "./javascript/defaults";
import {
  type GoTypecheckPolicy,
  type JavascriptTypecheckPolicy,
  type PythonTypecheckPolicy,
  type TypecheckPolicy,
} from "./model";
import { PYTHON_DEFAULTS } from "./python/defaults";

const defaults: TypecheckPolicy = {
  python: PYTHON_DEFAULTS,
  javascript: JAVASCRIPT_DEFAULTS,
  go: GO_DEFAULTS,
};
const diagnosticLevels = new Set<unknown>(["none", "information", "warning", "error", true, false]);
const compilerBooleans = new Set([
  "strict",
  "allowJs",
  "checkJs",
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
  "noImplicitOverride",
  "skipLibCheck",
  "alwaysStrict",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "strictBuiltinIteratorReturn",
  "noImplicitAny",
  "noImplicitThis",
  "useUnknownInCatchVariables",
]);
const pyrightBooleans = new Set([
  "strictListInference",
  "strictDictionaryInference",
  "strictSetInference",
  "analyzeUnannotatedFunctions",
  "enableTypeIgnoreComments",
  "strictParameterNoneValue",
  "deprecateTypingAliases",
  "disableBytesTypePromotions",
  "enableExperimentalFeatures",
]);
function invalid(path: string, type: string): never {
  throw new TypecheckError("invalid-config", `${path} must be ${type}`);
}
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(path, "an object");
  }
  return value as Record<string, unknown>;
}

/** Structural fields fill independently; user diagnostics and arrays replace whole values. */
export function resolveTypecheckConfig(value?: unknown): {
  policy: TypecheckPolicy;
  missing: boolean;
} {
  let missing = false;
  function merge(input: unknown, fallback: unknown, path: string): unknown {
    if (input === undefined) {
      missing = true;
      return structuredClone(fallback);
    }
    if (path === "typecheck.python.pyright.diagnostics") {
      const rules = object(input, path);
      for (const [key, level] of Object.entries(rules)) {
        if (!diagnosticLevels.has(level)) {
          invalid(`${path}.${key}`, "a Pyright diagnostic level or boolean");
        }
      }
      return structuredClone(rules);
    }
    if (Array.isArray(fallback)) {
      if (!Array.isArray(input) || !input.every((item) => typeof item === "string")) {
        invalid(path, "an array of strings");
      }
      return structuredClone(input);
    }
    if (fallback && typeof fallback === "object") {
      const supplied = object(input, path);
      const result = structuredClone(supplied);
      for (const [key, defaultValue] of Object.entries(fallback)) {
        result[key] = merge(Object.hasOwn(supplied, key) ? supplied[key] : undefined, defaultValue, `${path}.${key}`);
      }
      const booleans =
        path === "typecheck.javascript.compilerOptions"
          ? compilerBooleans
          : path === "typecheck.python.pyright"
            ? pyrightBooleans
            : undefined;
      for (const [key, item] of Object.entries(result)) {
        if (booleans?.has(key) && typeof item !== "boolean") {
          invalid(`${path}.${key}`, "a boolean");
        }
      }
      return result;
    }
    if (typeof input !== typeof fallback) {
      invalid(path, `a ${typeof fallback}`);
    }
    if (
      path === "typecheck.python.pyright.typeCheckingMode" &&
      !["off", "basic", "standard", "strict"].includes(String(input))
    ) {
      invalid(path, "off, basic, standard or strict");
    }
    return input;
  }
  return {
    policy: merge(value, defaults, "typecheck") as TypecheckPolicy,
    missing,
  };
}

/** Map ordering is immaterial; array ordering remains part of the policy. */
export function typecheckPolicyKey(
  policy: TypecheckPolicy | PythonTypecheckPolicy | JavascriptTypecheckPolicy | GoTypecheckPolicy,
): string {
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
    .update(JSON.stringify(canonical(policy)))
    .digest("hex");
}
