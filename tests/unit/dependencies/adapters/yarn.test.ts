import { expect, test } from "bun:test";
import { yarnClassicAdapter } from "../../../../src/dependencies/adapters/yarn-classic";
import { yarnModernAdapter } from "../../../../src/dependencies/adapters/yarn-modern";

test("Yarn variants expose the native JS groups independently", () => {
  expect(yarnClassicAdapter).not.toBe(yarnModernAdapter);
  expect(yarnClassicAdapter.groups).toEqual([
    "runtime",
    "dev",
    "optional",
    "peer",
  ]);
  expect(yarnModernAdapter.groups).toEqual(yarnClassicAdapter.groups);
});

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./yarn-bun-fixture";

test("modern within constraints uses shared resolution-only update even for duplicate groups", async () => {
  const f = await fixture({
    dependencies: { foo: "^1.0.0" },
    devDependencies: { foo: "^2.0.0" },
  });
  try {
    const plan = await yarnModernAdapter.plan(
      f.context,
      {
        operation: "update",
        project_id: f.id,
        packages: [{ name: "foo", group: { kind: "dev" } }],
      },
      f.inventory,
    );
    expect(plan.steps[0]?.args).toEqual(["up", "-R", "foo"]);
    await expect(
      yarnClassicAdapter.plan(
        f.context,
        {
          operation: "update",
          project_id: f.id,
          packages: [{ name: "foo", group: { kind: "dev" } }],
        },
        f.inventory,
      ),
    ).rejects.toMatchObject({ code: "unsupported-group-operation" });
  } finally {
    await f.close();
  }
});

test("exact pins use group-local add and source-changing updates reject before native execution", async () => {
  const f = await fixture({
    devDependencies: { foo: "^2.0.0", local: "file:./local" },
  });
  try {
    for (const adapter of [yarnClassicAdapter, yarnModernAdapter]) {
      const plan = await adapter.plan(
        f.context,
        {
          operation: "update",
          project_id: f.id,
          packages: [{ name: "foo", version: "1.0.0" }],
        },
        f.inventory,
      );
      expect(plan.steps[0]?.args).toEqual([
        "add",
        "foo@1.0.0",
        "--exact",
        "--dev",
      ]);
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
    }
  } finally {
    await f.close();
  }
});

test("malformed or truncated Yarn graphs cannot masquerade as complete inventories", async () => {
  const f = await fixture({ dependencies: { foo: "^1.0.0" } });
  try {
    await writeFile(join(f.root, "yarn.lock"), "fixture");
    for (const adapter of [yarnClassicAdapter, yarnModernAdapter]) {
      f.context.run = async () => ({
        exit_code: 0,
        signal: null,
        stdout: '{"unexpected":true}',
        stderr: "",
        cancelled: false,
        truncated: false,
      });
      const result = await adapter.inventory(f.context, true);
      expect(result.complete).toBe(false);
      expect(result.diagnostics[0]?.code).toBe("resolution-unavailable");
      f.context.run = async () => ({
        exit_code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        cancelled: false,
        truncated: true,
      });
      expect((await adapter.inventory(f.context, true)).complete).toBe(false);
    }
  } finally {
    await f.close();
  }
});

test("Classic rejects nonruntime workspace updates before its native group coercion", async () => {
  const f = await fixture({ devDependencies: { foo: "1.0.0" } });
  try {
    f.context.project.workspace = "workspace";
    f.context.structure.projects.push({
      ...f.context.project,
      name: "foo",
      path: "packages/foo",
      manifest: "packages/foo/package.json",
      project_id: "javascript:packages/foo/package.json",
    });
    await expect(
      yarnClassicAdapter.plan(
        f.context,
        {
          operation: "update",
          project_id: f.id,
          packages: [{ name: "foo", version: "2.0.0" }],
        },
        f.inventory,
      ),
    ).rejects.toMatchObject({ code: "unsupported-group-operation" });
  } finally {
    await f.close();
  }
});
