import { expect, test } from "bun:test";
import { LEGACY_ESLINT_DEFAULTS } from "../../../src/config/lint/javascript/legacy-defaults";
import { lintPolicyKey, resolveLintConfig } from "../../../src/config/lint/resolve";

test("JavaScript policy declares native globals and preserves empty globals", () => {
  expect(resolveLintConfig().policy.javascript.biome.globals).toContain("console");
  expect(resolveLintConfig({ javascript: { biome: { globals: [] } } }).policy.javascript.biome.globals).toEqual([]);
});

test("native maps are authoritative over legacy data and do not hash archived rules", () => {
  const a = resolveLintConfig({
    javascript: {
      biome: { rules: {} },
      eslint: { rules: { "unknown/rule": ["error", { impossible: true }] } },
    },
  });
  const b = resolveLintConfig({
    javascript: {
      biome: { rules: {} },
      eslint: { rules: { "another/rule": "warn" } },
    },
  });
  expect(a.policy.javascript.biome.rules).toEqual({});
  expect(a.policy.javascript.eslint).toEqual({
    rules: { "unknown/rule": ["error", { impossible: true }] },
  });
  expect(lintPolicyKey(a.policy)).toBe(lintPolicyKey(b.policy));
  expect(lintPolicyKey(a.policy.javascript)).toBe(lintPolicyKey(b.policy.javascript));
});

test("legacy sparse rule maps translate severity and supported options without refilling", () => {
  const input = {
    javascript: {
      eslint: {
        globals: { console: "readonly", custom: "off" },
        rules: { "no-console": ["warn", { allow: [] }], "no-debugger": "off" },
        typed_rules: {},
      },
    },
  };
  const result = resolveLintConfig(input);
  expect(result.policy.javascript.biome.rules).toEqual({
    suspicious: {
      noConsole: { level: "warn", options: { allow: [] } },
      noDebugger: "off",
    },
  });
  expect(result.policy.javascript.biome.typed_rules).toEqual({});
  expect(result.policy.javascript.biome.globals).toEqual(["console"]);
  expect(result.missing).toBe(true);
  expect(input.javascript.eslint.rules["no-debugger"]).toBe("off");
  expect(resolveLintConfig(result.policy).missing).toBe(false);
});

test.each([
  { rules: { "custom/unknown": "error" } },
  { rules: { "no-debugger": ["error", { extra: true }] } },
  {
    typed_rules: {
      "@typescript-eslint/ban-ts-comment": ["error", { minimumDescriptionLength: 20 }],
    },
  },
  { globals: { custom: "writable" } },
  { rules: { "no-empty": "error", "no-empty-static-block": "off" } },
])("untranslatable legacy settings fail with a named migration remedy: %j", (eslint) => {
  const input = { javascript: { eslint } };
  const before = structuredClone(input);
  expect(() => resolveLintConfig(input)).toThrow("lint.javascript.eslint.");
  expect(() => resolveLintConfig(input)).toThrow("biome");
  expect(input).toEqual(before);
});

test("the complete frozen shipped ESLint policy migrates to the explicit native baseline", () => {
  const legacy = structuredClone(LEGACY_ESLINT_DEFAULTS);
  const result = resolveLintConfig({
    javascript: { eslint: legacy, prettier: { singleQuote: true } },
    future: { retained: true },
  });
  expect(result.policy.javascript.biome).toEqual(resolveLintConfig().policy.javascript.biome);
  expect(result.policy.javascript.eslint).toEqual(legacy);
  expect(result.policy.javascript.prettier.singleQuote).toBe(true);
  expect(result.policy.future).toEqual({ retained: true });
  expect(result.policy.javascript.biome.react_rules.nursery?.useControlLabel).toBe("off");
  expect(result.policy.javascript.biome.typed_rules.correctness?.noUnusedImports).toBe("error");
  expect(resolveLintConfig(result.policy).missing).toBe(false);
});

