import { afterEach, expect, spyOn, test } from "bun:test";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { closePackagingStructure } from "../../../src/packaging/get-structure";
import { pythonAdapter } from "../../../src/typecheck/adapters/python";
import {
  checkProjectTypecheck,
  prepareProjectTypecheck,
  typecheckProject,
} from "../../../src/typecheck/index";
import { VERSION } from "../../fixtures/typecheck/python/fixture";
import { cleanup, fixture, id, registry } from "./service-fixture";

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
test("native selected prepare then readonly checks report current diagnostics, no sources and late mutation", async () => {
  const f = await fixture(),
    network = registry();
  try {
    const prepared = await prepareProjectTypecheck(f.root, id);
    expect(prepared.complete, JSON.stringify(prepared)).toBe(true);
    expect(prepared.tools).toEqual({ pyright: VERSION });
    expect(prepared).not.toHaveProperty("projects");
  } finally {
    network.mockRestore();
  }
  const before = await f.bytes();
  const paths = [
    ".justomp/config.json",
    ".justomp/typecheck_state.json",
    ".justomp/packaging_structure.json",
  ];
  const bytes = () =>
    Promise.all(
      paths.map((path) =>
        Bun.file(join(f.root, path))
          .exists()
          .then((exists) =>
            exists ? readFile(join(f.root, path), "utf8") : null,
          ),
      ),
    );
  const metadata = await bytes();
  expect((await checkProjectTypecheck(f.root, id)).success).toBe(true);
  expect(await f.bytes()).toEqual(before);
  expect(await bytes()).toEqual(metadata);
  await writeFile(join(f.root, "module.py"), 'answer: int = "bad"\n');
  const failed = await checkProjectTypecheck(f.root, id);
  expect(failed.complete).toBe(true);
  expect(failed.success).toBe(false);
  expect(
    failed.diagnostics.some((d) => d.rule === "reportAssignmentType"),
  ).toBe(true);
  const actual = pythonAdapter.check.bind(pythonAdapter);
  const mutated = spyOn(pythonAdapter, "check").mockImplementation(
    async (ctx) => {
      const checks = await actual(ctx);
      await writeFile(join(f.root, "module.py"), "answer: int = 1\n");
      return checks;
    },
  );
  try {
    const result = await checkProjectTypecheck(f.root, id);
    expect(result.complete).toBe(false);
    expect(result.diagnostics, JSON.stringify(result)).toEqual(
      failed.diagnostics,
    );
    expect(result.incomplete_stages).toContain("verification");
  } finally {
    mutated.mockRestore();
  }
  expect((await checkProjectTypecheck(f.root, id)).success).toBe(true);
  await unlink(join(f.root, "module.py"));
  const empty = await typecheckProject(f.root, id);
  expect(empty.complete).toBe(true);
  expect(empty.success).toBe(false);
  expect(empty.checks[0]?.status).toBe("no-sources");
}, 30000);
test("shared Python workspace source changes invalidate the selected check without checking sibling projects", async () => {
  const f = await fixture(true),
    network = registry(),
    selected = "python:packages/a/pyproject.toml";
  try {
    expect((await prepareProjectTypecheck(f.root, selected)).complete).toBe(
      true,
    );
  } finally {
    network.mockRestore();
  }
  await writeFile(
    join(f.root, "packages/a/module.py"),
    'answer: int = "bad"\n',
  );
  const actual = pythonAdapter.check.bind(pythonAdapter),
    visited: string[] = [];
  const checking = spyOn(pythonAdapter, "check").mockImplementation(
    async (context) => {
      visited.push(context.target.project.project_id);
      const checks = await actual(context);
      await writeFile(
        join(f.root, "packages/b/module.py"),
        "answer: int = 2\n",
      );
      return checks;
    },
  );
  try {
    const result = await checkProjectTypecheck(f.root, selected);
    expect(result.complete, JSON.stringify(result)).toBe(false);
    expect(result.incomplete_stages).toContain("verification");
    expect(
      result.diagnostics.some((d) => d.rule === "reportAssignmentType"),
    ).toBe(true);
    expect(visited).toEqual([selected]);
  } finally {
    checking.mockRestore();
  }
}, 30000);
test("public Go full and readonly operations compile source and tests without running them", async () => {
  const { goFixture } = await import("../../fixtures/typecheck/go/fixture");
  const f = await goFixture();
  cleanup.push(async () => {
    await closePackagingStructure(f.root);
    await f.dispose();
  });
  await writeFile(
    join(f.root, "main_test.go"),
    'package main\nimport "testing"\nfunc TestNeverRun(t *testing.T) { panic("typecheck executed test") }\n',
  );
  const first = await typecheckProject(f.root, "go:go.mod");
  expect(first.success, JSON.stringify(first)).toBe(true);
  expect(first.preparation.tools.go).toBeTruthy();
  await writeFile(
    join(f.root, "main_test.go"),
    'package main\nimport "testing"\nfunc TestNeverRun(t *testing.T) { var bad int = "wrong"; _ = bad }\n',
  );
  const result = await checkProjectTypecheck(f.root, "go:go.mod");
  expect(result.complete, JSON.stringify(result)).toBe(true);
  expect(result.success).toBe(false);
  expect(
    result.diagnostics.some((d) => d.project_path === "main_test.go"),
  ).toBe(true);
}, 30000);
