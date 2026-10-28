import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { uvAdapter } from "../../../../src/dependencies/adapters/uv";
import { readInventory } from "../../../../src/dependencies/inventory";
import { uvFixture } from "../../../fixtures/dependencies/uv/fixture";

test("uv rejects missing lock before locked sync and unsupported groups", async () => {
  const fixture = await uvFixture();
  try {
    const context = fixture.context;
    await expect(
      uvAdapter.plan(
        context,
        { operation: "sync", project_id: context.project.project_id },
        await readInventory(context.root, context.project),
      ),
    ).rejects.toThrow("lock");
    await expect(
      uvAdapter.plan(
        context,
        {
          operation: "add",
          project_id: context.project.project_id,
          group: { kind: "peer" },
          packages: [{ name: "uv-demo", source: { kind: "registry" } }],
        },
        await readInventory(context.root, context.project),
      ),
    ).rejects.toThrow("group");
  } finally {
    await fixture.dispose();
  }
});

test("uv refuses ambiguous occurrences and exact conversion of non-registry sources", async () => {
  const fixture = await uvFixture();
  try {
    await writeFile(
      join(fixture.root, "pyproject.toml"),
      `[project]\nname="uv-app"\nversion="1.0.0"\ndependencies=["uv-demo; python_version < '3.12'", "uv-demo; python_version >= '3.12'"]\n`,
    );
    const inventory = await readInventory(
      fixture.root,
      fixture.context.project,
    );
    await expect(
      uvAdapter.plan(
        fixture.context,
        {
          operation: "update",
          project_id: fixture.context.project.project_id,
          packages: [{ name: "uv-demo" }],
        },
        inventory,
      ),
    ).rejects.toThrow("Select one");
    inventory.dependencies.splice(1);
    const first = inventory.dependencies[0];
    if (!first) throw new Error("Fixture dependency missing");
    first.source = {
      kind: "path",
      specifier: "packages/demo",
    };
    await expect(
      uvAdapter.plan(
        fixture.context,
        {
          operation: "update",
          project_id: fixture.context.project.project_id,
          packages: [{ name: "uv-demo", version: "1.0.0" }],
        },
        inventory,
      ),
    ).rejects.toThrow("source");
  } finally {
    await fixture.dispose();
  }
});

test("uv reports missing or unsupported lock graphs as incomplete", async () => {
  const fixture = await uvFixture();
  try {
    expect((await uvAdapter.inventory(fixture.context, true)).complete).toBe(
      false,
    );
    await writeFile(join(fixture.root, "uv.lock"), "version=99\npackage=[]\n");
    expect((await uvAdapter.inventory(fixture.context, true)).complete).toBe(
      false,
    );
  } finally {
    await fixture.dispose();
  }
});

test("uv lock inventory retains alternate marker resolutions and rejects broken edges", async () => {
  const fixture = await uvFixture();
  try {
    const lock = `version=1\nrevision=3\n[[package]]\nname="uv-app"\nversion="1.0.0"\nsource={virtual="."}\ndependencies=[{name="uv-demo",version="1.0.0",marker="python_full_version < '3.12'"},{name="uv-demo",version="1.5.0",marker="python_full_version >= '3.12'"}]\n[[package]]\nname="uv-demo"\nversion="1.0.0"\nsource={registry="https://example.invalid/simple"}\n[[package]]\nname="uv-demo"\nversion="1.5.0"\nsource={registry="https://example.invalid/simple"}\n`;
    await writeFile(join(fixture.root, "uv.lock"), lock);
    const inventory = await uvAdapter.inventory(fixture.context, true);
    expect(inventory.complete).toBe(true);
    expect(
      inventory.dependencies[0]?.resolutions?.map((r) => r.version),
    ).toEqual(["1.0.0", "1.5.0"]);
    await writeFile(
      join(fixture.root, "uv.lock"),
      lock.replace('version="1.5.0",marker', 'version="9.0.0",marker'),
    );
    expect((await uvAdapter.inventory(fixture.context, true)).complete).toBe(
      false,
    );
  } finally {
    await fixture.dispose();
  }
});

test("uv rejects a registry add shadowed by an undeclared native source", async () => {
  const fixture = await uvFixture("");
  try {
    await writeFile(
      join(fixture.root, "pyproject.toml"),
      (await fixture.manifest()) +
        '\n[tool.uv.sources]\nuv-demo={path="packages/demo"}\n',
    );
    const before = await readInventory(fixture.root, fixture.context.project);
    await expect(
      uvAdapter.plan(
        fixture.context,
        {
          operation: "add",
          project_id: fixture.context.project.project_id,
          group: { kind: "runtime" },
          packages: [{ name: "uv-demo", source: { kind: "registry" } }],
        },
        before,
      ),
    ).rejects.toThrow("source");
  } finally {
    await fixture.dispose();
  }
});

test("uv reserves the dev selector for the native dev group", async () => {
  const fixture = await uvFixture("");
  try {
    await expect(
      uvAdapter.plan(
        fixture.context,
        {
          operation: "add",
          project_id: fixture.context.project.project_id,
          group: { kind: "named", name: "dev" },
          packages: [{ name: "uv-demo", source: { kind: "registry" } }],
        },
        await readInventory(fixture.root, fixture.context.project),
      ),
    ).rejects.toThrow("dev");
  } finally {
    await fixture.dispose();
  }
});
