import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getPackagingStructure } from "../../../src/packaging/get-structure";
import { TypecheckSession, withReadyTypecheckTarget } from "../../../src/typecheck/coordinator";
import { fixture } from "./fixture";

test("getter and unprepared check are read-only; empty directories do not resolve versions", async () => {
  const f = await fixture();
  await getPackagingStructure(f.root, { publish: false });
  await expect(readFile(join(f.root, ".justomp/packaging_structure.json"), "utf8")).rejects.toThrow();
  await expect(
    withReadyTypecheckTarget(f.root, "python:a/pyproject.toml", { python: f.adapter }, async () => true),
  ).rejects.toThrow("not ready");
  await expect(readFile(join(f.root, ".justomp/config.json"), "utf8")).rejects.toThrow();
  expect(f.counts()).toEqual({ resolves: 0, prepares: 0 });
  const coordinator = await f.start();
  await coordinator.reconcile();
  await mkdir(join(f.root, "empty"));
  await coordinator.reconcile();
  expect(f.counts().resolves).toBe(1);
});

test("unrelated ecosystem policy does not stale Python; unsupported ecosystem failure is isolated", async () => {
  const f = await fixture();
  const coordinator = await f.start();
  await coordinator.reconcile();
  const path = join(f.root, ".justomp/config.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  config.typecheck.go.build_tags = ["custom"];
  await writeFile(path, JSON.stringify(config));
  expect(
    await withReadyTypecheckTarget(f.root, "python:a/pyproject.toml", { python: f.adapter }, async () => true),
  ).toBe(true);
  await mkdir(join(f.root, "js"));
  await writeFile(join(f.root, "js/package.json"), '{"name":"js","packageManager":"npm@11.0.0"}');
  const result = await coordinator.reconcile();
  expect(result.complete).toBe(false);
  expect(result.projects["python:a/pyproject.toml"]?.complete).toBe(true);
  expect(
    await withReadyTypecheckTarget(f.root, "python:a/pyproject.toml", { python: f.adapter }, async () => true),
  ).toBe(true);
});

test("two sessions share a root; switching and releasing one leaves the other active", async () => {
  const f = await fixture(),
    other = await fixture();
  const first = new TypecheckSession({ python: f.adapter }),
    second = new TypecheckSession({ python: f.adapter });
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
