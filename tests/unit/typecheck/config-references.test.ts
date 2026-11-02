import { afterEach, expect, spyOn, test } from "bun:test";
import { type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import * as config from "../../../src/config/load";
import { resolveTypecheckConfig } from "../../../src/config/typecheck/resolve";
import { type AdapterContext } from "../../../src/dependencies/model";
import * as graph from "../../../src/typecheck/javascript/config-graph";
import { resolveJavascriptTypes } from "../../../src/typecheck/javascript/prepare-types";
import { JavascriptConfigRead } from "../../../src/typecheck/javascript/read-session";
import * as scopes from "../../../src/typecheck/scope";
import { TypecheckStateStore } from "../../../src/typecheck/state";
import * as targets from "../../../src/typecheck/targets";
import { suppliedResponse } from "../../response";
import { output, scope, target } from "../checks/fixture";

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
  const files = new Map<string, string>();
  const stats = (path: unknown) =>
    ({
      isDirectory: () => !String(path).endsWith(".json"),
      isFile: () => String(path).endsWith(".json"),
    }) as Stats;
  keep(
    spyOn(fs, "readFile").mockImplementation(((path: unknown, encoding?: unknown) => {
      return suppliedResponse(() => {
        const text = files.get(String(path));
        if (text === undefined) {
          throw Object.assign(new Error("Missing supplied document"), {
            code: "ENOENT",
          });
        }
        return encoding === "utf8" ? text : Buffer.from(text);
      });
    }) as typeof fs.readFile),
  );
  keep(spyOn(fs, "stat").mockImplementation((async (path: unknown) => stats(path)) as typeof fs.stat));
  keep(spyOn(fs, "lstat").mockImplementation((async (path: unknown) => stats(path)) as typeof fs.lstat));
  keep(spyOn(fs, "realpath").mockImplementation((async (path: unknown) => String(path)) as typeof fs.realpath));
  keep(spyOn(scopes, "collectTypecheckScope").mockResolvedValue(scope("index.ts")));
  keep(
    spyOn(TypecheckStateStore, "load").mockResolvedValue({
      state: { schema: 1, projects: {}, waves: {} },
    } as TypecheckStateStore),
  );
  const read = new JavascriptConfigRead(new AbortController().signal);
  const show = keep(
    spyOn(JavascriptConfigRead.prototype, "showConfig").mockResolvedValue(
      output({
        stdout: JSON.stringify({ compilerOptions: {}, files: ["index.ts"] }),
      }),
    ),
  );
  const write = (path: string, value: unknown) => files.set(path, JSON.stringify(value));
  return {
    selected,
    files,
    read,
    show,
    write,
    signal: new AbortController().signal,
  };
}
test("reference graph rejects cycles using supplied configs and effective compiler metadata", async () => {
  const f = fixture(),
    cwd = f.selected.scope.cwd;
  f.write(join(cwd, "tsconfig.json"), { references: [{ path: "../lib" }] });
  f.write("/repo/apps/lib/tsconfig.json", { references: [{ path: "../app" }] });
  await expect(graph.readJavascriptConfigGraph(f.selected, f.signal, "tsconfig.json", f.read)).rejects.toThrow(
    "Cyclic TypeScript references",
  );
});
test("reference graph rejects paths outside the inspection root before reading them", async () => {
  const f = fixture();
  f.write(join(f.selected.scope.cwd, "tsconfig.json"), {
    references: [{ path: "../../.." }],
  });
  await expect(graph.readJavascriptConfigGraph(f.selected, f.signal, "tsconfig.json", f.read)).rejects.toThrow(
    "inside the inspection root",
  );
});
test("declaration planning accepts matching package output and rejects a stale mapping without compiling", async () => {
  const f = fixture(),
    selected = f.selected;
  const dependency = structuredClone(selected);
  dependency.project = {
    ...selected.project,
    project_id: "javascript:apps/lib",
    path: "apps/lib",
    manifest: "apps/lib/package.json",
    name: "lib",
  };
  dependency.scope.cwd = "/repo/apps/lib";
  selected.project.manifest = "apps/app/package.json";
  selected.structure.projects.push(dependency.project);
  selected.structure.localDependencies = [
    {
      from: selected.project.project_id,
      to: dependency.project.project_id,
      kind: "path",
      evidence: { file: selected.project.manifest, field: "dependencies.lib" },
    },
  ];
  f.write(join(selected.root, selected.project.manifest), {});
  f.write(join(selected.root, dependency.project.manifest), {
    types: "types/index.d.ts",
  });
  const policy = resolveTypecheckConfig().policy;
  policy.javascript.exclude = ["src/.private/**"];
  keep(
    spyOn(config, "loadConfig").mockResolvedValue({
      typecheck: policy,
    } as Awaited<ReturnType<typeof config.loadConfig>>),
  );
  keep(spyOn(targets, "resolveTypecheckTarget").mockResolvedValue(dependency));
  keep(spyOn(JavascriptConfigRead.prototype, "native").mockResolvedValue({} as AdapterContext));
  keep(
    spyOn(graph, "readJavascriptConfigGraph").mockImplementation((member) => {
      return suppliedResponse(() => {
        const path = join(member.scope.cwd, "tsconfig.json");
        return {
          nodes:
            member === selected
              ? []
              : [
                  {
                    path,
                    project_id: member.project.project_id,
                    raw: {},
                    compilerOptions: { composite: true },
                    files: [join(member.scope.cwd, "src/index.ts")],
                    references: [],
                    inherited: [],
                  },
                ],
          roots: member === selected ? [] : [path],
          scope: scope("src/index.ts"),
        };
      });
    }),
  );
  const metadata = (declarationDir: string) =>
    output({
      stdout: JSON.stringify({
        compilerOptions: { composite: true, rootDir: "src", declarationDir },
        files: ["src/index.ts", "src/.private/archive.ts"],
      }),
    });
  keep(spyOn(scopes, "collectTypecheckScope").mockResolvedValue(scope("src/index.ts")));
  const program = keep(
    spyOn(JavascriptConfigRead.prototype, "programFiles").mockResolvedValue(["/repo/apps/lib/src/index.ts"]),
  );
  f.show.mockResolvedValue(metadata("types"));
  const plan = await resolveJavascriptTypes(selected, f.signal);
  expect(plan.declarations.map((step) => step.outputs)).toEqual([["/repo/apps/lib/types/index.d.ts"]]);
  expect(plan.declarations[0]?.node.files).toEqual(["/repo/apps/lib/src/index.ts"]);
  expect(program.mock.calls[0]?.[2]).toEqual(["/repo/apps/lib/src/index.ts"]);
  keep(
    spyOn(scopes, "collectTypecheckScope").mockResolvedValue({
      ...scope("src/index.ts"),
      files: ["src/index.ts", "src/.private/helper.ts", "src/.private/archive.ts"],
    }),
  );
  program.mockResolvedValue([
    "/repo/apps/lib/src/index.ts",
    "/repo/apps/lib/src/.private/helper.ts",
    "/repo/node_modules/dependency/index.ts",
  ]);
  const imported = await resolveJavascriptTypes(selected, f.signal);
  expect(imported.declarations[0]?.entries).toEqual(["/repo/apps/lib/src/index.ts"]);
  expect(imported.declarations[0]?.outputs).toEqual([
    "/repo/apps/lib/types/index.d.ts",
    "/repo/apps/lib/types/.private/helper.d.ts",
  ]);
  policy.javascript.exclude = [];
  const restored = await resolveJavascriptTypes(selected, f.signal);
  expect(restored.declarations[0]?.node.files).toContain("/repo/apps/lib/src/.private/archive.ts");
  expect(restored.declarations[0]?.outputs).toContain("/repo/apps/lib/types/.private/archive.d.ts");
  f.show.mockResolvedValue(metadata("elsewhere"));
  await expect(resolveJavascriptTypes(selected, f.signal)).rejects.toThrow("does not match package types/exports");
});
