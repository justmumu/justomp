import { afterEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { resolveFormatConfig } from "../../../src/config/format/resolve";
import * as configLoader from "../../../src/config/load";
import { resolveTypecheckConfig } from "../../../src/config/typecheck/resolve";
import { object } from "../../../src/dependencies/inventory";
import { checkPrettier, formatPrettier } from "../../../src/format/engines/prettier";
import * as files from "../../../src/lint/files";
import { editNativeConfig } from "../../../src/native-config/edit";
import { javascriptAdapter } from "../../../src/typecheck/adapters/javascript";
import { planBuildConsumers } from "../../../src/typecheck/javascript/build-consumers";
import * as graph from "../../../src/typecheck/javascript/config-graph";
import * as native from "../../../src/typecheck/javascript/native";
import { staticNextTypescriptPath } from "../../../src/typecheck/javascript/next-entry";
import { planJavascriptProjection } from "../../../src/typecheck/projections/javascript";
import * as scopes from "../../../src/typecheck/scope";
import { TypecheckStateStore } from "../../../src/typecheck/state";
import { scope, target } from "../checks/fixture";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) {
    restore();
  }
});
function keep<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}
function fixture() {
  const selected = target("javascript");
  selected.project.manifest = "apps/app/package.json";
  const format = resolveFormatConfig().policy;
  keep(spyOn(configLoader, "loadConfig").mockResolvedValue({ format } as configLoader.LoadedConfig));
  const documents = new Map<string, string>();
  keep(
    spyOn(files, "readProjectionFile").mockImplementation(async (_root, path) => ({
      text: documents.get(path) ?? null,
      identity: null,
      mode: 0o644,
    })),
  );
  keep(
    spyOn(TypecheckStateStore, "load").mockResolvedValue({
      state: { schema: 1, projects: {}, waves: {} },
    } as TypecheckStateStore),
  );
  const node = (name: string, included: string[], references: string[] = []): graph.JavascriptConfigNode => ({
    path: join(selected.scope.cwd, name),
    project_id: selected.project.project_id,
    raw: { compilerOptions: { paths: { "@app/*": ["./src/*"] }, noEmit: true } },
    compilerOptions: { paths: { "@app/*": ["./src/*"] }, noEmit: true },
    files: included.map((f) => join(selected.scope.cwd, f)),
    references: references.map((f) => join(selected.scope.cwd, f)),
    inherited: [],
  });
  const app = node("tsconfig.app.json", ["src/value.ts"]),
    tests = node("tsconfig.test.json", []);
  const supplied: graph.JavascriptConfigGraph = {
    nodes: [app, tests],
    roots: [app.path, tests.path],
    scope: {
      ...scope("src/value.ts"),
      files: ["src/value.ts", "tests/value.ts"],
    },
  };
  documents.set(app.path, JSON.stringify(app.raw));
  documents.set(tests.path, JSON.stringify(tests.raw));
  const read = keep(spyOn(graph, "readJavascriptConfigGraph").mockResolvedValue(supplied));
  const plan = () => planJavascriptProjection(selected, resolveTypecheckConfig().policy, new AbortController().signal);
  return { selected, documents, node, app, tests, supplied, read, plan, format };
}
function config(content: string) {
  return object(Bun.JSONC.parse(content));
}
test("native app/test contexts preserve aliases and receive the complete shared checking policy", async () => {
  const f = fixture();
  const plan = await f.plan();
  expect(plan.configs.check).toEqual([f.app.path, f.tests.path]);
  expect(plan.files.map((file) => config(file.content))).toEqual([
    expect.objectContaining({
      files: ["./src/value.ts"],
      include: [],
      exclude: [],
      compilerOptions: expect.objectContaining({ strict: true, checkJs: true, paths: { "@app/*": ["./src/*"] } }),
    }),
    expect.objectContaining({ files: ["./tests/value.ts"], include: [], exclude: [] }),
  ]);
  for (const file of plan.files) {
    f.documents.set(file.path, file.content.replaceAll("\n", "\r\n"));
  }
  expect((await f.plan()).current).toBe(true);
  f.supplied.scope.files.push("tests/new.ts");
  expect((await f.plan()).current).toBe(false);
});
test("jsconfig preserves its inherited import context without adding its base as an independent check", async () => {
  const f = fixture();
  const base = f.node("tsconfig.base.json", ["index.js"]),
    app = f.node("jsconfig.json", ["index.js"]);
  app.raw.extends = "./tsconfig.base.json";
  f.documents.set(app.path, JSON.stringify(app.raw));
  app.inherited = [
    {
      path: base.path,
      text: '{"compilerOptions":{"paths":{"@app/*":["./src/*"]}}}',
    },
  ];
  f.read.mockResolvedValue({
    nodes: [app, base],
    roots: [app.path],
    scope: scope("index.js"),
  });
  const plan = await f.plan();
  expect(plan.files).toHaveLength(1);
  expect(config(plan.files[0]?.content ?? "{}")).toMatchObject({
    extends: "./tsconfig.base.json",
    files: ["./index.js"],
    compilerOptions: { checkJs: true, noEmit: true },
  });
});
test("uncovered tests keep the production context while inherited child project inputs remain excluded", async () => {
  const f = fixture();
  f.app.files.push(join(f.selected.scope.cwd, "child/index.ts"));
  f.read.mockResolvedValue({
    ...f.supplied,
    nodes: [f.app],
    roots: [f.app.path],
  });
  const plan = await f.plan();
  expect(plan.files).toHaveLength(1);
  expect(config(plan.files[0]?.content ?? "{}")).toMatchObject({
    files: ["./src/value.ts", "./tests/value.ts"],
    compilerOptions: { checkJs: true },
  });
});

