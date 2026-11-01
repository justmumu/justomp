import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Adapter } from "../../../../src/dependencies/model";
import { fixture } from "./npm-pnpm-fixture";
export function managerCases(manager: "npm" | "pnpm", adapter: Adapter) {
  test(`${manager} preserves constraints, pins exact downgrades and reads graph without installation`, async () => {
    const f = await fixture(manager);
    try {
      await f.operate(adapter, {
        operation: "add",
        group: { kind: "runtime" },
        packages: [
          {
            name: "fixture-dep",
            version: "^1.0.0",
            source: { kind: "registry" },
          },
        ],
      });
      f.publish();
      await f.operate(adapter, {
        operation: "update",
        packages: [{ name: "fixture-dep" }],
      });
      expect((await f.manifest()).dependencies["fixture-dep"]).toMatch(/1\./);
      expect(
        JSON.parse(
          await readFile(
            join(f.project, "node_modules/fixture-dep/package.json"),
            "utf8",
          ),
        ).version,
      ).toBe("1.1.0");
      await f.operate(adapter, {
        operation: "update",
        mode: "latest",
        packages: [{ name: "fixture-dep" }],
      });
      expect(
        JSON.parse(
          await readFile(
            join(f.project, "node_modules/fixture-dep/package.json"),
            "utf8",
          ),
        ).version,
      ).toBe("2.0.0");
      await f.operate(adapter, {
        operation: "update",
        packages: [{ name: "fixture-dep", version: "v1.0.0" }],
      });
      expect((await f.manifest()).dependencies["fixture-dep"]).toBe("1.0.0");
      await rm(join(f.project, "node_modules"), {
        recursive: true,
        force: true,
      });
      const inventory = await adapter.inventory(await f.context(), true);
      expect(inventory.complete).toBe(true);
      expect(
        inventory.dependencies.find((d) => d.name === "fixture-dep")
          ?.resolutions?.[0]?.version,
      ).toBe("1.0.0");
      expect(
        inventory.dependencies.some(
          (d) => d.name === "fixture-child" && !d.direct,
        ),
      ).toBe(true);
      await f.operate(adapter, { operation: "sync", check: true });
      if (manager === "npm") {
        expect(
          await Bun.file(
            join(f.project, "node_modules/fixture-dep/package.json"),
          ).exists(),
        ).toBe(false);
        await f.operate(adapter, { operation: "sync" });
      }
      expect(
        JSON.parse(
          await readFile(
            join(f.project, "node_modules/fixture-dep/package.json"),
            "utf8",
          ),
        ).version,
      ).toBe("1.0.0");
      await f.operate(adapter, {
        operation: "remove",
        group: { kind: "runtime" },
        packages: [{ name: "fixture-dep" }],
      });
      expect(
        (await f.manifest()).dependencies?.["fixture-dep"],
      ).toBeUndefined();
    } finally {
      await f.close();
    }
  }, 60000);
  test(`${manager} native declaration groups preserve unrelated declarations`, async () => {
    const f = await fixture(manager);
    try {
      for (const kind of ["dev"] as const) {
        await f.operate(adapter, {
          operation: "add",
          group: { kind: kind as "dev" | "optional" | "peer" },
          packages: [{ name: "fixture-dep", source: { kind: "registry" } }],
        });
        const before = await adapter.inventory(await f.context(), false);
        expect(
          before.dependencies
            .filter((d) => d.name === "fixture-dep")
            .map((d) => d.group.kind),
        ).toEqual([kind]);
        await f.operate(adapter, {
          operation: "remove",
          group: { kind: kind as "dev" | "optional" | "peer" },
          packages: [{ name: "fixture-dep" }],
        });
      }
      const manifest = await f.manifest();
      manifest.dependencies = { "fixture-dep": "1.0.0" };
      manifest.devDependencies = { "fixture-dep": "1.0.0" };
      await writeFile(
        join(f.project, "package.json"),
        JSON.stringify(manifest),
      );
      await f.operate(adapter, {
        operation: "remove",
        group: { kind: "dev" },
        packages: [{ name: "fixture-dep" }],
      });
      expect((await f.manifest()).dependencies["fixture-dep"]).toBe("1.0.0");
      expect(
        (await f.manifest()).devDependencies?.["fixture-dep"],
      ).toBeUndefined();
    } finally {
      await f.close();
    }
  }, 60000);
  test(`${manager} missing and stale locks fail sync without upgrading`, async () => {
    const f = await fixture(manager);
    try {
      await expect(f.operate(adapter, { operation: "sync" })).rejects.toThrow();
      await f.operate(adapter, {
        operation: "add",
        group: { kind: "runtime" },
        packages: [
          {
            name: "fixture-dep",
            version: "1.0.0",
            source: { kind: "registry" },
          },
        ],
      });
      const manifest = await f.manifest();
      manifest.dependencies["fixture-dep"] = "2.0.0";
      await writeFile(
        join(f.project, "package.json"),
        JSON.stringify(manifest),
      );
      f.publish();
      await expect(
        f.operate(adapter, { operation: "sync", check: true }),
      ).rejects.toThrow();
      await expect(f.operate(adapter, { operation: "sync" })).rejects.toThrow();
      expect((await f.manifest()).dependencies["fixture-dep"]).toBe("2.0.0");
    } finally {
      await f.close();
    }
  }, 60000);
  test(`${manager} local and workspace sources stay local and select one member`, async () => {
    const f = await fixture(manager);
    try {
      const manifest = await f.manifest();
      manifest.workspaces = ["packages/*"];
      await writeFile(
        join(f.project, "package.json"),
        JSON.stringify(manifest),
      );
      if (manager === "pnpm")
        await writeFile(
          join(f.project, "pnpm-workspace.yaml"),
          "packages:\n  - packages/*\n",
        );
      for (const name of ["a", "b"]) {
        await mkdir(join(f.project, "packages", name), { recursive: true });
        await writeFile(
          join(f.project, "packages", name, "package.json"),
          JSON.stringify({ name: `local-${name}`, version: "1.0.0" }),
        );
      }
      const sibling = await readFile(
        join(f.project, "packages/b/package.json"),
        "utf8",
      );
      await f.operate(
        adapter,
        {
          operation: "add",
          group: { kind: "runtime" },
          packages: [
            {
              name: "local-b",
              source: {
                kind: "workspace",
                target_project_id: "javascript:packages/b/package.json",
              },
            },
          ],
        },
        "packages/a",
      );
      expect((await f.manifest("packages/a")).dependencies["local-b"]).toMatch(
        manager === "pnpm" ? /^workspace:/ : /^file:/,
      );
      expect(
        await readFile(join(f.project, "packages/b/package.json"), "utf8"),
      ).toBe(sibling);
      await f.operate(
        adapter,
        {
          operation: "remove",
          group: { kind: "runtime" },
          packages: [{ name: "local-b" }],
        },
        "packages/a",
      );
      await f.operate(
        adapter,
        {
          operation: "add",
          group: { kind: "runtime" },
          packages: [
            { name: "local-b", source: { kind: "path", path: "packages/b" } },
          ],
        },
        "packages/a",
      );
      expect((await f.manifest("packages/a")).dependencies["local-b"]).toMatch(
        /^file:/,
      );
    } finally {
      await f.close();
    }
  }, 60000);
}

