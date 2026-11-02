import { expect, test } from "bun:test";
import { type BiomeRuleMap } from "../../../src/config/lint/model";
import { lintPolicyKey, resolveLintConfig } from "../../../src/config/lint/resolve";

const pythonPolicy = {
  ruff: {
    "line-length": 120,
    exclude: [
      ".bzr",
      ".direnv",
      ".eggs",
      ".git",
      ".git-rewrite",
      ".hg",
      ".mypy_cache",
      ".nox",
      ".pants.d",
      ".pytype",
      ".ruff_cache",
      ".svn",
      ".tox",
      ".venv",
      "__pypackages__",
      "_build",
      "buck-out",
      "dist",
      "node_modules",
      "venv",
    ],
    "extend-exclude": [".private"],
    lint: {
      select:
        "F E W B BLE RET PLC PLE PLW UP I SIM C4 C90 PTH RUF S ASYNC ARG DTZ T20 LOG G PT TID TC PERF FBT N ANN T10 SLF TRY PIE ERA A PGH RSE FURB INP EXE D".split(
          " ",
        ),
      ignore: "E501 COM812 ISC001 TRY003 EM101 EM102 TID252 S603 S607".split(" "),
      "per-file-ignores": {
        "tests/*": "S101 SLF001 ARG T201 PT011 ANN INP001 D".split(" "),
        "scripts/*": "INP001 T201 FBT001 FBT002".split(" "),
      },
      isort: { "combine-as-imports": true },
      pydocstyle: { convention: "google" },
    },
    format: {
      "quote-style": "double",
      "indent-style": "space",
      "skip-magic-trailing-comma": false,
      "line-ending": "auto",
    },
  },
};

test("Python defaults match the recorded policy without project-specific src", () => {
  expect(resolveLintConfig().policy.python).toEqual(pythonPolicy);
});

test("missing structural leaves fill while arrays and user rule maps replace", () => {
  const input = {
    future: { value: 2 },
    python: {
      ruff: { exclude: [], lint: { ignore: [], "per-file-ignores": {} } },
    },
    javascript: {
      biome: {
        rules: {},
        test_rules: {
          suspicious: { noConsole: { level: "warn", options: { allow: [] } } },
        },
      },
    },
    go: { golangci: { linters: { enable: [] } } },
  };
  const { policy, missing } = resolveLintConfig(input);
  expect(missing).toBe(true);
  expect(policy.python.ruff["line-length"]).toBe(120);
  expect(policy.python.ruff.exclude).toEqual([]);
  expect(policy.python.ruff.lint.ignore).toEqual([]);
  expect(policy.python.ruff.lint["per-file-ignores"]).toEqual({});
  expect(policy.javascript.biome.rules).toEqual({});
  expect(policy.javascript.biome.test_rules).toEqual({
    suspicious: { noConsole: { level: "warn", options: { allow: [] } } },
  });
  expect(policy.go.golangci.linters.enable).toEqual([]);
  expect(policy.future).toEqual({ value: 2 });
  expect(resolveLintConfig(policy)).toEqual({ policy, missing: false });
  expect(input.python.ruff.lint).toEqual({
    ignore: [],
    "per-file-ignores": {},
  });
});

test.each([
  null,
  { python: [] },
  { python: { ruff: { "line-length": "120" } } },
  { python: { ruff: { lint: { ignore: [4] } } } },
  { python: { ruff: { lint: { "per-file-ignores": { "tests/*": false } } } } },
  { javascript: { biome: { rules: { suspicious: { noDebugger: "loud" } } } } },
  { javascript: { biome: { rules: { suspicious: { noDebugger: [] } } } } },
  { javascript: { prettier: { semi: "yes" } } },
  { go: { golangci: { linters: { enable: {} } } } },
])("invalid known policy values are rejected: %j", (value) => {
  expect(() => resolveLintConfig(value)).toThrow("lint");
});

test("policy keys are stable across object order but preserve array order", () => {
  const a = resolveLintConfig({
    javascript: {
      biome: {
        rules: {
          suspicious: {
            noDebugger: "error",
            noConsole: { level: "warn", options: { z: 1, y: 2 } },
          },
        },
      },
    },
  }).policy;
  const b = resolveLintConfig({
    javascript: {
      biome: {
        rules: {
          suspicious: {
            noConsole: { level: "warn", options: { y: 2, z: 1 } },
            noDebugger: "error",
          },
        },
      },
    },
  }).policy;
  expect(lintPolicyKey(a)).toBe(lintPolicyKey(b));
  b.python.ruff.lint.ignore.reverse();
  expect(lintPolicyKey(a)).not.toBe(lintPolicyKey(b));
});

test("JS and Go defaults contain explicit strict checks and formatter options", () => {
  const { javascript: js, go } = resolveLintConfig().policy;
  expect((js.biome.rules as Partial<BiomeRuleMap>).suspicious?.noDoubleEquals).toEqual({
    level: "error",
    options: { ignoreNull: false },
  });
  expect((js.biome.rules as Partial<BiomeRuleMap>).suspicious?.noConsole).toEqual({
    level: "error",
    options: { allow: ["warn", "error"] },
  });
  expect((js.biome.typed_rules as Partial<BiomeRuleMap>).nursery?.noFloatingPromises).toBe("error");
  expect((js.biome.typed_rules as Partial<BiomeRuleMap>).suspicious?.noExplicitAny).toBe("error");
  expect(js.biome.test_rules).toEqual({ suspicious: { noConsole: "off" } });
  expect(js.biome.organize_imports).toBe("on");
  expect(js.prettier).toEqual({
    printWidth: 120,
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: false,
    trailingComma: "all",
    endOfLine: "lf",
  });
  expect(go.golangci.linters.enable).toEqual([
    "govet",
    "staticcheck",
    "unused",
    "errcheck",
    "errorlint",
    "gosec",
    "bodyclose",
    "contextcheck",
    "exhaustive",
    "revive",
    "gocritic",
    "cyclop",
  ]);
  expect(go.golangci.linters.default).toBe("none");
  expect(go.golangci.linters.exclusions.presets).toEqual([]);
  expect(go.golangci.formatters.enable).toEqual(["gofumpt", "goimports"]);
  expect(go.golangci.linters.settings.exhaustive.check).toEqual(["switch", "mapliteral"]);
  expect(go.golangci.severity).toEqual({ default: "error" });
});

test("JavaScript exclusions default empty, replace arrays and affect policy freshness", () => {
  const defaults = resolveLintConfig();
  expect(defaults.policy.javascript.exclude).toEqual([]);
  const excluded = resolveLintConfig({ javascript: { exclude: [".private/**"] } });
  expect(excluded.policy.javascript.exclude).toEqual([".private/**"]);
  expect(resolveLintConfig(excluded.policy).missing).toBe(false);
  expect(lintPolicyKey(excluded.policy)).not.toBe(lintPolicyKey(defaults.policy));
  expect(resolveLintConfig({ javascript: { exclude: [] } }).policy.javascript.exclude).toEqual([]);
  for (const exclude of [null, "**/*", [1]]) {
    expect(() => resolveLintConfig({ javascript: { exclude } })).toThrow("lint.javascript.exclude");
  }
});
