import { expect, test } from "bun:test";
import { bunAdapter } from "../../../../src/dependencies/adapters/bun";

test("Bun exposes only native JS declaration groups", () => {
  expect(bunAdapter.groups).toEqual(["runtime", "dev", "optional", "peer"]);
});

import { fixture } from "./yarn-bun-fixture";

test("Bun remove plans native group deletion followed by installation", async () => {
  const f = await fixture({
    dependencies: { foo: "1.0.0" },
    devDependencies: { foo: "2.0.0" },
  });
  try {
    const plan = await bunAdapter.plan(
      f.context,
      {
        operation: "remove",
        project_id: f.id,
        group: { kind: "dev" },
        packages: [{ name: "foo" }],
      },
      f.inventory,
    );
    expect(plan.steps.map((step) => step.args)).toEqual([["pm", "pkg", "delete", "devDependencies.foo"], ["install"]]);
    expect(plan.metadata).toContain("bun.lockb");
    const before = await f.text();
    await expect(
      bunAdapter.plan(
        f.context,
        {
          operation: "add",
          project_id: f.id,
          group: { kind: "dev" },
          packages: [{ name: "foo", source: { kind: "registry" } }],
        },
        f.inventory,
      ),
    ).rejects.toMatchObject({ code: "unsupported-group-operation" });
    expect(await f.text()).toBe(before);
  } finally {
    await f.close();
  }
});

test("Bun dotted duplicate names reject unsupported native field deletion before writes", async () => {
  const f = await fixture({
    dependencies: { "foo.bar": "1.0.0" },
    devDependencies: { "foo.bar": "2.0.0" },
  });
  try {
    await expect(
      bunAdapter.plan(
        f.context,
        {
          operation: "remove",
          project_id: f.id,
          group: { kind: "dev" },
          packages: [{ name: "foo.bar" }],
        },
        f.inventory,
      ),
    ).rejects.toMatchObject({ code: "unsupported-group-operation" });
  } finally {
    await f.close();
  }
});
