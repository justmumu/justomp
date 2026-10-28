import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInventory } from "../../../src/dependencies/inventory";
import type { Adapter } from "../../../src/dependencies/model";
import { executeDependency } from "../../../src/dependencies/service";
import { inspectProject } from "../../../src/inspect/scan";
import { closePackagingStructure } from "../../../src/packaging/get-structure";

const roots: string[] = [];
afterEach(async () => {
  await closePackagingStructure();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(path = ".") {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "justomp-outcomes-")),
  );
  roots.push(root);
  await mkdir(join(root, path), { recursive: true });
  await writeFile(
    join(root, path, "package.json"),
    JSON.stringify({
      name: "fixture",
      packageManager: "npm@11.12.1",
      version: "1.0.0",
    }),
  );
  return root;
}
test("redaction preserves completed mutation evidence with token-like paths and URLs", async () => {
  const path = "token=example",
    root = await fixture(path),
    project_id = `javascript:${path}/package.json`;
  const url =
    "https://fixture-user:fixture-secret@example.invalid/repo.git?token=fixture-token";
  const adapter: Adapter = {
    groups: ["runtime"],
    inventory: (ctx) => readInventory(ctx.root, ctx.project),
    plan: async (ctx, request) => {
      if (request.operation !== "add") throw new Error("fixture add only");
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
  expect("native_steps" in result && result.native_steps?.length).toBe(1);
  expect("metadata_changes" in result && result.metadata_changes).toEqual([
    { path: `${path}/package.json`, change: "modified" },
  ]);
  expect(await readFile(join(root, path, "package.json"), "utf8")).toContain(
    url,
  );
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
  expect(JSON.stringify(result)).not.toContain("fixture-token");
  expect(JSON.parse(JSON.stringify(result)).project_id).toBe(project_id);
});
test("native planning retains original source credentials while list responses redact them", async () => {
  const root = await fixture(),
    source =
      "git+https://fixture-user:fixture-secret@example.invalid/repo.git?token=fixture-token#main";
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      packageManager: "npm@11.12.1",
      dependencies: { foo: source },
    }),
  );
  const project = (await inspectProject({ root })).projects[0];
  if (!project) throw new Error("missing fixture");
  expect(
    (await readInventory(root, project)).dependencies[0]?.declared_specifier,
  ).toBe(source);
  const adapter: Adapter = {
    groups: ["runtime"],
    inventory: (ctx) => readInventory(ctx.root, ctx.project),
    plan: async () => {
      throw new Error("list only");
    },
  };
  const result = await executeDependency(
    root,
    "list",
    { project_id: project.project_id },
    { npm: adapter },
  );
  expect(result.outcome).toBe("success");
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
  expect(JSON.stringify(result)).not.toContain("fixture-token");
});
test("cancelled native list cannot become successful incomplete inventory", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      packageManager: "npm@11.12.1",
      scripts: { wait: "node wait.cjs" },
    }),
  );
  await writeFile(
    join(root, "wait.cjs"),
    'require("node:fs").writeFileSync("ready","yes");setInterval(()=>{},1000);',
  );
  const controller = new AbortController();
  const adapter: Adapter = {
    groups: ["runtime"],
    inventory: async (ctx) => {
      const result = await ctx.run({
        args: ["run", "wait"],
        label: "native graph",
      });
      expect(result.cancelled).toBe(true);
      return { dependencies: [], complete: false, diagnostics: [] };
    },
    plan: async () => {
      throw new Error("list only");
    },
  };
  const operation = executeDependency(
    root,
    "list",
    { project_id: "javascript:package.json", include_transitive: true },
    { npm: adapter },
    controller.signal,
  );
  try {
    const deadline = Date.now() + 10000;
    while (!(await Bun.file(join(root, "ready")).exists())) {
      if (Date.now() > deadline) throw new Error("native graph did not start");
      await Bun.sleep(10);
    }
    controller.abort();
    expect((await operation).outcome).toBe("cancelled");
  } finally {
    controller.abort();
    await operation;
  }
}, 15000);