test("empty legacy maps disable their own defaults including import assists", () => {
  const result = resolveLintConfig({
    javascript: {
      eslint: {
        rules: {},
        typed_rules: {},
        test_rules: {},
        react_rules: {},
        next_rules: {},
        globals: {},
      },
    },
  });
  expect(result.policy.javascript.biome).toEqual({
    rules: {},
    typed_rules: {},
    test_rules: {},
    react_rules: {},
    next_rules: {},
    globals: [],
    organize_imports: "off",
  });
});

test.each([
  { rules: { recommended: true } },
  { rules: { suspicious: { noDebugger: { level: "error", fix: "always" } } } },
  { rules: { suspicious: { noDebugger: { level: "error", options: [] } } } },
  { organize_imports: { level: "on", fix: "safe" } },
  { globals: {} },
])("native configuration uses bounded rule and assist settings: %j", (biome) => {
  expect(() => resolveLintConfig({ javascript: { biome } })).toThrow("lint.javascript.biome");
});

test("native fix classification and disabled assists survive without default merging", () => {
  const rules = {
    suspicious: {
      noConsole: {
        level: "warn" as const,
        fix: "safe" as const,
        options: { allow: [] },
      },
    },
  };
  const result = resolveLintConfig({
    javascript: { biome: { rules, organize_imports: "off" } },
  });
  expect(result.policy.javascript.biome.rules).toEqual(rules);
  expect(result.policy.javascript.biome.organize_imports).toBe("off");
});

test.each(["extends", "plugins", "$schema", "root", "files", "overrides", "vcs"])(
  "managed policy rejects native config redirection: %s",
  (key) => {
    expect(() => resolveLintConfig({ javascript: { biome: { [key]: [] } } })).toThrow(`lint.javascript.biome.${key}`);
  },
);

test("unrelated stored fields and nested rule option data retain their own hashes", () => {
  const a = resolveLintConfig({
    javascript: {
      biome: {
        future: { kept: true },
        rules: {
          suspicious: {
            noConsole: {
              level: "warn",
              options: { biome: 1, eslint: "first" },
            },
          },
        },
      },
    },
  });
  const b = resolveLintConfig({
    javascript: {
      biome: {
        future: { kept: true },
        rules: {
          suspicious: {
            noConsole: {
              level: "warn",
              options: { biome: 1, eslint: "second" },
            },
          },
        },
      },
    },
  });
  expect(a.policy.javascript.biome.future).toEqual({ kept: true });
  expect(lintPolicyKey(a.policy)).not.toBe(lintPolicyKey(b.policy));
});

test("legacy typed replacements preserve custom severity independent of key order", () => {
  for (const reverse of [false, true]) {
    const typed = {
      ...LEGACY_ESLINT_DEFAULTS.typed_rules,
      "@typescript-eslint/no-unused-vars": "warn",
    };
    const result = resolveLintConfig({
      javascript: {
        eslint: {
          typed_rules: Object.fromEntries(reverse ? Object.entries(typed).reverse() : Object.entries(typed)),
        },
      },
    });
    expect(result.policy.javascript.biome.typed_rules.correctness).toMatchObject({
      noUnusedVariables: "warn",
      noUnusedImports: "warn",
      noUnusedFunctionParameters: "warn",
    });
  }
});

test("unrelated legacy customization does not make shipped aliases order dependent", () => {
  const typed = {
    ...LEGACY_ESLINT_DEFAULTS.typed_rules,
    "@typescript-eslint/no-explicit-any": "warn",
  };
  const convert = (entries: [string, unknown][]) =>
    resolveLintConfig({
      javascript: { eslint: { typed_rules: Object.fromEntries(entries) } },
    }).policy.javascript.biome.typed_rules;
  const forward = convert(Object.entries(typed));
  expect(convert(Object.entries(typed).reverse())).toEqual(forward);
  expect(forward.correctness?.noUnusedImports).toBe("error");
});

test("sparse disabled core rule stays disabled without its typed replacement", () => {
  const result = resolveLintConfig({
    javascript: {
      eslint: {
        typed_rules: { "no-unused-vars": "off" },
      },
    },
  });
  expect(result.policy.javascript.biome.typed_rules).toEqual({
    correctness: {
      noUnusedVariables: "off",
      noUnusedImports: "off",
      noUnusedFunctionParameters: "off",
    },
  });
});
