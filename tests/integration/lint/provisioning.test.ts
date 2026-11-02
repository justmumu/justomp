import { expect, test } from "bun:test";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LintSession, withReadyLintTarget } from "../../../src/lint/coordinator";
import { getPackagingStructure } from "../../../src/packaging/get-structure";
import { fixture } from "./fixture";

test("getter and unprepared check are read-only; empty directories do not resolve versions", async () => {
  const f = await fixture();
  await getPackagingStructure(f.root, { publish: false });
  await expect(readFile(join(f.root, ".justomp/packaging_structure.json"), "utf8")).rejects.toThrow();
  await expect(
    withReadyLintTarget(f.root, "python:a/pyproject.toml", { python: f.adapter }, async () => true),
  ).rejects.toThrow("not ready");
  await expect(readFile(join(f.root, ".justomp/config.json"), "utf8")).rejects.toThrow();
  expect(f.counts()).toEqual({ resolves: 0, prepares: 0 });
  const coordinator = await f.start();
  await coordinator.reconcile();
  await mkdir(join(f.root, "empty"));
  await coordinator.reconcile();
  expect(f.counts().resolves).toBe(1);
});

test("moving a project creates a wave and corrupt state recovers without trusting receipts", async () => {
  const f = await fixture();
  const coordinator = await f.start();
  await coordinator.reconcile();
  await rename(join(f.root, "a"), join(f.root, "moved"));
  expect((await coordinator.reconcile()).complete).toBe(true);
  expect(f.counts().resolves).toBe(2);
  await writeFile(join(f.root, ".justomp/lint_state.json"), "{broken");
  await rm(join(f.root, "moved/installed.json"));
  await expect(
    withReadyLintTarget(f.root, "python:moved/pyproject.toml", { python: f.adapter }, async () => true),
  ).rejects.toThrow("not ready");
  const result = await coordinator.reconcile();
  expect(result.complete).toBe(true);
  expect(result.recovery).toContain("Invalid lint state");
  expect(
    JSON.parse(await readFile(join(f.root, ".justomp/lint_state.json"), "utf8")).projects["python:a/pyproject.toml"],
  ).toBeUndefined();
});

test("unrelated ecosystem policy does not stale Python; unsupported ecosystem failure is isolated", async () => {
  const f = await fixture();
  const coordinator = await f.start();
  await coordinator.reconcile();
  const path = join(f.root, ".justomp/config.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  config.lint.go.golangci.linters.enable = [];
  await writeFile(path, JSON.stringify(config));
  expect(await withReadyLintTarget(f.root, "python:a/pyproject.toml", { python: f.adapter }, async () => true)).toBe(
    true,
  );
  await mkdir(join(f.root, "js"));
  await writeFile(join(f.root, "js/package.json"), '{"name":"js","packageManager":"npm@11.0.0"}');
  const result = await coordinator.reconcile();
  expect(result.complete).toBe(false);
  const projects: Partial<typeof result.projects> = result.projects;
  expect(projects["python:a/pyproject.toml"]?.complete).toBe(true);
  expect(await withReadyLintTarget(f.root, "python:a/pyproject.toml", { python: f.adapter }, async () => true)).toBe(
    true,
  );
});

test("two sessions share a root; switching and releasing one leaves the other active", async () => {
  const f = await fixture(),
    other = await fixture();
  const first = new LintSession({ python: f.adapter }),
    second = new LintSession({ python: f.adapter });
  try {
    const shared = await first.switchRoot(f.root);
    expect(await second.switchRoot(f.root)).toBe(shared);
    await shared.reconcile();
    await first.shutdown();
    expect((await shared.reconcile()).complete).toBe(true);
    await second.switchRoot(other.root);
    await expect(shared.reconcile()).rejects.toThrow("closed");
  } finally {
    await first.shutdown();
    await second.shutdown();
  }
});

test("normal getters publish after an earlier read-only getter and mixed concurrent waiters", async () => {
  const f = await fixture();
  await getPackagingStructure(f.root, { publish: false });
  await getPackagingStructure(f.root);
  expect(JSON.parse(await readFile(join(f.root, ".justomp/packaging_structure.json"), "utf8")).projects).toHaveLength(
    1,
  );
  const second = await fixture();
  await Promise.all([getPackagingStructure(second.root, { publish: false }), getPackagingStructure(second.root)]);
  expect(
    JSON.parse(await readFile(join(second.root, ".justomp/packaging_structure.json"), "utf8")).projects,
  ).toHaveLength(1);
});

test("ambiguous Python manager cannot complete a partial Python wave", async () => {
  const f = await fixture();
  const coordinator = await f.start();
  await coordinator.reconcile();
  await mkdir(join(f.root, "ambiguous"));
  await writeFile(join(f.root, "ambiguous/pyproject.toml"), '[project]\nname="ambiguous"\nversion="1.0.0"\n');
  const result = await coordinator.reconcile();
  expect(result.complete).toBe(false);
  expect(JSON.parse(await readFile(join(f.root, ".justomp/lint_state.json"), "utf8")).waves.python.complete).toBe(
    false,
  );
  await expect(
    withReadyLintTarget(f.root, "python:a/pyproject.toml", { python: f.adapter }, async () => true),
  ).rejects.toThrow("wave");
});
