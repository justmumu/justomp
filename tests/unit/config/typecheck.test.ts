import { expect, test } from "bun:test";
import { resolveTypecheckConfig, typecheckPolicyKey } from "../../../src/config/typecheck/resolve";

test("typecheck defaults apply strict policy equally to source and tests", () => {
  const { policy, missing } = resolveTypecheckConfig();
  expect(missing).toBe(true);
  expect(policy.python).toEqual({
    pyright: {
      typeCheckingMode: "strict",
      diagnostics: {
        reportImplicitOverride: "error",
        reportUnnecessaryTypeIgnoreComment: "error",
        reportMissingTypeStubs: "error",
      },
    },
  });
  expect(policy.javascript.compilerOptions).toEqual({
    strict: true,
    allowJs: true,
    checkJs: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noImplicitOverride: true,
    skipLibCheck: false,
  });
  expect(policy.go.build_tags).toEqual([]);
  expect(resolveTypecheckConfig(policy)).toEqual({ policy, missing: false });
});

test("missing attributes fill but existing false, maps, lists and unknown keys survive", () => {
  const input = {
    future: { enabled: true },
    python: { pyright: { diagnostics: {} } },
    javascript: {
      compilerOptions: { strict: false, noImplicitAny: false, futureOption: 3 },
    },
    go: { build_tags: [] },
  };
  const { policy } = resolveTypecheckConfig(input);
  expect(policy.python.pyright.diagnostics).toEqual({});
  expect(policy.python.pyright.typeCheckingMode).toBe("strict");
  expect(policy.javascript.compilerOptions.strict).toBe(false);
  expect(policy.javascript.compilerOptions.noImplicitAny).toBe(false);
  expect(policy.javascript.compilerOptions.futureOption).toBe(3);
  expect(policy.go.build_tags).toEqual([]);
  expect(policy.future).toEqual({ enabled: true });
  expect(input.python.pyright).toEqual({ diagnostics: {} });
});

test.each([
  null,
  { python: [] },
  { python: { pyright: { typeCheckingMode: "loud" } } },
  { python: { pyright: { diagnostics: { reportMissingImports: "silent" } } } },
  { python: { pyright: { diagnostics: [] } } },
  { javascript: { compilerOptions: { strict: "true" } } },
  { javascript: { compilerOptions: { noImplicitAny: "false" } } },
  { go: { build_tags: [1] } },
])("invalid known typecheck values fail: %j", (value) => {
  expect(() => resolveTypecheckConfig(value)).toThrow("typecheck");
});

test("policy hash ignores object ordering and tracks effective policy edits", () => {
  const a = resolveTypecheckConfig({
    python: {
      pyright: {
        diagnostics: {
          reportMissingImports: "warning",
          reportUnusedImport: false,
        },
      },
    },
  }).policy;
  const b = resolveTypecheckConfig({
    python: {
      pyright: {
        diagnostics: {
          reportUnusedImport: false,
          reportMissingImports: "warning",
        },
      },
    },
  }).policy;
  expect(typecheckPolicyKey(a)).toBe(typecheckPolicyKey(b));
  b.javascript.compilerOptions.checkJs = false;
  expect(typecheckPolicyKey(a)).not.toBe(typecheckPolicyKey(b));
});

test("JavaScript exclusions default empty, replace arrays and affect policy freshness", () => {
  const defaults = resolveTypecheckConfig();
  expect(defaults.policy.javascript.exclude).toEqual([]);
  const excluded = resolveTypecheckConfig({ javascript: { exclude: [".private/**"] } });
  expect(excluded.policy.javascript.exclude).toEqual([".private/**"]);
  expect(resolveTypecheckConfig(excluded.policy).missing).toBe(false);
  expect(typecheckPolicyKey(excluded.policy)).not.toBe(typecheckPolicyKey(defaults.policy));
  expect(resolveTypecheckConfig({ javascript: { exclude: [] } }).policy.javascript.exclude).toEqual([]);
  for (const exclude of [null, "**/*", [1]]) {
    expect(() => resolveTypecheckConfig({ javascript: { exclude } })).toThrow("typecheck.javascript.exclude");
  }
});
