import { afterEach, expect, spyOn, test } from "bun:test";
import { resolveIntegrationTestConfig } from "../../../src/config/integration-test/resolve";
import * as config from "../../../src/config/load";
import { resolveTestConfig } from "../../../src/config/test/resolve";
import * as packaging from "../../../src/packaging/get-structure";
import { type TestAdapter, type TestTools } from "../../../src/testing/adapters";
import { prepareTests } from "../../../src/testing/prepare";
import { TestStateStore } from "../../../src/testing/state";
import * as targets from "../../../src/testing/targets";
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
for (const runner of ["pytest", "vitest"] as const) {
  test(`${runner} preparation supersedes partial targets on discovery and preserves exact unchanged retries`, async () => {
    const ecosystem = runner === "pytest" ? "python" : "javascript";
    const members: targets.TestTarget[] = [];
    const add = (name: string) => {
      const selected = { ...target(ecosystem), runner } as targets.TestTarget;
      selected.project.project_id = `${ecosystem}:${name}`;
      selected.scope.owner = `/repo/${name}`;
      selected.scope.domains = [`manager:${name}`];
      members.push(selected);
    };
    add("a");
    const structure = {
      ...members[0]?.structure,
      root: "/repo",
      projects: [],
    } as targets.TestTarget["structure"];
    const store = {
      state: { schema: 1, projects: {}, waves: {} },
      async save() {
        persisted = structuredClone(store.state);
      },
    } as unknown as TestStateStore;
    let persisted = structuredClone(store.state);
    let latest = "1.0.0",
      resolves = 0,
      failed = "",
      resolutionFailure = false,
      unresolved = "";
    const installed = new Map<string, TestTools>();
    keep(
      spyOn(packaging, "getPackagingStructure").mockImplementation(async () => {
        structure.projects = members.map((t) => t.project);
        return { structure } as packaging.PackagingResult;
      }),
    );
    keep(
      spyOn(targets, "resolveTestTarget").mockImplementation(async (_s, id) => {
        if (id === unresolved) {
          throw new Error("runner unresolved");
        }
        const selected = members.find((t) => t.project.project_id === id);
        if (!selected) {
          throw new Error("missing fixture target");
        }
        return selected;
      }),
    );
    keep(
      spyOn(config, "loadConfig").mockResolvedValue({
        test: resolveTestConfig().policy,
        integrationTest: resolveIntegrationTestConfig().policy,
      } as config.LoadedConfig),
    );
    keep(spyOn(TestStateStore, "load").mockResolvedValue(store));
    const adapter: TestAdapter = {
      async resolve() {
        resolves++;
        if (resolutionFailure) {
          throw new Error("registry unavailable");
        }
        return { [runner]: latest };
      },
      async preflight(context) {
        expect(persisted.waves[runner]?.tools).toEqual(context.tools);
        expect(persisted.waves[runner]?.complete).toBe(false);
      },
      async prepare(context, changes) {
        if (context.target.project.project_id === failed) {
          throw new Error("install failed");
        }
        installed.set(context.target.project.project_id, { ...context.tools });
        changes.push({
          project_id: context.target.project.project_id,
          path: "manifest",
          kind: "updated",
        });
      },
      async verify(context) {
        return installed.get(context.target.project.project_id)?.[runner] === context.tools[runner];
      },
      async run() {
        throw new Error("Preparation must not execute tests");
      },
    };
    const run = () => prepareTests("/repo", { [runner]: adapter }, new AbortController().signal);
    expect((await run()).complete).toBe(true);
    add("b");
    latest = "2.0.0";
    failed = `${ecosystem}:b`;
    const partial = await run();
    expect(partial.complete).toBe(false);
    expect(partial.changes).toHaveLength(1);
    latest = "3.0.0";
    expect((await run()).complete).toBe(false);
    expect(resolves).toBe(2);
    expect(store.state.waves[runner]?.tools).toEqual({ [runner]: "2.0.0" });
    add("c");
    expect((await run()).complete).toBe(false);
    expect(resolves).toBe(3);
    expect(store.state.waves[runner]?.tools).toEqual({ [runner]: "3.0.0" });
    failed = "";
    expect((await run()).complete).toBe(true);
    expect([...installed.values()]).toEqual(Array.from({ length: 3 }, () => ({ [runner]: "3.0.0" })));
    add("d");
    resolutionFailure = true;
    expect((await run()).complete).toBe(false);
    expect(store.state.waves[runner]?.projects).not.toContain(`${ecosystem}:d`);
    resolutionFailure = false;
    latest = "4.0.0";
    expect((await run()).complete).toBe(true);
    expect(resolves).toBe(5);
    add("e");
    unresolved = `${ecosystem}:e`;
    expect((await run()).complete).toBe(false);
    expect(store.state.waves[runner]?.complete).toBe(false);
    expect(resolves).toBe(5);
    if (runner === "vitest") {
      unresolved = "";
      for (const member of members) {
        member.runner = "bun";
      }
      let runtimeReads = 0;
      const runtime: TestAdapter = {
        ...adapter,
        async resolve() {
          runtimeReads++;
          return { bun: "1.4.2" };
        },
        async preflight() {},
        async verify() {
          return true;
        },
        async prepare() {
          throw new Error("Installed runtime must not be upgraded");
        },
      };
      expect(
        (await prepareTests("/repo", { vitest: adapter, bun: runtime }, new AbortController().signal)).complete,
      ).toBe(true);
      expect(store.state.waves.vitest).toBeUndefined();
      expect(runtimeReads).toBe(members.length);
      expect(resolves).toBe(5);
      for (const member of members) {
        member.runner = "vitest";
      }
      expect((await run()).complete).toBe(true);
      expect(resolves).toBe(6);
    }
    const beforeRemoval = resolves;
    members.splice(0);
    expect((await run()).complete).toBe(true);
    expect(store.state.waves[runner]).toBeUndefined();
    add("a");
    unresolved = "";
    expect((await run()).complete).toBe(true);
    expect(resolves).toBe(beforeRemoval + 1);
  });
}