test("typecheck projection forwards its independent source exclusions to graph selection", async () => {
  const f = fixture();
  const policy = resolveTypecheckConfig().policy;
  policy.javascript.exclude = [".private/**"];
  const signal = new AbortController().signal;
  await planJavascriptProjection(f.selected, policy, signal);
  expect(f.read).toHaveBeenCalledWith(f.selected, signal, undefined, undefined, [".private/**"]);
  f.supplied.scope.files = ["src/value.ts"];
  const filtered = await planJavascriptProjection(f.selected, policy, signal);
  expect(filtered.files.map((file) => config(file.content).files)).toEqual([["./src/value.ts"]]);
  for (const file of filtered.files) {
    f.documents.set(file.path, file.content);
  }
  f.supplied.scope.files.push("tests/value.ts");
  policy.javascript.exclude = [];
  expect((await planJavascriptProjection(f.selected, policy, signal)).current).toBe(false);
});

test("source-root production builds keep their output graph while the native check entry includes tests", async () => {
  const f = fixture();
  const app = f.node("tsconfig.json", ["src/value.ts"]);
  app.raw = {
    compilerOptions: { module: "NodeNext", rootDir: "src", outDir: "dist", declaration: true },
    include: ["src"],
    exclude: ["tests"],
  };
  app.compilerOptions = object(app.raw.compilerOptions);
  f.documents.set(app.path, JSON.stringify(app.raw));
  f.documents.set(
    join(f.selected.scope.cwd, "package.json"),
    JSON.stringify({ scripts: { build: "tsc -p tsconfig.json" } }),
  );
  f.read.mockResolvedValue({ ...f.supplied, nodes: [app], roots: [app.path] });
  const plan = await f.plan();
  expect(plan.configs.check).toEqual([app.path]);
  expect(plan.files.some((file) => file.path.includes(".justomp."))).toBe(false);
  const build = plan.files.find((file) => file.path === join(f.selected.scope.cwd, "tsconfig.build.json"));
  expect(build).toBeDefined();
  expect(config(build?.content ?? "{}")).toMatchObject({
    compilerOptions: { module: "NodeNext", rootDir: "src", outDir: "dist", declaration: true },
    include: ["src"],
    exclude: ["tests"],
  });
  const check = plan.files.find((file) => file.path === app.path);
  expect(config(check?.content ?? "{}")).toMatchObject({
    extends: "./tsconfig.build.json",
    files: ["./src/value.ts", "./tests/value.ts"],
    compilerOptions: { strict: true, checkJs: true },
  });
  const manifest = plan.files.find((file) => file.path === join(f.selected.scope.cwd, "package.json"));
  expect(config(manifest?.content ?? "{}")).toMatchObject({ scripts: { build: "tsc -p tsconfig.build.json" } });
});

