import { afterEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { resolveTypecheckConfig } from "../../../src/config/typecheck/resolve";
import { object } from "../../../src/dependencies/inventory";
import * as files from "../../../src/lint/files";
import * as graph from "../../../src/typecheck/javascript/config-graph";
import { planJavascriptProjection } from "../../../src/typecheck/projections/javascript";
import { TypecheckStateStore } from "../../../src/typecheck/state";
import { scope, target } from "../checks/fixture";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});
function keep<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}
function fixture() {
  const selected = target("javascript");
  const documents = new Map<string, string>();
  keep(
    spyOn(files, "readProjectionFile").mockImplementation(
      async (_root, path) => ({
        text: documents.get(path) ?? null,
        identity: null,
        mode: 0o644,
      }),
    ),
  );
  keep(
    spyOn(TypecheckStateStore, "load").mockResolvedValue({
      state: { schema: 1, projects: {}, waves: {} },
    } as TypecheckStateStore),
  );
  const node = (
    name: string,
    included: string[],
    references: string[] = [],
  ): graph.JavascriptConfigNode => ({
    path: join(selected.scope.cwd, name),
    project_id: selected.project.project_id,
    raw: {},
    compilerOptions: { paths: { "@app/*": ["./src/*"] }, rootDir: "src" },
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
  const read = keep(
    spyOn(graph, "readJavascriptConfigGraph").mockResolvedValue(supplied),
  );
  const plan = () =>
    planJavascriptProjection(
      selected,
      resolveTypecheckConfig().policy,
      new AbortController().signal,
    );
  return { selected, documents, node, app, tests, supplied, read, plan };
}
function config(content: string) {
  return object(Bun.JSONC.parse(content));
}
test("managed contexts retain native aliases through extends and add excluded tests without emit root restrictions", async () => {
  const f = fixture();
  const plan = await f.plan();
  expect(plan.files.map((file) => config(file.content))).toEqual([
    expect.objectContaining({
      extends: f.app.path,
      files: ["./src/value.ts"],
      include: [],
      exclude: [],
      compilerOptions: expect.objectContaining({
        strict: true,
        checkJs: true,
        noEmit: true,
        rootDir: "/repo",
        incremental: false,
        composite: false,
      }),
    }),
    expect.objectContaining({
      extends: f.tests.path,
      files: ["./tests/value.ts"],
      include: [],
      exclude: [],
    }),
  ]);
  expect(
    plan.files.every(
      (file) =>
        !Object.hasOwn(object(config(file.content).compilerOptions), "paths"),
    ),
  ).toBe(true);
  for (const file of plan.files)
    f.documents.set(
      file.path,
      file.content.replaceAll("\n", "\r\n").replaceAll("  ", "\t"),
    );
  expect((await f.plan()).current).toBe(true);
  f.supplied.scope.files.push("tests/new.ts");
  expect((await f.plan()).current).toBe(false);
  f.documents.set(plan.files[0]?.path ?? "", "{}");
  await expect(f.plan()).rejects.toMatchObject({ code: "projection-conflict" });
});
test("jsconfig extends its native import context without adding its base as an independent check", async () => {
  const f = fixture();
  const base = f.node("tsconfig.base.json", ["index.js"]),
    app = f.node("jsconfig.json", ["index.js"]);
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
    extends: app.path,
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
    extends: f.app.path,
    files: ["./src/value.ts", "./tests/value.ts"],
    compilerOptions: { rootDir: "/repo" },
  });
});
