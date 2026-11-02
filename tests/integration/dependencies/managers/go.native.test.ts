import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goAdapter } from "../../../../src/dependencies/adapters/go";
import { runProcess } from "../../../../src/dependencies/runner";
import { executeDependency } from "../../../../src/dependencies/service";
import { closePackagingStructure } from "../../../../src/packaging/get-structure";
import { createGoProxy } from "./go-proxy";

async function cleanFixture(root: string) {
  async function writable(path: string): Promise<void> {
    await chmod(path, 0o755);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await writable(join(path, entry.name));
      }
    }
  }
  await writable(root);
  await rm(root, { recursive: true, force: true });
}
const roots: string[] = [];
const envKeys = ["GOPROXY", "GOSUMDB", "GOMODCACHE", "GOCACHE"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
afterEach(async () => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  await closePackagingStructure();
  for (const root of roots.splice(0)) {
    await cleanFixture(root);
  }
});
async function fixture(workspace = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "justomp-go-")));
  roots.push(root);
  process.env.GOPROXY = "off";
  process.env.GOSUMDB = "off";
  process.env.GOMODCACHE = join(root, ".cache/modules");
  process.env.GOCACHE = join(root, ".cache/build");
  await mkdir(join(root, "local"));
  await writeFile(join(root, "main.go"), 'package app\nimport _ "example.test/lib"\n');
  await writeFile(join(root, "go.mod"), "module example.test/app\ngo 1.25\n");
  await writeFile(join(root, "local/go.mod"), "module example.test/lib\ngo 1.25\n");
  await writeFile(join(root, "local/lib.go"), "package lib\n");
  if (workspace) {
    await writeFile(join(root, "go.work"), "go 1.25\nuse (\n .\n ./local\n)\n");
  }
  return root;
}
const registry = { go: goAdapter };
test("Go native local add, list, sync and remove preserve module semantics", async () => {
  const root = await fixture();
  const input = {
    project_id: "go:go.mod",
    group: { kind: "runtime" },
    packages: [{ name: "example.test/lib", source: { kind: "path", path: "local" } }],
  };
  const add = await executeDependency(root, "add", input, registry);
  expect(add.outcome, JSON.stringify(add)).toBe("success");
  expect(await readFile(join(root, "go.mod"), "utf8")).toContain("example.test/lib v0.0.0");
  const list = await executeDependency(root, "list", { project_id: "go:go.mod", include_transitive: true }, registry);
  expect(list.outcome).toBe("success");
  expect("dependencies" in list && list.dependencies?.some((d) => d.name === "example.test/lib")).toBe(true);
  expect((await executeDependency(root, "sync", { project_id: "go:go.mod" }, registry)).outcome).toBe("success");
  // The add/download fixture is intentionally not tidy. Prepare a known tidy
  // baseline explicitly; the production check must never perform this repair.
  const tidy = await runProcess("go", ["mod", "tidy"], {
    cwd: root,
    env: { ...process.env, GOWORK: "off" },
  });
  expect(tidy.exit_code, tidy.stderr).toBe(0);
  const check = await executeDependency(root, "sync", { project_id: "go:go.mod", check: true }, registry);
  expect(check.outcome, JSON.stringify(check)).toBe("success");
  const beforeCheck = await readFile(join(root, "go.mod"), "utf8");
  await writeFile(join(root, "main.go"), "package app\n");
  const stale = await executeDependency(root, "sync", { project_id: "go:go.mod", check: true }, registry);
  expect(stale.outcome, JSON.stringify(stale)).toBe("failed");
  expect(await readFile(join(root, "go.mod"), "utf8")).toBe(beforeCheck);
  expect("native_steps" in stale && stale.native_steps?.[0]?.stdout).toContain("diff");
  expect(
    (await executeDependency(root, "remove", { ...input, packages: [{ name: "example.test/lib" }] }, registry)).outcome,
  ).toBe("success");
  expect(await readFile(join(root, "go.mod"), "utf8")).toContain("replace example.test/lib");
});
test("Go workspace source declares a dependency without changing membership", async () => {
  const root = await fixture(true);
  const before = await readFile(join(root, "go.work"), "utf8");
  expect(
    (
      await executeDependency(
        root,
        "add",
        {
          project_id: "go:go.mod",
          group: { kind: "runtime" },
          packages: [
            {
              name: "example.test/lib",
              source: {
                kind: "workspace",
                target_project_id: "go:local/go.mod",
              },
            },
          ],
        },
        registry,
      )
    ).outcome,
  ).toBe("success");
  expect(await readFile(join(root, "go.work"), "utf8")).toBe(before);
});