test("native build consumers rewrite explicit and multi-project compiler entries and preserve check commands", async () => {
  const f = fixture();
  const app = { path: f.app.path, node: f.app, build: f.app.path.replace(".json", ".build.json") };
  const tests = { path: f.tests.path, node: f.tests, build: f.tests.path.replace(".json", ".build.json") };
  const manifestPath = join(f.selected.scope.cwd, "package.json");
  f.documents.set(
    manifestPath,
    JSON.stringify({
      scripts: {
        build: "tsc -b tsconfig.app.json tsconfig.test.json",
        bundle: "tsc --project=tsconfig.app.json",
        validate: "tsc --noEmit -p tsconfig.app.json",
      },
    }),
  );
  const result = await planBuildConsumers(f.selected, [app, tests], new AbortController().signal);
  expect(result[0]?.desired).toEqual({
    scripts: {
      build: "tsc -b tsconfig.app.build.json tsconfig.test.build.json",
      bundle: "tsc --project=tsconfig.app.build.json",
    },
  });
  f.documents.set(manifestPath, JSON.stringify({ scripts: { build: "tsc -p tsconfig.app.json && generate" } }));
  await expect(planBuildConsumers(f.selected, [app], new AbortController().signal)).rejects.toMatchObject({
    code: "projection-conflict",
  });
  f.documents.set(manifestPath, JSON.stringify({ scripts: { "build:types": "custom-generator" } }));
  await expect(
    planBuildConsumers(
      f.selected,
      [{ ...app, types: join(f.selected.scope.cwd, "tsconfig.types.json") }],
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "projection-conflict" });
});
test("Next selects a literal native TypeScript entry without executing unrelated callbacks", () => {
  expect(
    staticNextTypescriptPath(
      'export default {webpack() {throw new Error("not executed")},typescript:{tsconfigPath:"config/typescript.json"}};',
      "next.config.mjs",
    ),
  ).toBe("config/typescript.json");
  expect(staticNextTypescriptPath("module.exports = {webpack() { return {} }};", "next.config.cjs")).toBe(
    "tsconfig.json",
  );
  expect(() =>
    staticNextTypescriptPath("export default {typescript:{tsconfigPath: choose()}};", "next.config.mjs"),
  ).toThrow("Cannot statically select");
  expect(() =>
    staticNextTypescriptPath('export default () => ({typescript:{tsconfigPath:"dynamic.json"}});', "next.config.mjs"),
  ).toThrow("Cannot statically select");
});

test("native config fingerprints cover unmanaged aliases and inherited package settings", async () => {
  const f = fixture();
  const first = await f.plan();
  f.app.inherited.push({
    path: "/repo/node_modules/base/tsconfig.json",
    text: '{"compilerOptions":{"module":"NodeNext"}}',
  });
  expect((await f.plan()).input_fingerprint).not.toBe(first.input_fingerprint);
  const inherited = await f.plan();
  f.app.compilerOptions.paths = { "@app/*": ["./alternate/*"] };
  expect((await f.plan()).input_fingerprint).not.toBe(inherited.input_fingerprint);
});
test("the native checker cannot certify diagnostics after inherited config drift", async () => {
  const f = fixture();
  const projection = {
    target: f.selected,
    files: [],
    configs: { check: [f.app.path] },
    current: true,
    input_fingerprint: "before",
  };
  keep(spyOn(scopes, "collectTypecheckScope").mockResolvedValue(scope("src/value.ts")));
  keep(
    spyOn(javascriptAdapter, "plan")
      .mockResolvedValueOnce(projection)
      .mockResolvedValue({ ...projection, input_fingerprint: "changed" }),
  );
  keep(
    spyOn(native, "typescriptRun").mockResolvedValue({
      exit_code: 0,
      signal: null,
      stdout: "",
      stderr: "",
      truncated: false,
      cancelled: false,
    }),
  );
  const result = await javascriptAdapter.check({
    target: f.selected,
    policy: resolveTypecheckConfig().policy,
    versions: { typescript: "7.0.2" },
    signal: new AbortController().signal,
    projection,
  });
  expect(result[0]?.status).toBe("not-run");
  expect(result[0]?.reason).toContain("inherited inputs changed");
});

test("native build script publication rejects config filenames with shell metacharacters", async () => {
  const f = fixture();
  f.documents.set(join(f.selected.scope.cwd, "package.json"), "{}");
  const entry = { path: f.app.path, node: f.app, build: join(f.selected.scope.cwd, "tsconfig.$(touch-external).json") };
  await expect(planBuildConsumers(f.selected, [entry], new AbortController().signal)).rejects.toMatchObject({
    code: "projection-conflict",
  });
  expect(f.documents.get(join(f.selected.scope.cwd, "package.json"))).toBe("{}");
});

