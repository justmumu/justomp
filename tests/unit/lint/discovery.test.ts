import { afterEach, expect, spyOn, test } from "bun:test";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import * as config from "../../../src/config/load";
import type {
  LintAdapter,
  ToolVersions,
} from "../../../src/lint/adapters/types";
import { prepareLint } from "../../../src/lint/prepare";
import * as projection from "../../../src/lint/projection";
import { LintStateStore } from "../../../src/lint/state";
import * as targets from "../../../src/lint/targets";
import * as packaging from "../../../src/packaging/get-structure";
import { target } from "../checks/fixture";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});
function keep<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}
for (const ecosystem of ["javascript", "go"] as const) {
  test(`${ecosystem} discovery replaces failed targets, persists before preflight and never adopts failed resolution`, async () => {
    const selected: targets.LintTarget[] = [];
    const add = (id: string) => {
      const value = target(ecosystem);
      value.project.project_id = `${ecosystem}:${id}`;
      value.scope.owner = `/repo/${id}`;
      value.scope.domains = [`manager:${id}`];
      selected.push(value);
    };
    add("a");
    const structure = {
      ...selected[0]?.structure,
      root: "/repo",
      projects: [],
    } as targets.LintTarget["structure"];
    const store = {
      state: { schema: 2, projects: {}, waves: {} },
      async save() {
        persisted = structuredClone(store.state);
      },
    } as unknown as LintStateStore;
    let persisted = structuredClone(store.state);
    let latest = "1.0.0",
      resolves = 0,
      preflightFailure = false,
      resolutionFailure = false,
      unresolved = "";
    const installed = new Map<string, ToolVersions>();
    keep(
      spyOn(packaging, "getPackagingStructure").mockImplementation(async () => {
        structure.projects = selected.map((t) => t.project);
        return { structure } as packaging.PackagingResult;
      }),
    );
    keep(
      spyOn(targets, "resolveLintTarget").mockImplementation(async (_s, id) => {
        if (id === unresolved) throw new Error("manager unavailable");
        const found = selected.find((t) => t.project.project_id === id);
        if (!found) throw new Error("missing fixture target");
        return found;
      }),
    );
    keep(
      spyOn(config, "loadConfig").mockResolvedValue({
        lint: resolveLintConfig().policy,
      } as config.LoadedConfig),
    );
    keep(spyOn(LintStateStore, "load").mockResolvedValue(store));
    keep(
      spyOn(projection, "planProjection").mockImplementation(
        async (current) => ({
          target: current,
          current: true,
          files: [],
          configs: { lint: "/config", format: "/config" },
        }),
      ),
    );
    const adapter: LintAdapter = {
      async resolve(members, _policy, _signal, existing) {
        if (existing) return existing;
        resolves++;
        if (resolutionFailure) throw new Error("registry unavailable");
        return Object.fromEntries(
          members.map((t) => [t.project.project_id, { tool: latest }]),
        );
      },
      async preflight(context) {
        expect(persisted.waves[ecosystem]?.versions).toEqual(context.versions);
        expect(persisted.waves[ecosystem]?.complete).toBe(false);
        if (preflightFailure) throw new Error("latest incompatible");
      },
      async prepareBatch(context) {
        for (const t of context.targets)
          installed.set(
            t.project.project_id,
            context.versions[t.project.project_id] ?? {},
          );
      },
      async verify(context) {
        return (
          installed.get(context.target.project.project_id)?.tool ===
          context.versions.tool
        );
      },
      async check() {
        return [];
      },
    };
    const run = () =>
      prepareLint(
        "/repo",
        { [ecosystem]: adapter },
        new AbortController().signal,
      );
    expect((await run()).complete).toBe(true);
    expect(resolves).toBe(1);
    add("b");
    latest = "2.0.0";
    preflightFailure = true;
    expect((await run()).complete).toBe(false);
    latest = "3.0.0";
    expect((await run()).complete).toBe(false);
    expect(resolves).toBe(2);
    expect(store.state.waves[ecosystem]?.versions[`${ecosystem}:a`]).toEqual({
      tool: "2.0.0",
    });
    add("c");
    expect((await run()).complete).toBe(false);
    expect(resolves).toBe(3);
    preflightFailure = false;
    expect((await run()).complete).toBe(true);
    expect([...installed.values()]).toEqual([
      { tool: "3.0.0" },
      { tool: "3.0.0" },
      { tool: "3.0.0" },
    ]);
    add("d");
    resolutionFailure = true;
    expect((await run()).complete).toBe(false);
    expect(store.state.waves[ecosystem]?.projects).not.toContain(
      `${ecosystem}:d`,
    );
    latest = "4.0.0";
    resolutionFailure = false;
    expect((await run()).complete).toBe(true);
    expect(resolves).toBe(5);
    add("e");
    unresolved = `${ecosystem}:e`;
    expect((await run()).complete).toBe(false);
    expect(store.state.waves[ecosystem]?.complete).toBe(false);
    expect(resolves).toBe(5);
    selected.splice(0);
    expect((await run()).complete).toBe(true);
    expect(store.state.waves[ecosystem]).toBeUndefined();
    add("a");
    unresolved = "";
    expect((await run()).complete).toBe(true);
    expect(resolves).toBe(6);
  });
}
