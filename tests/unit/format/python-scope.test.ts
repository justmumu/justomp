import { expect, test } from "bun:test";
import { PYTHON_DEFAULTS } from "../../../src/config/lint/python/defaults";
import { filterPythonFormatScope } from "../../../src/format/python-scope";
import { selectFormatFiles } from "../../../src/format/selection";

function filtered(
  files: string[],
  ruff: Record<string, unknown> = {},
  cwd = "/repo/app",
) {
  return filterPythonFormatScope({ ecosystem: "python", files }, cwd, {
    ruff: { ...structuredClone(PYTHON_DEFAULTS.ruff), ...ruff },
  }).files;
}

test("shared Ruff defaults and ancestor exclusions omit Python while preserving common files", () => {
  expect(
    filtered([
      ".private/draft.py",
      "nested/.private/draft.py",
      "nested/.nox/task.py",
      ".private/README.md",
      "src/main.py",
      "types.pyi",
    ]),
  ).toEqual([".private/README.md", "src/main.py", "types.pyi"]);
  expect(
    filtered([".nox/task.py", ".private/draft.py"], { exclude: [] }),
  ).toEqual([".nox/task.py"]);
  expect(filtered([".private/draft.py"], { "extend-exclude": [] })).toEqual([
    ".private/draft.py",
  ]);
});

test("Ruff slash patterns are rooted at the execution cwd and bare patterns match every basename", () => {
  const files = [
    "src/main.py",
    "nested/src/main.py",
    "nested/drop.py",
    "drop.py",
  ];
  expect(filtered(files, { exclude: ["src/main.py", "drop.py"] })).toEqual([
    "nested/src/main.py",
  ]);
  expect(filtered(files, { exclude: ["/repo/app/src/main.py"] })).toEqual(
    files.slice(1),
  );
  expect(
    filtered(["src/main.py"], { exclude: ["src/main.py"] }, "/repo/app[1]"),
  ).toEqual([]);
  expect(filtered(["main.py"], { exclude: ["app"] })).toEqual([]);
});

test("format-specific exclusions match the file, never an ancestor or a lint-only exclusion", () => {
  const files = [
    "generated/main.py",
    "types.pyi",
    "src/stub.pyi",
    "lint-only.py",
  ];
  expect(
    filtered(files, {
      format: {
        ...PYTHON_DEFAULTS.ruff.format,
        exclude: ["generated", "*.pyi"],
      },
      lint: { ...PYTHON_DEFAULTS.ruff.lint, exclude: ["lint-only.py"] },
    }),
  ).toEqual(["generated/main.py", "lint-only.py"]);
  expect(
    filtered(files, {
      format: { ...PYTHON_DEFAULTS.ruff.format, exclude: ["generated/**"] },
    }),
  ).toEqual(files.slice(1));
});

test("Ruff globset syntax crosses separators, preserves literal negation and handles byte wildcards", () => {
  for (const [pattern, files, retained] of [
    ["src/*.py", ["src/nested/main.py", "other/main.py"], ["other/main.py"]],
    ["src?main.py", ["src/main.py", "src/main.pyi"], ["src/main.pyi"]],
    ["**/draft.py", ["draft.py", "deep/draft.py", "main.py"], ["main.py"]],
    [
      "src/**/draft.py",
      ["src/draft.py", "src/deep/draft.py", "draft.py"],
      ["draft.py"],
    ],
    ["{draft,old}.py", ["draft.py", "old.py", "main.py"], ["main.py"]],
    ["[a-c].py", ["a.py", "c.py", "z.py"], ["z.py"]],
    ["[!a].py", ["a.py", "c.py"], ["a.py"]],
    ["!draft.py", ["!draft.py", "draft.py"], ["draft.py"]],
    ["a[[]1].py", ["a[1].py", "a1.py"], ["a1.py"]],
    ["a\\*.py", ["a*.py", "abc.py"], ["abc.py"]],
    ["?.py", ["a.py", "é.py"], ["é.py"]],
    ["??.py", ["a.py", "é.py"], ["a.py"]],
  ] as const)
    expect(filtered([...files], { exclude: [pattern] })).toEqual([...retained]);
});

test("explicit-file eligibility ignores Ruff discovery include settings", () => {
  expect(filtered(["main.py"], { include: [], "extend-include": [] })).toEqual([
    "main.py",
  ]);
});

test("invalid or unsupported native exclusion policy fails before selecting Python", () => {
  for (const exclude of [
    null,
    "draft.py",
    [1],
    ["[abc"],
    ["{a,b"],
    ["{a,{b,c}}"],
    ["a**b"],
    ["{,a}"],
    ["[z-a]"],
  ])
    expect(() => filtered(["main.py"], { exclude })).toThrow(
      "Cannot select Python format files",
    );
  expect(() => filtered(["main.py"], { extend: "base.toml" })).toThrow(
    "Ruff extend is unsupported",
  );
  expect(() =>
    filtered(["main.py"], {
      format: { ...PYTHON_DEFAULTS.ruff.format, exclude: null },
    }),
  ).toThrow("format.exclude must be an array");
});

test("external Ruff extend does not block explicit common-only or non-Python formatting", () => {
  const policy = { ruff: { ...PYTHON_DEFAULTS.ruff, extend: "base.toml" } };
  const scope = {
    ecosystem: "python" as const,
    files: ["main.py", "README.md", "pyproject.toml"],
  };
  const common = filterPythonFormatScope(scope, "/repo/app", policy, [
    "README.md",
    "pyproject.toml",
  ]);
  expect(selectFormatFiles(common, ["README.md", "pyproject.toml"])).toEqual([
    "README.md",
    "pyproject.toml",
  ]);
  expect(() => filterPythonFormatScope(scope, "/repo/app", policy)).toThrow(
    "Ruff extend is unsupported",
  );
  expect(
    filterPythonFormatScope(
      { ...scope, ecosystem: "javascript" },
      "/repo/app",
      policy,
    ).files,
  ).toEqual(scope.files);
});

test("explicit Ruff-excluded members invalidate a mixed selection as a whole", () => {
  const scope = filterPythonFormatScope(
    { ecosystem: "python", files: ["README.md", ".private/draft.py"] },
    "/repo/app",
    PYTHON_DEFAULTS,
  );
  expect(() =>
    selectFormatFiles(scope, ["README.md", ".private/draft.py"]),
  ).toThrow("not an owned supported file");
});