test("repeated build-consumer reconciliation retains the adopted production script", async () => {
  const f = fixture();
  const path = join(f.selected.scope.cwd, "package.json");
  const entry = {
    path: f.app.path,
    node: f.app,
    build: f.app.path.replace(".json", ".build.json"),
    types: f.app.path.replace(".json", ".types.json"),
  };
  f.documents.set(
    path,
    JSON.stringify({ scripts: { build: "tsc -p tsconfig.app.json", start: "node dist/value.js" } }),
  );
  const first = await planBuildConsumers(f.selected, [entry], new AbortController().signal);
  const adopted = editNativeConfig(f.documents.get(path) ?? null, path, first[0]?.desired ?? {});
  f.documents.set(path, adopted.content);
  const owned = adopted.fields.flatMap((field) => (field[0] === "scripts" && field[1] ? [field[1]] : []));
  const second = await planBuildConsumers(f.selected, [entry], new AbortController().signal, undefined, owned);
  const repeated = editNativeConfig(adopted.content, path, second[0]?.desired ?? {}, adopted.fields);
  expect(config(repeated.content)).toEqual(config(adopted.content));
  expect(config(repeated.content)).toMatchObject({
    scripts: {
      build: "tsc -p tsconfig.app.build.json",
      "build:types": "tsc --project tsconfig.app.types.json",
      start: "node dist/value.js",
    },
  });
});

test("a source-free solution keeps separate check and production reference graphs", async () => {
  const f = fixture();
  const app = f.node("tsconfig.app.json", ["src/value.ts"]);
  app.raw = { compilerOptions: { composite: true, rootDir: "src", outDir: "dist" }, include: ["src"] };
  app.compilerOptions = object(app.raw.compilerOptions);
  const solution = f.node("tsconfig.json", [], ["tsconfig.app.json"]);
  solution.raw = { files: [], references: [{ path: "./tsconfig.app.json" }] };
  solution.compilerOptions = {};
  f.documents.set(app.path, JSON.stringify(app.raw));
  f.documents.set(solution.path, JSON.stringify(solution.raw));
  f.documents.set(join(f.selected.scope.cwd, "package.json"), '{"scripts":{"build":"tsc -b"}}');
  f.read.mockResolvedValue({ ...f.supplied, nodes: [solution, app], roots: [solution.path] });
  const plan = await f.plan();
  const output = (name: string) =>
    config(plan.files.find((file) => file.path === join(f.selected.scope.cwd, name))?.content ?? "{}");
  expect(plan.configs.check).toEqual([app.path]);
  expect(output("tsconfig.json")).toMatchObject({
    files: [],
    references: [{ path: "./tsconfig.app.json" }],
    extends: "./tsconfig.build.json",
  });
  expect(output("tsconfig.build.json")).toMatchObject({
    files: [],
    references: [{ path: "./tsconfig.app.build.json" }],
  });
  expect(output("tsconfig.app.build.json")).toMatchObject({
    compilerOptions: { rootDir: "src", outDir: "dist", composite: true },
    include: ["src"],
  });
  expect(output("tsconfig.app.json")).toMatchObject({ files: ["./src/value.ts", "./tests/value.ts"] });
  expect(output("package.json")).toMatchObject({ scripts: { build: "tsc -b tsconfig.build.json" } });
});

test("semantic config refresh after generated types uses managed formatting and preserves no-op bytes", async () => {
  const f = fixture();
  f.format.prettier.useTabs = true;
  f.format.prettier.printWidth = 60;
  const app = f.node("tsconfig.json", ["src/value.ts"]);
  f.documents.set(app.path, JSON.stringify(app.raw));
  const supplied = { ...f.supplied, nodes: [app], roots: [app.path], generatedFiles: [] as string[] };
  f.read.mockResolvedValue(supplied);
  const first = await f.plan();
  const published = first.files.find((file) => file.path === app.path)?.content ?? "";
  expect(await checkPrettier(published, "jsonc", f.format.prettier)).toBe(true);
  f.documents.set(app.path, published);
  supplied.generatedFiles.push(join(f.selected.scope.cwd, ".next/types/routes.d.ts"));
  const refreshed = await f.plan();
  const changed = refreshed.files.find((file) => file.path === app.path)?.content ?? "";
  expect(config(changed).files).toContain(".next/types/routes.d.ts");
  expect(await checkPrettier(changed, "jsonc", f.format.prettier)).toBe(true);
  const alternate = await formatPrettier(changed, "jsonc", { ...f.format.prettier, endOfLine: "crlf" });
  f.documents.set(app.path, alternate);
  const unchanged = await f.plan();
  expect(unchanged.current).toBe(true);
  expect(unchanged.files.find((file) => file.path === app.path)?.content).toBe(alternate);
});
