import { expect, test } from "bun:test";
import { npmAdapter } from "../../../../src/dependencies/adapters/npm";
import { context, inventory } from "./npm-pnpm-fixture";

test("npm rejects add that would move another group's declaration", async () => {
  const ctx = context("npm");
  await expect(
    npmAdapter.plan(
      ctx,
      {
        operation: "add",
        project_id: ctx.project.project_id,
        group: { kind: "dev" },
        packages: [{ name: "fixture-dep", source: { kind: "registry" } }],
      },
      inventory("runtime"),
    ),
  ).rejects.toMatchObject({ code: "unsupported-group-operation" });
});
test("npm ambiguous update and missing direct targets fail before native work", async () => {
  const ctx = context("npm");
  for (const before of [inventory("runtime", "dev"), inventory()])
    await expect(
      npmAdapter.plan(
        ctx,
        {
          operation: "update",
          project_id: ctx.project.project_id,
          packages: [{ name: "fixture-dep", version: "1.0.0" }],
        },
        before,
      ),
    ).rejects.toThrow();
});
test("npm group removal covers shared metadata and reports all lock owners", async () => {
  const ctx = context("npm"),
    plan = await npmAdapter.plan(
      ctx,
      {
        operation: "remove",
        project_id: ctx.project.project_id,
        group: { kind: "dev" },
        packages: [{ name: "fixture-dep" }],
      },
      inventory("runtime", "dev"),
    );
  expect(plan.steps[0]?.args).toEqual([
    "pkg",
    "delete",
    "devDependencies[fixture-dep]",
    "--workspace",
    "packages/a",
  ]);
  expect(plan.steps[1]?.args).toEqual(["install", "--workspace", "packages/a"]);
  expect(plan.metadata).toEqual(
    expect.arrayContaining([
      "packages/a/package.json",
      "packages/b/package.json",
      "package-lock.json",
      "npm-shrinkwrap.json",
      ".npmrc",
    ]),
  );
  expect(plan.affectedProjects).toEqual([
    "javascript:packages/a/package.json",
    "javascript:packages/b/package.json",
  ]);
});
test("npm rejects exact replacement of a Git selector before native work", async () => {
  const ctx = context("npm"),
    before = inventory("runtime");
  if (!before.dependencies[0]) throw new Error("Missing fixture dependency");
  before.dependencies[0].source = { kind: "git" };
  await expect(
    npmAdapter.plan(
      ctx,
      {
        operation: "update",
        project_id: ctx.project.project_id,
        packages: [{ name: "fixture-dep", version: "1.0.0" }],
      },
      before,
    ),
  ).rejects.toMatchObject({ code: "unsupported-source-operation" });
});
test("npm postcondition detects an unintended other-group declaration change", async () => {
  const ctx = context("npm"),
    before = inventory("runtime", "dev"),
    after = inventory("runtime");
  if (!after.dependencies[0]) throw new Error("Missing fixture dependency");
  after.dependencies[0].declared_specifier = "^2.0.0";
  await expect(
    Promise.resolve().then(() => {
      if (!npmAdapter.verify) throw new Error("missing postcondition");
      return npmAdapter.verify(
        ctx,
        {
          operation: "remove",
          project_id: ctx.project.project_id,
          group: { kind: "dev" },
          packages: [{ name: "fixture-dep" }],
        },
        before,
        after,
      );
    }),
  ).rejects.toMatchObject({ code: "postcondition-failed" });
});
