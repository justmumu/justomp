import { afterEach, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { readInventory } from "../../../src/dependencies/inventory";
import { type Adapter } from "../../../src/dependencies/model";
import { executeDependency } from "../../../src/dependencies/service";
import { closePackagingStructure } from "../../../src/packaging/get-structure";
import { fixture, roots } from "./service-fixture";

afterEach(async () => {
  await closePackagingStructure();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
test("native two-step failure reports metadata and never rolls back", async () => {
  const root = await fixture();
  const adapter: Adapter = {
    groups: ["runtime"],
    inventory: (ctx) => readInventory(ctx.root, ctx.project),
    plan: async () => ({
      metadata: ["package.json", "package-lock.json"],
      affectedProjects: ["javascript:package.json"],
      steps: [
        {
          label: "declaration",
          args: ["pkg", "set", "dependencies.foo=99999.0.0"],
        },
        {
          label: "materialization",
          args: ["install", "--offline", "--ignore-scripts"],
        },
      ],
    }),
  };
  const result = await executeDependency(
    root,
    "add",
    {
      project_id: "javascript:package.json",
      group: { kind: "runtime" },
      packages: [{ name: "foo", source: { kind: "registry" } }],
    },
    { npm: adapter },
  );
  expect(result.outcome).toBe("partial_change");
  expect(await readFile(join(root, "package.json"), "utf8")).toContain("99999.0.0");
  expect("native_steps" in result && result.native_steps.length).toBe(2);
});
