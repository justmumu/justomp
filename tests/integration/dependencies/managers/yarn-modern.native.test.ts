import { expect, test } from "bun:test";
import { yarnModernAdapter as adapter } from "../../../../src/dependencies/adapters/yarn-modern";
import { fixture } from "./yarn-bun-fixture";

test("Yarn modern native registry lifecycle respects constraints and exact downgrades", async () => {
  const f = await fixture("modern");
  try {
    await f.operate(adapter, {
      operation: "add",
      group: { kind: "runtime" },
      packages: [{ name: "u6-dep", version: "^1.0.0", source: { kind: "registry" } }],
    });
    const graph = await adapter.inventory(await f.context(), true);
    expect(graph.complete).toBe(true);
    expect(graph.dependencies.some((d) => d.name === "u6-child" && !d.direct)).toBe(true);
    expect(await f.installed("u6-dep")).toBe("1.0.0");
    f.publish("2.0.0");
    await f.operate(adapter, {
      operation: "update",
      packages: [{ name: "u6-dep" }],
    });
    expect((await f.manifest()).dependencies["u6-dep"]).toBe("^1.0.0");
    expect(await f.installed("u6-dep")).toBe("1.1.0");
    await f.operate(adapter, {
      operation: "update",
      mode: "latest",
      packages: [{ name: "u6-dep" }],
    });
    expect((await f.manifest()).dependencies["u6-dep"]).toContain("2.0.0");
    expect(await f.installed("u6-dep")).toBe("2.0.0");
    await f.operate(adapter, {
      operation: "update",
      packages: [{ name: "u6-dep", version: "v1.0.0" }],
    });
    expect(await f.installed("u6-dep")).toBe("1.0.0");
    expect((await f.manifest()).dependencies["u6-dep"]).toBe("1.0.0");
    await f.operate(adapter, { operation: "sync" });
    await f.operate(adapter, {
      operation: "remove",
      group: { kind: "runtime" },
      packages: [{ name: "u6-dep" }],
    });
    expect((await f.manifest()).dependencies?.["u6-dep"]).toBeUndefined();
  } finally {
    await f.close();
  }
}, 60000);

import { nativeScenarios } from "./yarn-bun-scenarios";

nativeScenarios("modern", adapter);

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

test("modern Yarn node_modules linker shares the same native graph contract as PnP", async () => {
  const f = await fixture("modern");
  try {
    await appendFile(join(f.root, ".yarnrc.yml"), "nodeLinker: node-modules\n");
    await f.operate(adapter, {
      operation: "add",
      group: { kind: "runtime" },
      packages: [{ name: "u6-dep", version: "1.0.0", source: { kind: "registry" } }],
    });
    expect(JSON.parse(await readFile(join(f.root, "node_modules/u6-dep/package.json"), "utf8")).version).toBe("1.0.0");
    expect((await adapter.inventory(await f.context(), true)).complete).toBe(true);
    await f.operate(adapter, { operation: "sync" });
  } finally {
    await f.close();
  }
}, 60000);

import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { executeDependency } from "../../../../src/dependencies/service";
import { closePackagingStructure } from "../../../../src/packaging/get-structure";

test("service reports Yarn shared-lock resolution changes in both members", async () => {
  const f = await fixture("modern", true);
  const previousPath = process.env.PATH;
  try {
    const launcher = process.env.JUSTOMP_YARN_MODERN_BINARY ?? Bun.which("yarn");
    if (!launcher) {
      throw new Error("native Yarn launcher missing");
    }
    await mkdir(join(f.root, ".bin"));
    await symlink(launcher, join(f.root, ".bin/yarn"));
    process.env.PATH = `${join(f.root, ".bin")}:${previousPath ?? ""}`;
    for (const name of ["a", "b"]) {
      await writeFile(
        join(f.root, "packages", name, "package.json"),
        JSON.stringify({
          name: `u6-${name}`,
          version: "1.0.0",
          dependencies: { "u6-dep": "^1.0.0" },
        }),
      );
    }
    await f.operate(adapter, {
      operation: "add",
      group: { kind: "runtime" },
      packages: [{ name: "u6-dep", version: "^1.0.0", source: { kind: "registry" } }],
    });
    f.publish("2.0.0");
    const beforeA = await readFile(join(f.root, "packages/a/package.json"), "utf8");
    const beforeB = await readFile(join(f.root, "packages/b/package.json"), "utf8");
    const result = await executeDependency(
      f.root,
      "update",
      {
        project_id: "javascript:packages/a/package.json",
        packages: [{ name: "u6-dep" }],
      },
      { "yarn-modern": adapter },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.outcome).toBe("success");
    expect("affected_projects" in result && result.affected_projects).toEqual([
      {
        project_id: "javascript:packages/a/package.json",
        relative_path: "packages/a",
        effect: "resolutions_changed",
      },
      {
        project_id: "javascript:packages/b/package.json",
        relative_path: "packages/b",
        effect: "resolutions_changed",
      },
    ]);
    expect(await readFile(join(f.root, "packages/a/package.json"), "utf8")).toBe(beforeA);
    expect(await readFile(join(f.root, "packages/b/package.json"), "utf8")).toBe(beforeB);
    expect(await f.installed("u6-dep", "packages/a")).toBe("1.1.0");
    expect(await f.installed("u6-dep", "packages/b")).toBe("1.1.0");
    await rm(join(f.root, ".pnp.cjs"));
    const check = await executeDependency(
      f.root,
      "sync",
      {
        project_id: "javascript:packages/a/package.json",
        check: true,
      },
      { "yarn-modern": adapter },
    );
    expect(check.outcome, JSON.stringify(check)).toBe("success");
    expect("metadata_changes" in check && check.metadata_changes).toContainEqual({
      path: ".pnp.cjs",
      change: "created",
    });
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    await closePackagingStructure(f.root);
    await f.close();
  }
}, 60000);
