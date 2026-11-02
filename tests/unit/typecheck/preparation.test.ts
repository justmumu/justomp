import { afterEach, expect, spyOn, test } from "bun:test";
import * as config from "../../../src/config/load";
import { resolveTypecheckConfig } from "../../../src/config/typecheck/resolve";
import { LintStateStore } from "../../../src/lint/state";
import * as packaging from "../../../src/packaging/get-structure";
import { type ToolVersions, type TypecheckAdapter } from "../../../src/typecheck/adapters/types";
import { prepareTypecheck } from "../../../src/typecheck/prepare";
import * as projection from "../../../src/typecheck/projection";
import { type TypecheckState, TypecheckStateStore } from "../../../src/typecheck/state";
import * as targets from "../../../src/typecheck/targets";
import { target } from "../checks/fixture";

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
function fixture(ecosystem: "python" | "javascript" = "python") {
  const tool = ecosystem === "python" ? "pyright" : "typescript";
  const members: targets.TypecheckTarget[] = [];
  const state: TypecheckState = { schema: 1, projects: {}, waves: {} };
  let persisted = structuredClone(state);
  const store = {
    state,
    save: () => {
      persisted = structuredClone(state);
      return Promise.resolve();
    },
  } as TypecheckStateStore;
  const lint = {
    state: { schema: 3, projects: {}, waves: {} },
    save: () => Promise.resolve(),
  } as unknown as LintStateStore;
  const installed = new Map<string, ToolVersions>();
  const controls: { latest: string; resolves: number; fail: string; preflight: boolean; invalid: boolean } = {
    latest: "1.0.0",
    resolves: 0,
    fail: "",
    preflight: false,
    invalid: false,
  };
  const structure = {
    ...target(ecosystem).structure,
    root: "/repo",
    complete: true,
    projects: [],
  } as targets.TypecheckTarget["structure"];
  const add = (name: string) => {
    const selected = target(ecosystem);
    selected.project.project_id = `${ecosystem}:${name}`;
    selected.project.path = name;
    selected.scope.owner = `/repo/${name}`;
    selected.scope.domains = [`manager:${name}`];
    members.push(selected);
    structure.projects = members.map((item) => item.project);
  };
  add("a");
  keep(spyOn(packaging, "getPackagingStructure").mockResolvedValue({ structure } as packaging.PackagingResult));
  keep(
    spyOn(targets, "resolveTypecheckTarget").mockImplementation((_s, id) => {
      const selected = members.find((item) => item.project.project_id === id);
      return selected ? Promise.resolve(selected) : Promise.reject(new Error("missing target"));
    }),
  );
  keep(
    spyOn(config, "loadConfig").mockResolvedValue({
      typecheck: resolveTypecheckConfig().policy,
    } as config.LoadedConfig),
  );
  keep(spyOn(TypecheckStateStore, "load").mockResolvedValue(store));
  keep(spyOn(LintStateStore, "load").mockResolvedValue(lint));
  keep(spyOn(projection, "applyProjection").mockResolvedValue([]));
  const adapter: TypecheckAdapter = {
    resolve(selected) {
      controls.resolves++;
      const versions = Object.fromEntries(
        selected.map((item) => [item.project.project_id, { [tool]: controls.latest }]),
      );
      return Promise.resolve(versions);
    },
    preflight(context) {
      expect(persisted.waves[ecosystem]?.tools).toEqual(context.versions[members[0]?.project.project_id ?? ""]);
      return controls.preflight ? Promise.reject(new Error("preflight failed")) : Promise.resolve();
    },
    prepareBatch(context) {
      return new Promise((resolve, reject) => {
        for (const selected of context.targets) {
          const id = selected.project.project_id;
          if (id === controls.fail) {
            reject(new Error("install failed"));
            return;
          }
          installed.set(id, { ...context.versions[id] });
          context.changes.push({ project_id: id, path: `${selected.project.path}/manifest`, kind: "updated" });
        }
        resolve();
      });
    },
    verifyTools(context) {
      return Promise.resolve(
        JSON.stringify(installed.get(context.target.project.project_id)) === JSON.stringify(context.versions),
      );
    },
    plan(selected) {
      return Promise.resolve({ target: selected, files: [], current: !controls.invalid, configs: { check: [] } });
    },
    check() {
      return Promise.reject(new Error("Preparation cannot execute a check"));
    },
  };
  const run = () => prepareTypecheck("/repo", { [ecosystem]: adapter }, new AbortController().signal);
  return { add, run, controls, state, installed, lint, members, structure };
}

for (const ecosystem of ["python", "javascript"] as const) {
  test(`${ecosystem} preparation retains failed targets and aligns newly discovered members`, async () => {
    const f = fixture(ecosystem);
    expect((await f.run()).complete).toBe(true);
    f.add("b");
    f.controls.latest = "2.0.0";
    f.controls.fail = `${ecosystem}:b`;
    const partial = await f.run();
    expect(partial.complete).toBe(false);
    expect(partial.changes).toHaveLength(1);
    expect(f.state.waves[ecosystem]?.complete).toBe(false);
    f.controls.latest = "3.0.0";
    expect((await f.run()).complete).toBe(false);
    expect(f.controls.resolves).toBe(2);
    f.add("c");
    f.controls.fail = "";
    expect((await f.run()).complete).toBe(true);
    expect(f.controls.resolves).toBe(3);
    expect([...f.installed.values()]).toEqual(
      Array.from({ length: 3 }, () => ({ [ecosystem === "python" ? "pyright" : "typescript"]: "3.0.0" })),
    );
  });
}

test("preflight and final projection failures never publish ready receipts", async () => {
  const f = fixture();
  f.controls.preflight = true;
  expect((await f.run()).complete).toBe(false);
  expect(f.installed.size).toBe(0);
  expect(f.state.projects).toMatchObject({ "python:a": { ready: false } });
  f.controls.preflight = false;
  f.controls.invalid = true;
  const result = await f.run();
  expect(result.complete).toBe(false);
  expect(result.changes).toHaveLength(1);
  expect(f.controls.resolves).toBe(1);
  expect(f.state.projects).toMatchObject({ "python:a": { ready: false } });
});

test("verified TypeScript alignment releases an older lint-owned compiler after partial failure", async () => {
  const f = fixture("javascript");
  f.lint.state.projects["javascript:a"] = {
    ecosystem: "javascript",
    tools: { typescript: "0.9.0", biome: "2.0.0" },
    ready: true,
    policy_hash: "old",
  };
  f.lint.state.waves.javascript = {
    projects: ["javascript:a"],
    versions: { "javascript:a": { typescript: "0.9.0", biome: "2.0.0" } },
    complete: true,
  };
  f.add("b");
  f.controls.fail = "javascript:b";
  expect((await f.run()).complete).toBe(false);
  expect(Object.values(f.lint.state.projects).map((receipt) => receipt.tools)).toEqual([{ biome: "2.0.0" }]);
  expect(f.lint.state.waves.javascript?.versions["javascript:a"]).toEqual({ biome: "2.0.0" });
  expect(f.lint.state.waves.javascript?.complete).toBe(false);
});
