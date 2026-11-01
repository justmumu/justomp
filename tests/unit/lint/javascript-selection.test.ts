import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
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
      selected.scope.cwd = join("/repo", path);
      selected.project.frameworks =
        flavor === "next"
          ? ["next", "react"]
          : flavor === "react"
            ? ["react"]
            : [];
      return selected;
    },
  );
  for (const selected of targets)
    selected.structure.projects = targets.map((t) => t.project);
  const stateFile = keep(
    spyOn(files, "readProjectionFile").mockResolvedValue({
      text: null,
      identity: null,
      mode: 0o644,
    }),
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
    spyOn(fs, "readFile").mockImplementation((async (
      path: unknown,
      encoding?: unknown,
    ) => {
      const selected = targets.find(
        (t) => join(t.scope.cwd, "package.json") === String(path),
      );
      if (!selected)
        throw new Error(`Unexpected fixture read: ${String(path)}`);
      const text = JSON.stringify({
        devDependencies: apps[selected.project.project_id] ?? {},
      });
      return encoding === "utf8" ? text : Buffer.from(text);
    }) as typeof fs.readFile),
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
    stateFile,
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
test("fresh selection uses publisher latest once per tool without compatible-version fallback", async () => {
  const f = fixture("react", true);
  const registry = registryFixture();
  try {
    const selected = await javascriptAdapter.resolve(
      f.targets,
      f.context.policy,
      f.context.signal,
    );
    for (const tools of Object.values(selected)) {
      expect(tools.eslint).toBe("10.0.0");
      expect(tools.typescript).toBe("7.0.2");
      expect(tools["eslint-plugin-jsx-a11y"]).toBe("6.10.2");
      expect(tools["@next/eslint-plugin-next"]).toBeUndefined();
    }
    expect(registry.calls()).toBe(
      Object.keys(selected["javascript:."] ?? {}).length,
    );
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
    const tools = selected["javascript:."] ?? {};
    const metadata = Object.fromEntries(
      Object.entries(tools).map(([name, version]) => [
        name,
        registry.records[name]?.[version] as compatibility.Metadata,
      ]),
    );
    expect(() =>
      compatibility.validateCompatibility(metadata, tools, {}, "22.15.0"),
    ).toThrow("incompatible");
  } finally {
    registry.fetcher.mockRestore();
  }
});
test("application compiler does not constrain latest plugin selection or get replaced", async () => {
  const f = fixture("ts");
  f.apps["javascript:."] = { typescript: "7.0.2" };
  const registry = registryFixture();
  try {
    const selected = await javascriptAdapter.resolve(
      f.targets,
      f.context.policy,
      f.context.signal,
    );
    expect(selected["javascript:."]?.["typescript-eslint"]).toBe("8.72.1");
    expect(selected["javascript:."]?.typescript).toBeUndefined();
    expect(f.apps["javascript:."]?.typescript).toBe("7.0.2");
  } finally {
    registry.fetcher.mockRestore();
  }
});
test("fresh selection shares latest Next plugin even across incompatible application majors", async () => {
  const f = fixture("next", true);
  f.apps["javascript:packages/a"] = { typescript: "5.8.3", next: "14.2.35" };
  const registry = registryFixture();
  try {
    const selected = await javascriptAdapter.resolve(
      f.targets,
      f.context.policy,
      f.context.signal,
    );
    for (const tools of Object.values(selected)) {
      expect(tools["@next/eslint-plugin-next"]).toBe("15.5.6");
      expect(tools.eslint).toBe("10.0.0");
      expect(tools.typescript).toBeUndefined();
    }
    expect(() =>
      compatibility.validateCompatibility(
        {},
        selected["javascript:packages/a"] ?? {},
        f.apps["javascript:packages/a"] ?? {},
        "22.15.0",
      ),
    ).toThrow("Next");
  } finally {
    registry.fetcher.mockRestore();
  }
});
test("new optional plugin aligns only its consumers while unrelated retained pins stay exact", async () => {
  const f = fixture("js", true);
  const [first, second] = f.targets;
  if (!first || !second) throw new Error("missing fixture targets");
  first.project.frameworks = ["react"];
  second.project.frameworks = ["react"];
  const core = {
    eslint: "9.39.5",
    "@eslint/js": "9.39.5",
    "eslint-plugin-simple-import-sort": "12.1.1",
  };
  const retained = Object.fromEntries(
    f.targets.map((t) => [t.project.project_id, { ...core }]),
  );
  retained[first.project.project_id] = {
    ...core,
    "eslint-plugin-react-hooks": "6.0.0",
    "eslint-plugin-jsx-a11y": "6.0.0",
  } as typeof core;
  const registry = registryFixture();
  try {
    const selected = await javascriptAdapter.resolve(
      f.targets,
      f.context.policy,
      f.context.signal,
      retained,
    );
    expect(registry.calls()).toBe(2);
    for (const id of [first.project.project_id, second.project.project_id]) {
      expect(selected[id]).toEqual({
        ...core,
        "eslint-plugin-react-hooks": "7.0.1",
        "eslint-plugin-jsx-a11y": "6.10.2",
      });
    }
    expect(selected["javascript:packages/b"]).toEqual(core);
  } finally {
    registry.fetcher.mockRestore();
  }
});
test("missing compiler follows current typecheck target but rejects stale-membership authority", async () => {
  const f = fixture("ts", true);
  const registry = registryFixture();
  const state = {
    schema: 1,
    projects: {},
    waves: {
      javascript: {
        projects: f.targets.map((t) => t.project.project_id),
        tools: { typescript: "6.0.0" },
        pending: [],
        complete: false,
      },
    },
  };
  try {
    f.stateFile.mockResolvedValue({
      text: JSON.stringify(state),
      identity: "inode",
      mode: 0o644,
    });
    let selected = await javascriptAdapter.resolve(
      f.targets,
      f.context.policy,
      f.context.signal,
    );
    expect(
      Object.values(selected).every((tools) => tools.typescript === "6.0.0"),
    ).toBe(true);
    state.waves.javascript.projects.pop();
    f.stateFile.mockResolvedValue({
      text: JSON.stringify(state),
      identity: "inode",
      mode: 0o644,
    });
    selected = await javascriptAdapter.resolve(
      f.targets,
      f.context.policy,
      f.context.signal,
    );
    expect(
      Object.values(selected).every((tools) => tools.typescript === "7.0.2"),
    ).toBe(true);
  } finally {
    registry.fetcher.mockRestore();
  }
});
test("invalid latest metadata fails rather than selecting catalog releases", async () => {
  const f = fixture("js");
  const registry = registryFixture();
  try {
    for (const invalid of [undefined, "11.0.0-beta.1", "garbage"]) {
      registry.latest.eslint = invalid;
      await expect(
        javascriptAdapter.resolve(
          f.targets,
          f.context.policy,
          f.context.signal,
        ),
      ).rejects.toThrow("exact stable");
    }
    registry.fetcher.mockRejectedValue(new Error("registry unavailable"));
    await expect(
      javascriptAdapter.resolve(f.targets, f.context.policy, f.context.signal),
    ).rejects.toThrow("registry unavailable");
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

test("compiler declaration selection leaves installed-version compatibility to persisted-target preflight", async () => {
  const f = fixture("ts");
  f.apps["javascript:."] = { typescript: "^7.0.0" };
  const registry = registryFixture();
  const application = keep(
    spyOn(compatibility, "applicationVersions").mockRejectedValue(
      new Error("installed compiler does not satisfy declaration"),
    ),
  );
  try {
    const selected = await javascriptAdapter.resolve(
      f.targets,
      f.context.policy,
      f.context.signal,
    );
    expect(selected["javascript:."]?.eslint).toBe("10.0.0");
    expect(selected["javascript:."]?.typescript).toBeUndefined();
    expect(application).not.toHaveBeenCalled();
    const calls = registry.calls();
    registry.latest.eslint = "11.0.0";
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
