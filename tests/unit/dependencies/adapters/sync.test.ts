import { expect, test } from "bun:test";
import { bunAdapter } from "../../../../src/dependencies/adapters/bun";
import { goAdapter } from "../../../../src/dependencies/adapters/go";
import { npmAdapter } from "../../../../src/dependencies/adapters/npm";
import { pnpmAdapter } from "../../../../src/dependencies/adapters/pnpm";
import { uvAdapter } from "../../../../src/dependencies/adapters/uv";
import { yarnClassicAdapter } from "../../../../src/dependencies/adapters/yarn-classic";
import { yarnModernAdapter } from "../../../../src/dependencies/adapters/yarn-modern";
import type { Adapter, Inventory } from "../../../../src/dependencies/model";
import { memoryContext } from "../memory";

const cases: {
  name: string;
  adapter: Adapter;
  manager: "uv" | "npm" | "pnpm" | "yarn" | "bun" | "go";
  lock?: string;
  sync: string[];
  check: string[];
  owner: boolean;
}[] = [
  {
    name: "uv",
    adapter: uvAdapter,
    manager: "uv",
    lock: "uv.lock",
    sync: ["sync", "--package", "app", "--locked"],
    check: ["lock", "--check"],
    owner: false,
  },
  {
    name: "npm",
    adapter: npmAdapter,
    manager: "npm",
    lock: "package-lock.json",
    sync: ["ci"],
    check: ["ci", "--dry-run", "--ignore-scripts", "--no-audit", "--no-fund"],
    owner: true,
  },
  {
    name: "pnpm",
    adapter: pnpmAdapter,
    manager: "pnpm",
    lock: "pnpm-lock.yaml",
    sync: ["install", "--frozen-lockfile"],
    check: ["install", "--frozen-lockfile"],
    owner: false,
  },
  {
    name: "Yarn Classic",
    adapter: yarnClassicAdapter,
    manager: "yarn",
    lock: "yarn.lock",
    sync: ["install", "--frozen-lockfile", "--non-interactive"],
    check: ["install", "--frozen-lockfile", "--non-interactive"],
    owner: true,
  },
  {
    name: "modern Yarn",
    adapter: yarnModernAdapter,
    manager: "yarn",
    lock: "yarn.lock",
    sync: ["install", "--immutable"],
    check: ["install", "--immutable"],
    owner: true,
  },
  {
    name: "Bun",
    adapter: bunAdapter,
    manager: "bun",
    lock: "bun.lock",
    sync: ["install", "--frozen-lockfile"],
    check: ["install", "--frozen-lockfile", "--dry-run"],
    owner: true,
  },
  {
    name: "Go",
    adapter: goAdapter,
    manager: "go",
    sync: ["mod", "download"],
    check: ["mod", "tidy", "-diff"],
    owner: false,
  },
];
const empty: Inventory = { dependencies: [], complete: true, diagnostics: [] };

for (const entry of cases) {
  test(`${entry.name} selects native check while keeping normal sync and scope`, async () => {
    const ecosystem =
      entry.manager === "uv"
        ? "python"
        : entry.manager === "go"
          ? "go"
          : "javascript";
    const manifest =
      ecosystem === "python"
        ? "pyproject.toml"
        : ecosystem === "go"
          ? "go.mod"
          : "package.json";
    const f = memoryContext({
      manager: entry.manager,
      ecosystem,
      path: "apps/api",
      manifest: `apps/api/${manifest}`,
      workspace: "workspace:.",
      name: "app",
    });
    f.context.cwd = `${f.root}/apps/api`;
    f.write(`apps/api/${manifest}`, "{}");
    if (entry.lock) f.write(entry.lock, "# supplied lock");
    try {
      for (const check of [undefined, false, true]) {
        const plan = await entry.adapter.plan(
          f.context,
          {
            operation: "sync",
            project_id: f.context.project.project_id,
            ...(check === undefined ? {} : { check }),
          },
          empty,
        );
        expect(plan.steps.map((step) => step.args)).toEqual([
          check ? entry.check : entry.sync,
        ]);
        expect(plan.steps[0]?.cwd ?? f.context.cwd).toBe(
          entry.owner ? f.context.owner : f.context.cwd,
        );
      }
    } finally {
      f.close();
    }
  });
  if (entry.lock)
    test(`${entry.name} check requires an existing lock`, async () => {
      const f = memoryContext({ manager: entry.manager });
      try {
        await expect(
          entry.adapter.plan(
            f.context,
            {
              operation: "sync",
              project_id: f.context.project.project_id,
              check: true,
            },
            empty,
          ),
        ).rejects.toThrow(/lock/i);
      } finally {
        f.close();
      }
    });
}
