import { expect, test } from "bun:test";
import { pnpmAdapter } from "../../../../src/dependencies/adapters/pnpm";
import { context, inventory } from "./npm-pnpm-fixture";

test("pnpm peer add rejects the native extra dev declaration before spawning", async () => {
  const ctx = context("pnpm");
  await expect(
    pnpmAdapter.plan(
      ctx,
      {
        operation: "add",
        project_id: ctx.project.project_id,
        group: { kind: "peer" },
        packages: [{ name: "fixture-dep", source: { kind: "registry" } }],
      },
      inventory(),
    ),
  ).rejects.toMatchObject({ code: "unsupported-group-operation" });
});
test("pnpm group remove rejects native peer co-removal", async () => {
  const ctx = context("pnpm");
  await expect(
    pnpmAdapter.plan(
      ctx,
      {
        operation: "remove",
        project_id: ctx.project.project_id,
        group: { kind: "dev" },
        packages: [{ name: "fixture-dep" }],
      },
      inventory("dev", "peer"),
    ),
  ).rejects.toMatchObject({ code: "unsupported-group-operation" });
});
test("pnpm catalog selector updates do not overwrite shared catalog ownership", async () => {
  const ctx = context("pnpm"),
    before = inventory("runtime");
  if (!before.dependencies[0]) throw new Error("Missing fixture dependency");
  before.dependencies[0].source = { kind: "unknown", specifier: "catalog:" };
  before.dependencies[0].declared_specifier = "catalog:";
  await expect(
    pnpmAdapter.plan(
      ctx,
      {
        operation: "update",
        project_id: ctx.project.project_id,
        mode: "latest",
        packages: [{ name: "fixture-dep" }],
      },
      before,
    ),
  ).rejects.toMatchObject({ code: "unsupported-source-operation" });
});
test("pnpm exact updates retain group and shared-lock metadata", async () => {
  const ctx = context("pnpm"),
    plan = await pnpmAdapter.plan(
      ctx,
      {
        operation: "update",
        project_id: ctx.project.project_id,
        packages: [
          { name: "fixture-dep", version: "1.0.0", group: { kind: "dev" } },
        ],
      },
      inventory("dev"),
    );
  expect(plan.steps.map((s) => s.args)).toEqual([
    ["remove", "fixture-dep", "--save-dev"],
    ["add", "fixture-dep@1.0.0", "--save-dev", "--save-exact"],
  ]);
  expect(plan.metadata).toEqual(
    expect.arrayContaining([
      "packages/a/package.json",
      "packages/b/package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
    ]),
  );
});
test("pnpm postcondition rejects a native caret when an exact downgrade was requested", async () => {
  const ctx = context("pnpm"),
    before = inventory("runtime"),
    after = inventory("runtime");
  await expect(
    Promise.resolve().then(() => {
      if (!pnpmAdapter.verify) throw new Error("missing postcondition");
      return pnpmAdapter.verify(
        ctx,
        {
          operation: "update",
          project_id: ctx.project.project_id,
          packages: [{ name: "fixture-dep", version: "1.0.0" }],
        },
        before,
        after,
      );
    }),
  ).rejects.toMatchObject({ code: "postcondition-failed" });
});
test("pnpm local-source refresh does not bypass peer group capability", async () => {
  const ctx = context("pnpm"),
    before = inventory("peer");
  const dependency = before.dependencies[0];
  if (!dependency) throw new Error("Missing fixture dependency");
  dependency.source = { kind: "path" };
  dependency.declared_specifier = "file:../local";
  await expect(
    pnpmAdapter.plan(
      ctx,
      {
        operation: "update",
        project_id: ctx.project.project_id,
        packages: [{ name: "fixture-dep" }],
      },
      before,
    ),
  ).rejects.toMatchObject({ code: "unsupported-group-operation" });
});
