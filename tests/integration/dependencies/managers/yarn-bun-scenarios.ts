import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Adapter } from "../../../../src/dependencies/model";
import { fixture, gitSource, type Variant } from "./yarn-bun-fixture";

export function nativeScenarios(variant: Variant, adapter: Adapter) {
  test(`${variant}: native Git source retains the requested ref through install and update`, async () => {
    const f = await fixture(variant);
    const git = await gitSource(f.root);
    try {
      await f.operate(adapter, {
        operation: "add",
        group: { kind: "runtime" },
        packages: [
          {
            name: "u6-git",
            source: { kind: "git", url: git.url, ref: "main" },
          },
        ],
      });
      expect((await f.manifest()).dependencies["u6-git"]).toContain("#main");
      expect(
        (await adapter.inventory(await f.context(), false)).dependencies[0]
          ?.source.kind,
      ).toBe("git");
      await f.operate(adapter, {
        operation: "update",
        packages: [{ name: "u6-git" }],
      });
      expect((await f.manifest()).dependencies["u6-git"]).toContain("#main");
      await f.operate(adapter, { operation: "sync" });
      await f.operate(adapter, {
        operation: "remove",
        group: { kind: "runtime" },
        packages: [{ name: "u6-git" }],
      });
    } finally {
      await git.close();
      await f.close();
    }
  }, 60000);

  test(`${variant}: native groups preserve unrelated declarations`, async () => {
    const f = await fixture(variant, true);
    try {
      for (const kind of ["runtime", "dev", "optional", "peer"] as const) {
        await f.operate(adapter, {
          operation: "add",
          group: { kind },
          packages: [
            {
              name: "u6-other",
              version: "1.0.0",
              source: { kind: "registry" },
            },
          ],
        });
        const inventory = await adapter.inventory(await f.context(), false);
        expect(
          inventory.dependencies.find((d) => d.name === "u6-other")?.group.kind,
        ).toBe(kind);
        await f.operate(adapter, {
          operation: "remove",
          group: { kind },
          packages: [{ name: "u6-other" }],
        });
        expect(
          (await adapter.inventory(await f.context(), false)).dependencies,
        ).toHaveLength(0);
      }
    } finally {
      await f.close();
    }
  }, 60000);

  test(`${variant}: duplicate groups reject unsafe native add and preserve group-only removal`, async () => {
    const f = await fixture(variant);
    try {
      await writeFile(
        join(f.root, "package.json"),
        JSON.stringify({
          name: "fixture-root",
          dependencies: { "u6-dep": "1.0.0" },
          devDependencies: { "u6-dep": "1.0.0" },
        }),
      );
      const before = await readFile(join(f.root, "package.json"), "utf8");
      await expect(
        f.operate(adapter, {
          operation: "add",
          group: { kind: "dev" },
          packages: [
            { name: "u6-dep", version: "2.0.0", source: { kind: "registry" } },
          ],
        }),
      ).rejects.toMatchObject({ code: "unsupported-group-operation" });
      expect(await readFile(join(f.root, "package.json"), "utf8")).toBe(before);
      const request = {
        operation: "remove",
        group: { kind: "dev" },
        packages: [{ name: "u6-dep" }],
      };
      if (variant === "bun") {
        await f.operate(adapter, request);
        expect((await f.manifest()).dependencies["u6-dep"]).toBe("1.0.0");
        expect(
          (await f.manifest()).devDependencies?.["u6-dep"],
        ).toBeUndefined();
      } else {
        await expect(f.operate(adapter, request)).rejects.toMatchObject({
          code: "unsupported-group-operation",
        });
        expect(await readFile(join(f.root, "package.json"), "utf8")).toBe(
          before,
        );
      }
    } finally {
      await f.close();
    }
  }, 60000);

  test(`${variant}: native local and workspace sources never resolve from registry`, async () => {
    const f = await fixture(variant, true);
    try {
      await mkdir(join(f.root, "local"));
      await writeFile(
        join(f.root, "local/package.json"),
        JSON.stringify({
          name: "u6-local",
          version: "1.0.0",
          dependencies: { "u6-child": "1.0.0" },
          main: "index.js",
        }),
      );
      await writeFile(join(f.root, "local/index.js"), "module.exports=42;");
      await f.operate(adapter, {
        operation: "add",
        group: { kind: "runtime" },
        packages: [
          { name: "u6-local", source: { kind: "path", path: "local" } },
        ],
      });
      expect((await f.manifest()).dependencies["u6-local"]).toContain("file:");
      const localGraph = await adapter.inventory(await f.context(), true);
      expect(localGraph.complete).toBe(true);
      expect(localGraph.dependencies.some((d) => d.name === "u6-child")).toBe(
        true,
      );
      const ctx = await f.context();
      const target = ctx.structure.projects.find(
        (p) => p.path === "packages/b",
      );
      if (!target) throw new Error("workspace target missing");
      if (variant === "classic")
        await expect(
          f.operate(adapter, {
            operation: "add",
            group: { kind: "dev" },
            packages: [
              {
                name: "u6-b",
                source: {
                  kind: "workspace",
                  target_project_id: target.project_id,
                },
              },
            ],
          }),
        ).rejects.toMatchObject({ code: "unsupported-group-operation" });
      await f.operate(adapter, {
        operation: "add",
        group: { kind: "runtime" },
        packages: [
          {
            name: "u6-b",
            source: { kind: "workspace", target_project_id: target.project_id },
          },
        ],
      });
      expect((await f.manifest()).dependencies["u6-b"]).toMatch(
        variant === "classic" ? /^file:/ : /^workspace:/,
      );
      const before = await readFile(
        join(f.root, "packages/a/package.json"),
        "utf8",
      );
      await expect(
        f.operate(adapter, {
          operation: "add",
          group: { kind: "runtime" },
          packages: [
            {
              name: "wrong-name",
              source: {
                kind: "workspace",
                target_project_id: target.project_id,
              },
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "source-name-mismatch" });
      expect(
        await readFile(join(f.root, "packages/a/package.json"), "utf8"),
      ).toBe(before);
      await expect(
        f.operate(adapter, {
          operation: "update",
          mode: "latest",
          packages: [{ name: "u6-local" }],
        }),
      ).rejects.toMatchObject({ code: "unsupported-source-operation" });
      await f.operate(adapter, {
        operation: "update",
        packages: [{ name: "u6-local" }],
      });
      expect((await f.manifest()).dependencies["u6-local"]).toContain("file:");
      await f.operate(adapter, { operation: "sync" });
    } finally {
      await f.close();
    }
  }, 60000);

  test(`${variant}: shared workspace update preserves sibling manifests and reports lock scope`, async () => {
    const f = await fixture(variant, true);
    try {
      await f.operate(adapter, {
        operation: "add",
        group: { kind: "runtime" },
        packages: [
          { name: "u6-dep", version: "^1.0.0", source: { kind: "registry" } },
        ],
      });
      await f.operate(
        adapter,
        {
          operation: "add",
          group: { kind: "runtime" },
          packages: [
            {
              name: "u6-dep",
              version: ">=1.0.0 <2.0.0",
              source: { kind: "registry" },
            },
          ],
        },
        "packages/b",
      );
      await f.operate(
        adapter,
        {
          operation: "add",
          group: { kind: "dev" },
          packages: [
            {
              name: "u6-other",
              version: "1.0.0",
              source: { kind: "registry" },
            },
          ],
        },
        "packages/b",
      );
      const graph = await adapter.inventory(await f.context(), true);
      expect(graph.complete).toBe(true);
      expect(
        graph.dependencies.some((dependency) => dependency.name === "u6-other"),
      ).toBe(false);
      const sibling = await readFile(
        join(f.root, "packages/b/package.json"),
        "utf8",
      );
      const own = await readFile(
        join(f.root, "packages/a/package.json"),
        "utf8",
      );
      f.publish("2.0.0");
      const within = await f.operate(adapter, {
        operation: "update",
        packages: [{ name: "u6-dep" }],
      });
      expect(await f.installed("u6-dep")).toBe("1.1.0");
      expect(within.plan.affectedProjects).toHaveLength(3);
      expect(within.plan.metadata).toContain(
        variant === "bun" ? "bun.lock" : "yarn.lock",
      );
      expect(
        await readFile(join(f.root, "packages/b/package.json"), "utf8"),
      ).toBe(sibling);
      if (variant === "modern") {
        expect(
          await readFile(join(f.root, "packages/a/package.json"), "utf8"),
        ).toBe(own);
        expect(await f.installed("u6-dep", "packages/b")).toBe("1.1.0");
      }
      await f.operate(adapter, {
        operation: "update",
        mode: "latest",
        packages: [{ name: "u6-dep" }],
      });
      expect((await f.manifest()).dependencies["u6-dep"]).toContain("2.0.0");
      expect(
        await readFile(join(f.root, "packages/b/package.json"), "utf8"),
      ).toBe(sibling);
      await f.operate(adapter, {
        operation: "update",
        packages: [{ name: "u6-dep", version: "1.0.0" }],
      });
      expect((await f.manifest()).dependencies["u6-dep"]).toBe("1.0.0");
      expect(
        await readFile(join(f.root, "packages/b/package.json"), "utf8"),
      ).toBe(sibling);
    } finally {
      await f.close();
    }
  }, 60000);

  test(`${variant}: frozen sync rejects missing and stale locks; graph listing is read-only`, async () => {
    const f = await fixture(variant);
    try {
      expect((await adapter.inventory(await f.context(), true)).complete).toBe(
        false,
      );
      await expect(
        f.operate(adapter, { operation: "sync" }),
      ).rejects.toMatchObject({ code: "lockfile-required" });
      await f.operate(adapter, {
        operation: "add",
        group: { kind: "runtime" },
        packages: [
          { name: "u6-dep", version: "1.0.0", source: { kind: "registry" } },
        ],
      });
      const lock = join(f.root, variant === "bun" ? "bun.lock" : "yarn.lock");
      const before = await readFile(lock, "utf8");
      await rm(join(f.root, "node_modules"), { force: true, recursive: true });
      expect((await adapter.inventory(await f.context(), true)).complete).toBe(
        true,
      );
      expect(await readFile(lock, "utf8")).toBe(before);
      await f.operate(adapter, { operation: "sync" });
      const manifest = await f.manifest();
      manifest.dependencies["u6-other"] = "1.0.0";
      await writeFile(join(f.root, "package.json"), JSON.stringify(manifest));
      await expect(f.operate(adapter, { operation: "sync" })).rejects.toThrow();
      expect(await readFile(lock, "utf8")).toBe(before);
    } finally {
      await f.close();
    }
  }, 60000);
}
