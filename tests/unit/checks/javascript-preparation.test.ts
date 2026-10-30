import { afterEach, expect, spyOn, test } from "bun:test";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import { resolveTypecheckConfig } from "../../../src/config/typecheck/resolve";
import type {
  Adapter,
  DependencyRequest,
  Inventory,
  NativeStep,
} from "../../../src/dependencies/model";
import { javascriptAdapter as lint } from "../../../src/lint/adapters/javascript";
import type { LintOperationContext } from "../../../src/lint/adapters/types";
import * as native from "../../../src/lint/javascript/native";
import * as runtime from "../../../src/lint/runtime";
import { javascriptAdapter as typecheck } from "../../../src/typecheck/adapters/javascript";
import { memoryContext } from "../dependencies/memory";
import { output, target } from "./fixture";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});
function keep<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}
function fixture(
  manager: "npm" | "pnpm" | "yarn-classic" | "yarn-modern" | "bun",
  feature: "lint" | "typecheck",
  installed = false,
) {
  const f = memoryContext();
  restores.push(f.close);
  f.context.manager = manager.startsWith("yarn") ? "yarn" : manager;
  f.context.version = manager === "yarn-classic" ? "1.22.22" : "4.12.0";
  const selected = target("javascript");
  Object.assign(selected, {
    root: f.root,
    project: f.context.project,
    structure: f.context.structure,
  });
  Object.assign(selected.scope, { cwd: f.context.cwd, owner: f.context.owner });
  const tools: Record<string, string> =
    feature === "lint"
      ? { eslint: "9.39.5", prettier: "3.6.2" }
      : { typescript: "7.0.2" };
  const requests: Exclude<DependencyRequest, { operation: "list" }>[] = [];
  const before: Inventory = {
    complete: true,
    diagnostics: [],
    dependencies: installed
      ? Object.keys(tools).map((name) => ({
          name,
          group: { kind: "dev" },
          source: { kind: "registry" },
          direct: true,
          declared_specifier: "1.0.0",
          evidence: { file: "package.json", field: `devDependencies.${name}` },
        }))
      : [],
  };
  const adapter: Adapter = {
    groups: ["runtime", "dev"],
    inventory: async () => before,
    plan: async (_ctx, request) => {
      requests.push(request);
      return {
        steps: [
          {
            args: ["fixture-mutation"],
            cwd: f.context.cwd,
            label: "Install tools",
          },
        ],
        metadata: ["package.json", "lock"],
        affectedProjects: [f.context.project.project_id],
      };
    },
  };
  const steps: NativeStep[] = [];
  let result = output();
  f.write(
    "package.json",
    JSON.stringify({ name: "app", dependencies: { existing: "1.0.0" } }),
  );
  f.context.run = async (step) => {
    steps.push(step);
    f.write(
      "package.json",
      JSON.stringify({
        name: "app",
        dependencies: { existing: "1.0.0" },
        devDependencies: tools,
      }),
    );
    f.write("lock", "native lock output");
    return result;
  };
  keep(spyOn(runtime, "lintManagerContext").mockResolvedValue(f.context));
  keep(spyOn(native, "nativeAdapter").mockReturnValue(adapter));
  const context: LintOperationContext = {
    targets: [selected],
    policy: resolveLintConfig().policy,
    versions: { [selected.project.project_id]: tools },
    signal: new AbortController().signal,
    changes: [],
  };
  const typed = { ...context, policy: resolveTypecheckConfig().policy };
  return {
    f,
    tools,
    requests,
    steps,
    context,
    typed,
    fail: () => {
      result = output({
        exit_code: 71,
        stderr: "failed https://user:password@example.invalid/",
      });
    },
    run: () =>
      feature === "lint"
        ? lint.prepareBatch(context)
        : typecheck.prepareBatch(typed),
  };
}
for (const feature of ["lint", "typecheck"] as const)
  for (const manager of [
    "npm",
    "pnpm",
    "yarn-classic",
    "yarn-modern",
    "bun",
  ] as const)
    for (const installed of [false, true])
      test(`${feature} ${manager} ${installed ? "updates" : "adds"} exact dev tools through its dependency adapter`, async () => {
        const f = fixture(manager, feature, installed);
        await f.run();
        const tools = Object.entries(f.tools);
        expect(f.requests).toHaveLength(1);
        expect(f.requests[0]).toEqual(
          installed
            ? {
                operation: "update",
                project_id: f.f.context.project.project_id,
                mode: "within_constraints",
                packages: tools.map(([name, version]) => ({
                  name,
                  version,
                  group: { kind: "dev" },
                })),
              }
            : {
                operation: "add",
                project_id: f.f.context.project.project_id,
                group: { kind: "dev" },
                packages: tools.map(([name, version]) => ({
                  name,
                  version,
                  source: { kind: "registry" },
                })),
              },
        );
        expect(f.steps.map((s) => s.args)).toEqual([
          installed
            ? ["fixture-mutation"]
            : [
                "fixture-mutation",
                manager === "npm" || manager === "pnpm"
                  ? "--save-exact"
                  : "--exact",
              ],
        ]);
        expect(f.context.changes).toEqual([
          {
            project_id: f.f.context.project.project_id,
            path: "package.json",
            kind: "updated",
          },
          {
            project_id: f.f.context.project.project_id,
            path: "lock",
            kind: "created",
          },
        ]);
      });
for (const feature of ["lint", "typecheck"] as const)
  test(`${feature} reports completed native metadata changes on failure without retry or version fallback`, async () => {
    const f = fixture("yarn-modern", feature, true);
    f.fail();
    await expect(f.run()).rejects.toMatchObject({
      code: "native-preparation-failed",
      message: "Install tools: failed https://[redacted]@example.invalid/",
    });
    expect(f.steps).toHaveLength(1);
    expect(f.context.changes.map((change) => change.path)).toEqual([
      "package.json",
      "lock",
    ]);
    expect(f.context.versions[f.f.context.project.project_id ?? ""]).toEqual(
      f.tools,
    );
    expect(f.f.files.get(`${f.f.root}/lock`)).toBe("native lock output");
  });
