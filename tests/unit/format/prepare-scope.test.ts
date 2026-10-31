import { afterEach, expect, spyOn, test } from "bun:test";
import {
  lintPolicyKey,
  resolveLintConfig,
} from "../../../src/config/lint/resolve";
import * as config from "../../../src/config/load";
import type { LintAdapter } from "../../../src/lint/adapters/types";
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
test("scoped native preparation includes all Python projects but preserves other ecosystem receipts", async () => {
  const selected = [target("python"), target("python"), target("go")] as const;
  for (const [index, current] of selected.entries()) {
    current.project.project_id = `${current.project.ecosystem}:project${index}`;
    current.scope.domains = [`manager:${index}`];
  }
  const structure = {
    ...selected[0].structure,
    root: "/repo",
    projects: selected.map((current) => current.project),
  };
  const policy = resolveLintConfig().policy;
  const tools = { ruff: "0.17.3" };
  const store = {
    state: {
      schema: 1,
      projects: Object.fromEntries(
        selected.map((current) => [
          current.project.project_id,
          {
            ecosystem: current.project.ecosystem,
            tools,
            ready: true,
            policy_hash: lintPolicyKey(policy[current.project.ecosystem]),
          },
        ]),
      ),
      python: {
        projects: selected
          .slice(0, 2)
          .map((current) => current.project.project_id),
        tools,
        complete: true,
      },
    },
    async save() {},
  } as unknown as LintStateStore;
  const goReceipt = structuredClone(store.state.projects["go:project2"]);
  keep(
    spyOn(packaging, "getPackagingStructure").mockResolvedValue({
      structure,
    } as packaging.PackagingResult),
  );
  keep(
    spyOn(targets, "resolveLintTarget").mockImplementation(
      async (_structure, id) => {
        const found = selected.find(
          (current) => current.project.project_id === id,
        );
        if (!found) throw new Error(`Unknown fixture project: ${id}`);
        return found;
      },
    ),
  );
  keep(
    spyOn(config, "loadConfig").mockResolvedValue({
      lint: policy,
    } as config.LoadedConfig),
  );
  keep(spyOn(LintStateStore, "load").mockResolvedValue(store));
  keep(
    spyOn(projection, "planProjection").mockImplementation(async (current) => ({
      target: current,
      current: true,
      files: [],
      configs: { lint: "/config", format: "/config" },
    })),
  );
  const verified: string[] = [];
  const adapter: LintAdapter = {
    async resolve() {
      throw new Error("Resolved pins must be retained");
    },
    async preflight(context) {
      expect(
        context.targets.map((current) => current.project.project_id),
      ).toEqual(["python:project0", "python:project1"]);
    },
    async prepareBatch() {
      throw new Error("Ready environments must not install tools");
    },
    async verify(context) {
      verified.push(context.target.project.project_id);
      return true;
    },
    async check() {
      throw new Error("Preparation does not check sources");
    },
  };
  const result = await prepareLint(
    "/repo",
    { python: adapter },
    new AbortController().signal,
    undefined,
    ["python"],
  );
  expect(result.complete, JSON.stringify(result)).toBe(true);
  expect(result.affected_projects).toEqual([
    "python:project0",
    "python:project1",
  ]);
  expect(new Set(verified)).toEqual(
    new Set(["python:project0", "python:project1"]),
  );
  expect(store.state.projects["go:project2"]).toEqual(goReceipt);
});
