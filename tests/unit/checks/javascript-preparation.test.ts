import { afterEach, expect, spyOn, test } from "bun:test";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import { resolveTypecheckConfig } from "../../../src/config/typecheck/resolve";
import { type Adapter, type DependencyRequest, type Inventory, type NativeStep } from "../../../src/dependencies/model";
import * as runner from "../../../src/dependencies/runner";
import { javascriptAdapter as lint } from "../../../src/lint/adapters/javascript";
import { type LintOperationContext } from "../../../src/lint/adapters/types";
import * as native from "../../../src/lint/javascript/native";
import * as runtime from "../../../src/lint/runtime";
import * as toolchain from "../../../src/lint/toolchain";
import { javascriptAdapter as typecheck } from "../../../src/typecheck/adapters/javascript";
import { suppliedResponse } from "../../response";
import { memoryContext } from "../dependencies/memory";
import { output, target } from "./fixture";

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
    feature === "lint" ? { "@biomejs/biome": toolchain.BIOME_VERSION } : { typescript: "7.0.2" };
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
    plan: (_ctx, request) => {
      return suppliedResponse(() => {
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
      });
    },
  };
  const steps: NativeStep[] = [];
  let result = output();
  f.write("package.json", JSON.stringify({ name: "app", dependencies: { existing: "1.0.0" } }));
  f.context.run = (step) => {
    return suppliedResponse(() => {
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
    });
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
    selected,
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
    run: () => (feature === "lint" ? lint.prepareBatch(context) : typecheck.prepareBatch(typed)),
  };
}
for (const feature of ["typecheck"] as const) {
  for (const manager of ["npm", "pnpm", "yarn-classic", "yarn-modern", "bun"] as const) {
    for (const installed of [false, true]) {
      test(`${feature} ${manager} ${installed ? "updates" : "adds"} exact dev tools through its dependency adapter`, async () => {
        const f = fixture(manager, feature, installed);
        await f.run();
        const tools = Object.entries(f.tools).filter(([name]) => name !== "prettier");
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
            : ["fixture-mutation", manager === "npm" || manager === "pnpm" ? "--save-exact" : "--exact"],
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
    }
  }
}
for (const feature of ["typecheck"] as const) {
  test(`${feature} reports completed native metadata changes on failure without retry or version fallback`, async () => {
    const f = fixture("yarn-modern", feature, true);
    f.fail();
    await expect(f.run()).rejects.toMatchObject({
      code: "native-preparation-failed",
      message: "Install tools: failed https://[redacted]@example.invalid/",
    });
    expect(f.steps).toHaveLength(1);
    expect(f.context.changes.map((change) => change.path)).toEqual(["package.json", "lock"]);
    expect(f.context.versions[f.f.context.project.project_id]).toEqual(f.tools);
    expect(f.f.files.get(`${f.f.root}/lock`)).toBe("native lock output");
  });
}

test("bundled lint preparation preserves legacy dependencies without asking a project manager", async () => {
  const f = fixture("npm", "lint", true);
  const manifest = JSON.stringify({
    name: "app",
    dependencies: { prettier: "^3.5.0", "@biomejs/biome": "^1.9.0" },
    scripts: { lint: "biome check ." },
  });
  f.f.write("package.json", manifest);
  f.f.write("lock", "preserve legacy lock");
  const bundled = keep(spyOn(toolchain, "bundledBiome").mockResolvedValue("/extension/biome"));
  await f.run();
  expect(bundled).toHaveBeenCalledTimes(1);
  expect(f.requests).toEqual([]);
  expect(f.steps).toEqual([]);
  expect(f.context.changes).toEqual([]);
  expect(f.f.files.get(`${f.f.root}/package.json`)).toBe(manifest);
  expect(f.f.files.get(`${f.f.root}/lock`)).toBe("preserve legacy lock");
});

test("lint preflight validates the bundled binary without project Node or manager compatibility", async () => {
  const f = fixture("npm", "lint");
  keep(spyOn(toolchain, "bundledBiome").mockResolvedValue("/extension/biome"));
  const execute = keep(
    spyOn(runner, "runProcess").mockResolvedValue(output({ stdout: `Version: ${toolchain.BIOME_VERSION}\n` })),
  );
  const manager = keep(spyOn(runtime, "lintManagerContext").mockRejectedValue(new Error("No project manager")));
  f.selected.scope.env = { PATH: "", BIOME_BINARY: "/foreign/biome" };
  await lint.preflight(f.context);
  expect(execute.mock.calls[0]?.slice(0, 2)).toEqual(["/extension/biome", ["--version"]]);
  expect(execute.mock.calls[0]?.[2]).toMatchObject({
    cwd: process.cwd(),
    env: {
      BIOME_BINARY: undefined,
      BIOME_CONFIG_PATH: undefined,
      BIOME_LOG_FILE: undefined,
      BIOME_LOG_LEVEL: undefined,
    },
    signal: f.context.signal,
  });
  expect(manager).not.toHaveBeenCalled();
  expect(f.steps).toEqual([]);
  execute.mockResolvedValue(output({ stdout: "Version: 1.0.0\n" }));
  await expect(lint.preflight(f.context)).rejects.toThrow(`bundled Biome ${toolchain.BIOME_VERSION}`);
});

test("missing bundled optional dependency fails lint preparation without project installation or fallback", async () => {
  const f = fixture("npm", "lint");
  keep(
    spyOn(toolchain, "bundledBiome").mockRejectedValue(
      new Error("Justomp's native Biome package is unavailable; reinstall Justomp with optional dependencies"),
    ),
  );
  await expect(lint.preflight(f.context)).rejects.toThrow("reinstall Justomp with optional dependencies");
  await expect(f.run()).rejects.toThrow("reinstall Justomp with optional dependencies");
  expect(f.requests).toEqual([]);
  expect(f.steps).toEqual([]);
  expect(f.context.changes).toEqual([]);
});

test("Biome readiness checks the release pin and native result, not project declaration or Node", async () => {
  const f = fixture("npm", "lint");
  const selected = f.selected;
  selected.scope.env = { PATH: "", BIOME_BINARY: "/foreign/biome" };
  keep(spyOn(toolchain, "bundledBiome").mockResolvedValue("/extension/biome"));
  const executable = keep(
    spyOn(runner, "runProcess").mockResolvedValue(output({ stdout: `Version: ${toolchain.BIOME_VERSION}\n` })),
  );
  const manager = keep(spyOn(runtime, "lintManagerContext").mockRejectedValue(new Error("No project manager")));
  const context = {
    target: selected,
    versions: f.tools,
    policy: f.context.policy,
    signal: f.context.signal,
    projection: {
      target: selected,
      files: [],
      current: true,
      configs: { lint: "/repo/biome.json", format: "/repo/.prettierrc.json" },
    },
  };
  expect(await lint.verify(context)).toBe(true);
  expect(manager).not.toHaveBeenCalled();
  context.versions = { "@biomejs/biome": "1.0.0" };
  executable.mockClear();
  expect(await lint.verify(context)).toBe(false);
  expect(executable).not.toHaveBeenCalled();
  context.versions = f.tools;
  for (const result of [
    output({ stdout: "Version: 1.0.0\n" }),
    output({ stdout: `Version: ${toolchain.BIOME_VERSION}\n`, exit_code: 1 }),
    output({ stdout: `Version: ${toolchain.BIOME_VERSION}\n`, truncated: true }),
    output({ stdout: `Version: ${toolchain.BIOME_VERSION}\n`, cancelled: true }),
  ]) {
    executable.mockResolvedValue(result);
    expect(await lint.verify(context)).toBe(false);
  }
  executable.mockRejectedValue(new Error("Missing native optional package"));
  expect(await lint.verify(context)).toBe(false);
});

test("Biome fixes invoke the owned executable with explicit config, safe write and sanitized target environment", async () => {
  const f = fixture("npm", "lint");
  const selected = f.selected;
  selected.scope.env = {
    PATH: "",
    KEEP: "target",
    BIOME_BINARY: "/foreign/biome",
    BIOME_CONFIG_PATH: "/foreign/config",
    BIOME_LOG_FILE: "/foreign/log",
    BIOME_LOG_LEVEL: "debug",
  };
  keep(spyOn(toolchain, "bundledBiome").mockResolvedValue("/extension/biome"));
  const execute = keep(spyOn(runner, "runProcess").mockResolvedValue(output()));
  if (!lint.fix) {
    throw new Error("Biome safe fix is unavailable");
  }
  await lint.fix(
    {
      target: selected,
      policy: f.context.policy,
      versions: f.tools,
      signal: f.context.signal,
      projection: {
        target: selected,
        files: [],
        current: true,
        configs: { lint: "/repo/biome.json", format: "/repo/.prettierrc.json" },
      },
    },
    ["index.ts", "-option.ts"],
  );
  expect(execute).toHaveBeenCalledWith(
    "/extension/biome",
    [
      "check",
      "--config-path=/repo/biome.json",
      "--formatter-enabled=false",
      "--linter-enabled=true",
      "--assist-enabled=true",
      "--enforce-assist=true",
      "--max-diagnostics=none",
      "--reporter=json",
      "--write",
      "--",
      "./index.ts",
      "./-option.ts",
    ],
    {
      cwd: selected.scope.cwd,
      env: {
        PATH: "",
        KEEP: "target",
        BIOME_BINARY: undefined,
        BIOME_CONFIG_PATH: undefined,
        BIOME_LOG_FILE: undefined,
        BIOME_LOG_LEVEL: undefined,
      },
      signal: f.context.signal,
    },
  );
  expect(selected.scope.env.BIOME_BINARY).toBe("/foreign/biome");
});
