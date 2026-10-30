import { expect, spyOn, test } from "bun:test";
import { bunAdapter } from "../../../../src/dependencies/adapters/bun";
import { npmAdapter } from "../../../../src/dependencies/adapters/npm";
import { pnpmAdapter } from "../../../../src/dependencies/adapters/pnpm";
import { yarnClassicAdapter } from "../../../../src/dependencies/adapters/yarn-classic";
import { yarnModernAdapter } from "../../../../src/dependencies/adapters/yarn-modern";
import * as paths from "../../../../src/dependencies/paths";
import { fixture } from "./yarn-bun-fixture";

for (const [name, adapter] of [
  ["npm", npmAdapter],
  ["pnpm", pnpmAdapter],
  ["classic", yarnClassicAdapter],
  ["modern", yarnModernAdapter],
  ["bun", bunAdapter],
] as const)
  test(`${name} workspace names and exact registry updates cannot reinterpret sources`, async () => {
    const f = await fixture({
      dependencies: {
        local: "file:./local",
        git: "git+https://example.test/lib.git#main",
      },
    });
    f.context.manager = name === "classic" || name === "modern" ? "yarn" : name;
    const local = spyOn(paths, "localSource").mockResolvedValue(
      `${f.root}/local`,
    );
    f.write("local/package.json", '{"name":"local"}');
    try {
      await expect(
        adapter.plan(
          f.context,
          {
            operation: "add",
            project_id: f.id,
            group: { kind: "runtime" },
            packages: [
              {
                name: "wrong-name",
                source: {
                  kind: "workspace",
                  target_project_id: "javascript:local/package.json",
                },
              },
            ],
          },
          f.inventory,
        ),
      ).rejects.toMatchObject({ code: "source-name-mismatch" });
      for (const dependency of ["local", "git"])
        await expect(
          adapter.plan(
            f.context,
            {
              operation: "update",
              project_id: f.id,
              packages: [{ name: dependency, version: "2.0.0" }],
            },
            f.inventory,
          ),
        ).rejects.toMatchObject({ code: "unsupported-source-operation" });
    } finally {
      local.mockRestore();
      await f.close();
    }
  });
for (const [name, adapter] of [
  ["classic", yarnClassicAdapter],
  ["modern", yarnModernAdapter],
  ["bun", bunAdapter],
] as const) {
  test(`${name} rejects missing lock before sync`, async () => {
    const f = await fixture();
    try {
      await expect(
        adapter.plan(
          f.context,
          { operation: "sync", project_id: f.id },
          f.inventory,
        ),
      ).rejects.toMatchObject({ code: "lockfile-required" });
    } finally {
      await f.close();
    }
  });
  test(`${name} rejects latest registry updates for local sources`, async () => {
    const f = await fixture({ dependencies: { local: "file:./local" } });
    try {
      await expect(
        adapter.plan(
          f.context,
          {
            operation: "update",
            project_id: f.id,
            mode: "latest",
            packages: [{ name: "local" }],
          },
          f.inventory,
        ),
      ).rejects.toMatchObject({ code: "unsupported-source-operation" });
    } finally {
      await f.close();
    }
  });
}
for (const [name, adapter] of [
  ["classic", yarnClassicAdapter],
  ["modern", yarnModernAdapter],
] as const)
  test(`${name} refuses mutation of duplicate declaration groups`, async () => {
    const f = await fixture({
      dependencies: { foo: "1.0.0" },
      devDependencies: { foo: "1.0.0" },
    });
    try {
      await expect(
        adapter.plan(
          f.context,
          {
            operation: "add",
            project_id: f.id,
            group: { kind: "dev" },
            packages: [
              { name: "foo", version: "2.0.0", source: { kind: "registry" } },
            ],
          },
          f.inventory,
        ),
      ).rejects.toMatchObject({ code: "unsupported-group-operation" });
      await expect(
        adapter.plan(
          f.context,
          {
            operation: "remove",
            project_id: f.id,
            group: { kind: "dev" },
            packages: [{ name: "foo" }],
          },
          f.inventory,
        ),
      ).rejects.toMatchObject({ code: "unsupported-group-operation" });
    } finally {
      await f.close();
    }
  });
test("Classic rejects nonruntime workspace addition", async () => {
  const f = await fixture();
  try {
    await expect(
      yarnClassicAdapter.plan(
        f.context,
        {
          operation: "add",
          project_id: f.id,
          group: { kind: "dev" },
          packages: [
            {
              name: "member",
              source: {
                kind: "workspace",
                target_project_id: "javascript:member/package.json",
              },
            },
          ],
        },
        f.inventory,
      ),
    ).rejects.toMatchObject({ code: "unsupported-group-operation" });
  } finally {
    await f.close();
  }
});