export function gitCases(manager: "npm" | "pnpm", adapter: Adapter) {
  test(`${manager} Git branch refresh keeps its source`, async () => {
    const f = await fixture(manager);
    try {
      const source = join(f.project, "git-source");
      await mkdir(source);
      const { runProcess } = await import(
        "../../../../src/dependencies/runner"
      );
      async function git(args: string[]) {
        const r = await runProcess("git", args, {
          cwd: source,
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: join(f.root, "gitconfig"),
            GIT_CONFIG_NOSYSTEM: "1",
          },
        });
        if (r.exit_code) throw new Error(r.stderr);
        return r.stdout.trim();
      }
      await writeFile(
        join(source, "package.json"),
        JSON.stringify({ name: "fixture-git", version: "1.0.0" }),
      );
      await git(["init", "-b", "main"]);
      await git(["add", "package.json"]);
      await git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        "fixture",
      ]);
      await f.operate(adapter, {
        operation: "add",
        group: { kind: "runtime" },
        packages: [
          {
            name: "fixture-git",
            source: { kind: "git", url: `git+file://${source}`, ref: "main" },
          },
        ],
      });
      const spec = (await f.manifest()).dependencies["fixture-git"];
      await writeFile(
        join(source, "package.json"),
        JSON.stringify({ name: "fixture-git", version: "1.1.0" }),
      );
      await git(["add", "package.json"]);
      await git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        "update fixture",
      ]);
      await f.operate(adapter, {
        operation: "update",
        packages: [{ name: "fixture-git" }],
      });
      expect((await f.manifest()).dependencies["fixture-git"]).toBe(spec);
      expect(
        JSON.parse(
          await readFile(
            join(f.project, "node_modules/fixture-git/package.json"),
            "utf8",
          ),
        ).version,
      ).toBe("1.1.0");
    } finally {
      await f.close();
    }
  }, 60000);
}
