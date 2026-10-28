import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInventory } from "../../../src/dependencies/inventory";
import type { Adapter } from "../../../src/dependencies/model";
import {
  executeDependency,
  listProjects,
} from "../../../src/dependencies/service";
import { closePackagingStructure } from "../../../src/packaging/get-structure";

const roots: string[] = [];
afterEach(async () => {
  await closePackagingStructure();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "justomp-service-")),
  );
  roots.push(root);
  await writeFile(
    join(root, "package.json"),
    '{"name":"fixture","packageManager":"npm@11.12.1","private":true}',
  );
  return root;
}
test("project selection returns only stable IDs and relative paths", async () => {
  const root = await fixture();
  expect(await listProjects(root)).toEqual({
    projects: [{ project_id: "javascript:package.json", relative_path: "." }],
  });
  expect(
    (
      await executeDependency(
        root,
        "update",
        { project_id: "stale", packages: [{ name: "foo" }] },
        {},
      )
    ).outcome,
  ).toBe("rejected");
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
  expect(await readFile(join(root, "package.json"), "utf8")).toContain(
    "99999.0.0",
  );
  expect("native_steps" in result && result.native_steps?.length).toBe(2);
});

test("Python name aliases cannot target one declaration twice", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "pyproject.toml"),
    '[project]\nname="app"\nversion="1"\n[tool.uv]\nrequired-version="0.11.6"\n',
  );
  const result = await executeDependency(
    root,
    "add",
    {
      project_id: "python:pyproject.toml",
      group: { kind: "runtime" },
      packages: [
        { name: "Foo_Bar", source: { kind: "registry" } },
        { name: "foo-bar", source: { kind: "registry" } },
      ],
    },
    {},
  );
  expect(result.outcome).toBe("rejected");
  expect(result.diagnostics?.[0]?.code).toBe("duplicate-dependency");
});
test("an existing dependency outside the inspected root prevents native mutation", async () => {
  const root = await fixture();
  const manifest =
    '{"name":"fixture","packageManager":"npm@11.12.1","dependencies":{"outside":"file:../outside"}}';
  await writeFile(join(root, "package.json"), manifest);
  const result = await executeDependency(
    root,
    "sync",
    { project_id: "javascript:package.json" },
    {},
  );
  expect(result.outcome).toBe("rejected");
  expect(result.diagnostics?.[0]?.code).toBe("outside-root");
  expect(await readFile(join(root, "package.json"), "utf8")).toBe(manifest);
});

test("JavaScript registry names cannot be interpreted as repository shorthand", async () => {
  const root = await fixture();
  const result = await executeDependency(
    root,
    "add",
    {
      project_id: "javascript:package.json",
      group: { kind: "runtime" },
      packages: [{ name: "owner/repository", source: { kind: "registry" } }],
    },
    {},
  );
  expect(result.outcome).toBe("rejected");
  expect(result.diagnostics?.[0]?.code).toBe("invalid-package");
});

test("JavaScript exact updates reject partial semver before native commands", async () => {
  const root = await fixture();
  const result = await executeDependency(
    root,
    "update",
    {
      project_id: "javascript:package.json",
      packages: [{ name: "foo", version: "1.2" }],
    },
    {},
  );
  expect(result.outcome).toBe("rejected");
  expect(result.diagnostics?.[0]?.code).toBe("invalid-version");
});
