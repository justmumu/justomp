import { expect, test } from "bun:test";
import { join } from "node:path";
import { uvAdapter } from "../../../../src/dependencies/adapters/uv";
import { readInventory } from "../../../../src/dependencies/inventory";
import { uvFixture } from "./uv-fixture";

test("uv verifies release normalization from supplied declaration and resolution", async () => {
  const fixture = await uvFixture();
  try {
    const before = await readInventory(fixture.root, fixture.context.project);
    const after = structuredClone(before);
    const current = after.dependencies[0];
    if (!current) throw new Error("Missing supplied dependency");
    current.declared_specifier = "==1.0";
    current.resolutions = [{ version: "1.0.0", evidence: "uv.lock" }];
    await uvAdapter.verify?.(
      fixture.context,
      {
        operation: "update",
        project_id: fixture.context.project.project_id,
        packages: [{ name: "uv-demo", version: "v1.0" }],
      },
      before,
      after,
    );
  } finally {
    fixture.close();
  }
});

test("uv inventory applies inherited sources and only traverses the selected member graph", async () => {
  const f = await uvFixture("");
  try {
    f.write(
      "pyproject.toml",
      `${await f.manifest()}[tool.uv.sources]\nuv-other={workspace=true}\n`,
    );
    Object.assign(f.context.project, {
      project_id: "python:packages/selected/pyproject.toml",
      path: "packages/selected",
      manifest: "packages/selected/pyproject.toml",
      name: "uv-selected",
      workspace: "uv:.",
    });
    f.context.cwd = `${f.root}/packages/selected`;
    f.write(
      "packages/selected/pyproject.toml",
      '[project]\nname="uv-selected"\nversion="1.0.0"\ndependencies=["uv-other"]\n',
    );
    f.write(
      "uv.lock",
      `version=1\nrevision=3\n[[package]]\nname="uv-selected"\nversion="1.0.0"\nsource={editable="packages/selected"}\ndependencies=[{name="uv-other"}]\n[[package]]\nname="uv-other"\nversion="1.0.0"\nsource={editable="packages/other"}\n[[package]]\nname="uv-unrelated"\nversion="1.0.0"\nsource={editable="packages/unrelated"}\ndependencies=[{name="uv-demo"}]\n[[package]]\nname="uv-demo"\nversion="1.0.0"\nsource={registry="https://example.test"}\n`,
    );
    const inventory = await uvAdapter.inventory(f.context, true);
    expect(inventory.complete).toBe(true);
    expect(inventory.dependencies[0]?.source.kind).toBe("workspace");
    expect(inventory.dependencies.map((d) => d.name)).toEqual(["uv-other"]);
  } finally {
    f.close();
  }
});

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
    fixture.write(
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
    fixture.write(join(fixture.root, "uv.lock"), "version=99\npackage=[]\n");
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
    fixture.write(join(fixture.root, "uv.lock"), lock);
    const inventory = await uvAdapter.inventory(fixture.context, true);
    expect(inventory.complete).toBe(true);
    expect(
      inventory.dependencies[0]?.resolutions?.map((r) => r.version),
    ).toEqual(["1.0.0", "1.5.0"]);
    fixture.write(
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
    fixture.write(
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
