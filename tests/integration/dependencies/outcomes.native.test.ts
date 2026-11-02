import { afterEach, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { readInventory } from "../../../src/dependencies/inventory";
import { type Adapter } from "../../../src/dependencies/model";
import { executeDependency } from "../../../src/dependencies/service";
import { closePackagingStructure } from "../../../src/packaging/get-structure";
import { suppliedResponse } from "../../response";
import { fixture, roots } from "./outcomes-fixture";

afterEach(async () => {
  await closePackagingStructure();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
test("redaction preserves completed mutation evidence with token-like paths and URLs", async () => {
  const path = "token=example",
    root = await fixture(path),
    project_id = `javascript:${path}/package.json`;
  const url = "https://fixture-user:fixture-secret@example.invalid/repo.git?token=fixture-token";
  const adapter: Adapter = {
    groups: ["runtime"],
    inventory: (ctx) => readInventory(ctx.root, ctx.project),
    plan: (ctx, request) => {
      return suppliedResponse(() => {
        if (request.operation !== "add") {
          throw new Error("fixture add only");
        }
        return {
          metadata: [ctx.project.manifest],
          affectedProjects: [ctx.project.project_id],
          steps: [
            {
              label: "native declaration",
              args: ["pkg", "set", `dependencies.foo=${url}`],
            },
          ],
        };
      });
    },
  };
  const result = await executeDependency(
    root,
    "add",
    {
      project_id,
      group: { kind: "runtime" },
      packages: [{ name: "foo", source: { kind: "git", url, ref: "main" } }],
    },
    { npm: adapter },
  );
  expect(result.outcome).toBe("success");
  expect("native_steps" in result && result.native_steps.length).toBe(1);
  expect("metadata_changes" in result && result.metadata_changes).toEqual([
    { path: `${path}/package.json`, change: "modified" },
  ]);
  expect(await readFile(join(root, path, "package.json"), "utf8")).toContain(url);
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
  expect(JSON.stringify(result)).not.toContain("fixture-token");
  expect(JSON.parse(JSON.stringify(result)).project_id).toBe(project_id);
});
