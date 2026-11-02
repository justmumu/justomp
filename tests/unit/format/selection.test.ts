import { expect, test } from "bun:test";
import { FORMAT_DEFAULTS } from "../../../src/config/format/defaults";
import { createFormatScope, formatterFor, selectFormatFiles } from "../../../src/format/selection";

const files = [
  "src/main.py",
  "src/types.pyi",
  "README.md",
  "pyproject.toml",
  ".github/workflows/check.yml",
  "child/main.py",
  "../web/index.ts",
  "package-lock.json",
  "pnpm-lock.yaml",
  "uv.lock",
  "src/api.generated.ts",
  "next-env.d.ts",
  ".justomp/state.json",
  ".git/config.json",
  "eslint.justomp.config.mjs",
  "node_modules/pkg/index.ts",
  "nested/vendor/main.go",
  "dist/index.js",
  ".deps/foreign.py",
  "notebook.ipynb",
  "main.go",
  "src/a[1].ts",
];
const metadata = {
  ecosystem: "python" as const,
  files,
  childRoots: ["child"],
  dependencyRoots: [".deps"],
};

test("full format scope owns common files and native Python without children, dependencies or generated state", () => {
  expect(createFormatScope(metadata, FORMAT_DEFAULTS).files).toEqual([
    ".github/workflows/check.yml",
    "README.md",
    "eslint.justomp.config.mjs",
    "pyproject.toml",
    "src/a[1].ts",
    "src/main.py",
    "src/types.pyi",
  ]);
});

test("include and exclude use replacement policy and cannot disable ownership or internal state boundaries", () => {
  expect(
    createFormatScope(metadata, {
      ...FORMAT_DEFAULTS,
      include: ["**/*.ts", "child/**", ".justomp/**"],
      exclude: [],
    }).files,
  ).toEqual(["next-env.d.ts", "src/a[1].ts", "src/api.generated.ts"]);
  expect(
    createFormatScope(metadata, {
      ...FORMAT_DEFAULTS,
      include: ["**/*"],
      exclude: ["src"],
    }).files,
  ).toContain("dist/index.js");
  expect(
    createFormatScope(metadata, {
      ...FORMAT_DEFAULTS,
      include: ["**/*"],
      exclude: ["src"],
    }).files,
  ).not.toContain("src/main.py");
});

test("exact selections validate every file, reject empty/missing/directory/glob/traversal/unsupported input and deduplicate", () => {
  const scope = createFormatScope(metadata, FORMAT_DEFAULTS);
  expect(selectFormatFiles(scope)).toEqual(scope.files);
  expect(selectFormatFiles(scope, ["src/main.py", "README.md", "src/main.py"])).toEqual(["README.md", "src/main.py"]);
  expect(selectFormatFiles(scope, ["src/a[1].ts"])).toEqual(["src/a[1].ts"]);
  for (const invalid of [
    "",
    "missing.py",
    "src",
    "src/*.py",
    "../web/index.ts",
    "/src/main.py",
    "./src/main.py",
    "notebook.ipynb",
    "child/main.py",
    "package-lock.json",
    "src/api.generated.ts",
    ".deps/foreign.py",
  ]) {
    expect(() => selectFormatFiles(scope, ["README.md", invalid])).toThrow("not an owned supported file");
  }
  expect(() => selectFormatFiles(scope, [])).toThrow("non-empty");
});

test("dispatch is fixed by extension and discovered ecosystem with explicit JSONC settings basenames", () => {
  expect(formatterFor("main.py", "python")).toEqual({ engine: "ruff" });
  expect(formatterFor("types.pyi", "python")).toEqual({ engine: "ruff" });
  expect(formatterFor("main.go", "go")).toEqual({ engine: "go" });
  expect(formatterFor("main.py", "javascript")).toBeUndefined();
  expect(formatterFor("main.go", "python")).toBeUndefined();
  expect(formatterFor("notebook.ipynb", "python")).toBeUndefined();
  for (const [file, parser] of [
    ["app.tsx", "typescript"],
    ["app.mjs", "babel"],
    ["package.json", "json"],
    ["tsconfig.build.json", "jsonc"],
    ["jsconfig.json", "jsonc"],
    ["pyrightconfig.json", "jsonc"],
    ["pyright.justomp.json", "jsonc"],
    [".vscode/settings.json", "jsonc"],
    ["deno.jsonc", "jsonc"],
    ["config.yml", "yaml"],
    ["README.md", "markdown"],
    ["doc.mdx", "mdx"],
    ["index.html", "html"],
    ["app.css", "css"],
    ["app.scss", "scss"],
    ["app.less", "less"],
    ["pyproject.toml", "toml"],
  ] as const) {
    expect(formatterFor(file, "python")).toEqual({
      engine: "prettier",
      parser,
    });
  }
});

test("Go selection omits names the native formatter skips or rewrites", () => {
  const scope = createFormatScope(
    {
      ecosystem: "go",
      files: ["main.go", ".hidden.go", "Main.GO", "x...go", "parent.../main.go", ".config/main.go"],
    },
    FORMAT_DEFAULTS,
  );
  expect(scope.files).toEqual([".config/main.go", "main.go"]);
  for (const path of [".hidden.go", "Main.GO", "x...go", "parent.../main.go"]) {
    expect(() => selectFormatFiles(scope, [path])).toThrow("not an owned supported file");
  }
});