test("Go registry graph, targeted upgrades and downgrade use selected native versions", async () => {
  const root = await fixture();
  const proxy = join(root, ".proxy");
  await createGoProxy(proxy);
  process.env.GOPROXY = `file://${proxy}`;
  const project_id = "go:go.mod",
    group = { kind: "runtime" };
  const add = await executeDependency(
    root,
    "add",
    {
      project_id,
      group,
      packages: [
        {
          name: "example.test/lib",
          version: "1.0.0",
          source: { kind: "registry" },
        },
      ],
    },
    registry,
  );
  expect(add.outcome, JSON.stringify(add)).toBe("success");
  const beforeList = await readFile(join(root, "go.mod"), "utf8");
  const list = await executeDependency(root, "list", { project_id, include_transitive: true }, registry);
  expect(list.outcome, JSON.stringify(list)).toBe("success");
  expect("complete" in list && list.complete).toBe(true);
  expect("dependencies" in list && list.dependencies?.some((d) => d.name === "example.test/transitive")).toBe(true);
  expect(await readFile(join(root, "go.mod"), "utf8")).toBe(beforeList);
  for (const input of [
    {
      project_id,
      packages: [{ name: "example.test/lib" }],
      mode: "within_constraints",
    },
    { project_id, packages: [{ name: "example.test/lib", version: "1.0.0" }] },
    { project_id, packages: [{ name: "example.test/lib" }], mode: "latest" },
  ]) {
    const result = await executeDependency(root, "update", input, registry);
    expect(result.outcome, JSON.stringify(result)).toBe("success");
    expect(await readFile(join(root, "go.mod"), "utf8")).toContain(
      input.packages[0] && "version" in input.packages[0] ? "example.test/lib v1.0.0" : "example.test/lib v1.2.0",
    );
  }
});
test("Go module-plus-ref query resolves natively", async () => {
  const root = await fixture();
  const proxy = join(root, ".proxy");
  await createGoProxy(proxy);
  process.env.GOPROXY = `file://${proxy}`;
  const project_id = "go:go.mod",
    group = { kind: "runtime" };
  const result = await executeDependency(
    root,
    "add",
    {
      project_id,
      group,
      packages: [
        {
          name: "example.test/lib",
          source: { kind: "git", url: "example.test/lib", ref: "feature" },
        },
      ],
    },
    registry,
  );
  expect(result.outcome, JSON.stringify(result)).toBe("success");
  expect(await readFile(join(root, "go.mod"), "utf8")).toContain("example.test/lib v1.1.0");
});

test("cold Go graph is explicit and listing never fills cache or checksum metadata", async () => {
  const root = await fixture();
  const proxy = join(root, ".proxy");
  await createGoProxy(proxy);
  process.env.GOPROXY = `file://${proxy}`;
  const project_id = "go:go.mod";
  expect(
    (
      await executeDependency(
        root,
        "add",
        {
          project_id,
          group: { kind: "runtime" },
          packages: [
            {
              name: "example.test/lib",
              version: "1.0.0",
              source: { kind: "registry" },
            },
          ],
        },
        registry,
      )
    ).outcome,
  ).toBe("success");
  await cleanFixture(join(root, ".cache/modules"));
  const mod = await readFile(join(root, "go.mod"), "utf8"),
    sum = await readFile(join(root, "go.sum"), "utf8");
  const result = await executeDependency(root, "list", { project_id, include_transitive: true }, registry);
  expect("complete" in result && result.complete).toBe(false);
  expect(await readFile(join(root, "go.mod"), "utf8")).toBe(mod);
  expect(await readFile(join(root, "go.sum"), "utf8")).toBe(sum);
  const sync = await executeDependency(root, "sync", { project_id }, registry);
  expect(sync.outcome, JSON.stringify(sync)).toBe("success");
  const warm = await executeDependency(root, "list", { project_id, include_transitive: true }, registry);
  expect("complete" in warm && warm.complete).toBe(true);
});

test("Go remove retains replacement and registry re-add rejects it", async () => {
  const root = await fixture();
  const input = { project_id: "go:go.mod", group: { kind: "runtime" } };
  const add = await executeDependency(
    root,
    "add",
    {
      ...input,
      packages: [{ name: "example.test/lib", source: { kind: "path", path: "local" } }],
    },
    registry,
  );
  expect(add.outcome, JSON.stringify(add)).toBe("success");
  const remove = await executeDependency(
    root,
    "remove",
    {
      ...input,
      packages: [{ name: "example.test/lib" }],
    },
    registry,
  );
  expect(remove.outcome, JSON.stringify(remove)).toBe("success");
  const before = await readFile(join(root, "go.mod"), "utf8");
  const result = await executeDependency(
    root,
    "add",
    {
      ...input,
      packages: [
        {
          name: "example.test/lib",
          version: "1.0.0",
          source: { kind: "registry" },
        },
      ],
    },
    registry,
  );
  expect(result.outcome, JSON.stringify(result)).toBe("rejected");
  expect(result.diagnostics?.[0]?.code).toBe("unsupported-source-operation");
  expect(await readFile(join(root, "go.mod"), "utf8")).toBe(before);
});

test("Go verifies effective local add source under a go.work replacement", async () => {
  const root = await fixture();
  await mkdir(join(root, "override"));
  await writeFile(join(root, "override/go.mod"), "module example.test/lib\ngo 1.25\n");
  await writeFile(join(root, "override/lib.go"), "package lib\n");
  await writeFile(join(root, "go.work"), "go 1.25\nuse .\nreplace example.test/lib => ./override\n");
  const before = await readFile(join(root, "go.work"), "utf8");
  const result = await executeDependency(
    root,
    "add",
    {
      project_id: "go:go.mod",
      group: { kind: "runtime" },
      packages: [{ name: "example.test/lib", source: { kind: "path", path: "local" } }],
    },
    registry,
  );
  expect(result.outcome, JSON.stringify(result)).toBe("partial_change");
  expect(result.diagnostics?.[0]?.code).toBe("postcondition-failed");
  expect(await readFile(join(root, "go.work"), "utf8")).toBe(before);
});
