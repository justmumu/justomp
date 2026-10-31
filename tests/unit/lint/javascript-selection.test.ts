import { afterEach, expect, spyOn, test } from "bun:test";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import type { AdapterContext } from "../../../src/dependencies/model";
import { javascriptAdapter } from "../../../src/lint/adapters/javascript";
import * as files from "../../../src/lint/files";
import * as compatibility from "../../../src/lint/javascript/compatibility";
import * as native from "../../../src/lint/javascript/native";
import { requiredJavascriptTools } from "../../../src/lint/javascript/tools";
import * as runtime from "../../../src/lint/runtime";
import * as scopes from "../../../src/lint/scope";
import { LintStateStore } from "../../../src/lint/state";
import * as versions from "../../../src/lint/versions";
import { TOOLS } from "../../fixtures/lint/javascript/versions";
import { scope, target } from "../checks/fixture";
import { registryFixture } from "./registry-fixture";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});
function keep<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}
function fixture(flavor: "js" | "ts" | "react" | "next", workspace = false) {
  const targets = (workspace ? [".", "packages/a", "packages/b"] : ["."]).map(
    (path) => {
      const selected = target("javascript");
      selected.project.project_id = `javascript:${path}`;
      selected.project.frameworks =
        flavor === "next"
          ? ["next", "react"]
          : flavor === "react"
            ? ["react"]
            : [];
      return selected;
    },
  );
  const apps: Record<string, Record<string, string>> = Object.fromEntries<
    Record<string, string>
  >(
    targets.map((t): [string, Record<string, string>] => [
      t.project.project_id,
      flavor === "next" ? { typescript: "5.9.3", next: "15.5.6" } : {},
    ]),
  );
  keep(
    spyOn(scopes, "collectLintScope").mockResolvedValue(
      scope(flavor === "js" ? "index.js" : "index.ts"),
    ),
  );
  keep(
    spyOn(runtime, "lintManagerContext").mockResolvedValue(
      {} as AdapterContext,
    ),
  );
  keep(spyOn(compatibility, "nodeVersion").mockResolvedValue("22.15.0"));
  keep(
    spyOn(compatibility, "applicationVersions").mockImplementation(
      async (t) => apps[t.project.project_id] ?? {},
    ),
  );
  keep(spyOn(native, "installedPackages").mockResolvedValue({}));
  return {
    targets,
    apps,
    context: {
      policy: resolveLintConfig().policy,
      signal: new AbortController().signal,
    },
  };
}
test("framework scope selects only needed plugins and retained disabled pins never query registry", async () => {
  const f = fixture("js");
  const target = f.targets[0];
  if (!target) throw new Error("missing target");
  expect(
    await requiredJavascriptTools(target, f.context.policy.javascript),
  ).toEqual(["eslint", "@eslint/js", "eslint-plugin-simple-import-sort"]);
  const retained = { [target.project.project_id]: { ...TOOLS } };
  const fetcher = spyOn(versions, "fetchVersionJSON").mockRejectedValue(
    new Error("Unexpected registry access"),
  );
  try {
    expect(
      await javascriptAdapter.resolve(
        f.targets,
        f.context.policy,
        f.context.signal,
        retained,
      ),
    ).toEqual({
      [target.project.project_id]: Object.fromEntries(
        Object.entries(TOOLS).filter(([name]) => name !== "prettier"),
      ),
    });
  } finally {
    fetcher.mockRestore();
  }
});
test("registry selection backtracks incompatible ESLint peers and selects compatible fresh TypeScript", async () => {
  const f = fixture("react");
  const registry = registryFixture();
  try {
    const selected = await javascriptAdapter.resolve(
      f.targets,
      f.context.policy,
      f.context.signal,
    );
    const tools = selected["javascript:."];
    expect(tools?.eslint).toBe("9.39.5");
    expect(tools?.typescript).toBe("5.9.3");
    expect(tools?.["eslint-plugin-jsx-a11y"]).toBe("6.10.2");
    expect(tools?.["@next/eslint-plugin-next"]).toBeUndefined();
    const calls = registry.calls();
    expect(
      await javascriptAdapter.resolve(
        f.targets,
        f.context.policy,
        f.context.signal,
        selected,
      ),
    ).toEqual(selected);
    expect(registry.calls()).toBe(calls);
  } finally {
    registry.fetcher.mockRestore();
  }
});
test("unsupported application TypeScript fails resolution without searching old ESLint families", async () => {
  const f = fixture("ts");
  f.apps["javascript:."] = { typescript: "7.0.2" };
  const registry = registryFixture();
  try {
    await expect(
      javascriptAdapter.resolve(f.targets, f.context.policy, f.context.signal),
    ).rejects.toThrow("TypeScript 7.0.2");
    expect(registry.calls()).toBe(1);
  } finally {
    registry.fetcher.mockRestore();
  }
});
test("heterogeneous workspace cohorts preserve per-project Next versions and retained shared pins", async () => {
  const f = fixture("next", true);
  const member = f.targets[1];
  if (!member) throw new Error("missing workspace member");
  f.apps[member.project.project_id] = { typescript: "5.8.3", next: "14.2.35" };
  const registry = registryFixture();
  registry.records["@next/eslint-plugin-next"] = {
    ...registry.records["@next/eslint-plugin-next"],
    "14.2.35": {
      name: "@next/eslint-plugin-next",
      version: "14.2.35",
      peerDependencies: {},
      engines: { node: ">=18" },
    },
  };
  try {
    const retained = await javascriptAdapter.resolve(
      f.targets.slice(0, 2),
      f.context.policy,
      f.context.signal,
    );
    expect(retained["javascript:."]?.["@next/eslint-plugin-next"]).toBe(
      "15.5.6",
    );
    expect(
      retained["javascript:packages/a"]?.["@next/eslint-plugin-next"],
    ).toBe("14.2.35");
    for (const tools of Object.values(retained)) {
      expect(tools.eslint).toBe("9.39.5");
      expect(tools["typescript-eslint"]).toBe("8.72.1");
      expect(tools.typescript).toBeUndefined();
    }
    const expanded = await javascriptAdapter.resolve(
      f.targets,
      f.context.policy,
      f.context.signal,
      retained,
    );
    for (const [id, tools] of Object.entries(retained))
      expect(expanded[id]).toEqual(tools);
    expect(expanded["javascript:packages/b"]).toEqual(retained["javascript:."]);

    // A new member cannot silently reconcile previously retained conflicting pins.
    const conflicting = structuredClone(retained);
    const memberTools = conflicting["javascript:packages/a"];
    if (!memberTools) throw new Error("missing retained member tools");
    memberTools.eslint = "10.0.0";
    const calls = registry.calls();
    await expect(
      javascriptAdapter.resolve(
        f.targets,
        f.context.policy,
        f.context.signal,
        conflicting,
      ),
    ).rejects.toThrow("Retained core tool eslint has inconsistent versions");
    expect(registry.calls()).toBe(calls);
  } finally {
    registry.fetcher.mockRestore();
  }
});

test("old JavaScript receipts drop only the managed Prettier pin", async () => {
  const receipt = {
    ecosystem: "javascript",
    tools: { ...TOOLS },
    ready: true,
    policy_hash: "previous",
  };
  keep(
    spyOn(files, "readProjectionFile").mockResolvedValue({
      text: JSON.stringify({
        schema: 1,
        projects: { "javascript:.": receipt },
      }),
      identity: "inode",
      mode: 0o644,
    }),
  );
  const store = await LintStateStore.load("/repo");
  expect(store.recovery).toBeUndefined();
  expect(store.state.projects["javascript:."]?.tools).toEqual(
    Object.fromEntries(
      Object.entries(TOOLS).filter(([name]) => name !== "prettier"),
    ),
  );
  expect(receipt.tools.prettier).toBe("3.6.2");
});
