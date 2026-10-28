import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bunAdapter } from "../../../../src/dependencies/adapters/bun";
import { yarnClassicAdapter } from "../../../../src/dependencies/adapters/yarn-classic";
import { yarnModernAdapter } from "../../../../src/dependencies/adapters/yarn-modern";
import { fixture, gitSource } from "./yarn-bun-fixture";

for (const [variant, adapter] of [
  ["classic", yarnClassicAdapter],
  ["modern", yarnModernAdapter],
  ["bun", bunAdapter],
] as const) {
  if (variant !== "classic")
    test(`${variant}: native root resolution cannot satisfy a conflicting exact update`, async () => {
      const f = await fixture(variant);
      try {
        const manifest = await f.manifest();
        manifest.dependencies = { "u6-dep": "1.0.0" };
        manifest.resolutions = { "u6-dep": "1.0.0" };
        await writeFile(join(f.root, "package.json"), JSON.stringify(manifest));
        const ctx = await f.context();
        expect(
          (
            await ctx.run({
              args: ["install"],
              label: "Install override fixture",
            })
          ).exit_code,
        ).toBe(0);
        f.publish("2.0.0");
        await expect(
          f.operate(adapter, {
            operation: "update",
            packages: [{ name: "u6-dep", version: "2.0.0" }],
          }),
        ).rejects.toMatchObject({ code: "postcondition-failed" });
        expect((await f.manifest()).dependencies["u6-dep"]).toBe("2.0.0");
        expect(await f.installed("u6-dep")).toBe("1.0.0");
        const lockPath = join(
          f.root,
          variant === "bun" ? "bun.lock" : "yarn.lock",
        );
        const lock = await readFile(lockPath, "utf8");
        const inventory = await adapter.inventory(await f.context(), false);
        expect(
          inventory.dependencies
            .find((d) => d.name === "u6-dep")
            ?.resolutions?.map((r) => r.version),
        ).toEqual(["1.0.0"]);
        expect(inventory.dependencies.every((d) => d.direct)).toBe(true);
        expect(await readFile(lockPath, "utf8")).toBe(lock);
      } finally {
        await f.close();
      }
    }, 60000);

  test(`${variant}: native v-prefixed exact update succeeds with normalized resolution`, async () => {
    const f = await fixture(variant);
    try {
      f.publish("2.0.0");
      await f.operate(adapter, {
        operation: "add",
        group: { kind: "runtime" },
        packages: [
          { name: "u6-dep", version: "1.0.0", source: { kind: "registry" } },
        ],
      });
      f.publish("2.0.0");
      await f.operate(adapter, {
        operation: "update",
        packages: [{ name: "u6-dep", version: "v1.1.0" }],
      });
      expect(await f.installed("u6-dep")).toBe("1.1.0");
    } finally {
      await f.close();
    }
  }, 60000);
}

test("modern Yarn mixed native update keeps default registry constraints and Git/local sources", async () => {
  const f = await fixture("modern", true);
  const git = await gitSource(f.root);
  try {
    await mkdir(join(f.root, "local"));
    await writeFile(
      join(f.root, "local/package.json"),
      JSON.stringify({ name: "u6-local", version: "1.0.0" }),
    );
    await f.operate(yarnModernAdapter, {
      operation: "add",
      group: { kind: "runtime" },
      packages: [
        { name: "u6-dep", version: "^1.0.0", source: { kind: "registry" } },
        { name: "u6-other", version: "^1.0.0", source: { kind: "registry" } },
        { name: "u6-local", source: { kind: "path", path: "local" } },
        { name: "u6-git", source: { kind: "git", url: git.url, ref: "main" } },
      ],
    });
    const before = (await f.manifest()).dependencies;
    f.publish("2.0.0");
    await f.operate(yarnModernAdapter, {
      operation: "update",
      packages: [
        { name: "u6-dep", version: "2.0.0" },
        { name: "u6-other" },
        { name: "u6-local" },
        { name: "u6-git" },
      ],
    });
    const after = (await f.manifest()).dependencies;
    expect(after).toEqual({ ...before, "u6-dep": "2.0.0" });
    expect(await f.installed("u6-other")).toBe("1.1.0");
    expect(await f.installed("u6-dep")).toBe("2.0.0");
  } finally {
    await git.close();
    await f.close();
  }
}, 60000);
