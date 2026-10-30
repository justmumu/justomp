import { expect, test } from "bun:test";
import { join } from "node:path";
import { bunAdapter } from "../../../../src/dependencies/adapters/bun";
import { verifyJs } from "../../../../src/dependencies/adapters/js-common";
import { yarnClassicAdapter } from "../../../../src/dependencies/adapters/yarn-classic";
import { yarnModernAdapter } from "../../../../src/dependencies/adapters/yarn-modern";
import { fixture } from "./yarn-bun-fixture";

test("mixed modern Yarn updates preserve default constraints and local/Git selectors", async () => {
  const f = await fixture({
    dependencies: {
      exact: "^1.0.0",
      within: "^1.0.0",
      local: "file:./local",
      git: "git+https://example.test/repo.git#main",
    },
  });
  try {
    const plan = await yarnModernAdapter.plan(
      f.context,
      {
        operation: "update",
        project_id: f.id,
        packages: [
          { name: "exact", version: "2.0.0" },
          { name: "within" },
          { name: "local" },
          { name: "git" },
        ],
      },
      f.inventory,
    );
    expect(plan.steps.map((step) => step.args)).toEqual([
      ["add", "exact@2.0.0", "--exact"],
      ["up", "-R", "within", "local", "git"],
    ]);
    expect(plan.steps[1]?.cwd).toBe(f.context.owner);
  } finally {
    await f.close();
  }
});

for (const [name, verify] of [
  ["npm/pnpm", verifyJs],
  ["Yarn Classic", yarnClassicAdapter.verify],
  ["Yarn modern", yarnModernAdapter.verify],
  ["Bun", bunAdapter.verify],
] as const) {
  test(`${name} accepts normalized v-prefixed exact versions`, async () => {
    const f = await fixture({ dependencies: { foo: "^2.0.0" } });
    try {
      const after = structuredClone(f.inventory);
      const dependency = after.dependencies[0];
      if (!dependency) throw new Error("Missing fixture dependency");
      dependency.declared_specifier = "1.2.3";
      dependency.resolutions = [{ version: "1.2.3", evidence: "native lock" }];
      await verify?.(
        f.context,
        {
          operation: "update",
          project_id: f.id,
          packages: [{ name: "foo", version: "v1.2.3" }],
        },
        f.inventory,
        after,
      );
    } finally {
      await f.close();
    }
  });
}

for (const [name, adapter] of [
  ["Yarn Classic", yarnClassicAdapter],
  ["Yarn modern", yarnModernAdapter],
  ["Bun", bunAdapter],
] as const) {
  test(`${name} rejects exact pins with conflicting or absent effective resolution`, async () => {
    const f = await fixture({ dependencies: { foo: "^1.0.0" } });
    try {
      const after = structuredClone(f.inventory);
      const dependency = after.dependencies[0];
      if (!dependency) throw new Error("Missing fixture dependency");
      dependency.declared_specifier = "2.0.0";
      for (const resolutions of [
        undefined,
        [{ version: "1.0.0", evidence: "native lock" }],
      ]) {
        dependency.resolutions = resolutions;
        await expect(
          adapter.verify?.(
            f.context,
            {
              operation: "update",
              project_id: f.id,
              packages: [{ name: "foo", version: "2.0.0" }],
            },
            f.inventory,
            after,
          ),
        ).rejects.toMatchObject({ code: "postcondition-failed" });
      }
    } finally {
      await f.close();
    }
  });
}

test("direct Bun resolution excludes another version reachable through a child", async () => {
  const f = await fixture({ dependencies: { foo: "2.0.0", parent: "1.0.0" } });
  try {
    f.write(
      join(f.root, "bun.lock"),
      JSON.stringify({
        lockfileVersion: 1,
        workspaces: {
          "": { name: "app", dependencies: { foo: "2.0.0", parent: "1.0.0" } },
        },
        packages: {
          foo: ["foo@1.0.0", "", {}],
          parent: ["parent@1.0.0", "", { dependencies: { foo: "2.0.0" } }],
          "parent/foo": ["foo@2.0.0", "", {}],
        },
      }),
    );
    for (const transitive of [false, true]) {
      const inventory = await bunAdapter.inventory(f.context, transitive);
      expect(
        inventory.dependencies.find((d) => d.direct && d.name === "foo")
          ?.resolutions,
      ).toEqual([{ version: "1.0.0", evidence: "bun.lock" }]);
      if (transitive)
        expect(
          inventory.dependencies.find((d) => !d.direct && d.name === "foo")
            ?.resolutions,
        ).toEqual([{ version: "2.0.0", evidence: "bun.lock" }]);
    }
  } finally {
    await f.close();
  }
});
