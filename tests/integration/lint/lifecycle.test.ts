import { expect, test } from "bun:test";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withReadyLintTarget } from "../../../src/lint/coordinator";
import { fixture } from "./fixture";

test("startup, self-writes, restart and new Python discovery resolve once per wave", async () => {
  const f = await fixture();
  const first = await f.start();
  expect(await first.reconcile()).toMatchObject({ complete: true });
  expect(f.counts().resolves).toBe(1);
  await first.reconcile();
  expect(f.counts()).toEqual({ resolves: 1, prepares: 1 });
  await first.shutdown();
  const reopened = await f.start();
  expect((await reopened.reconcile()).complete).toBe(true);
  expect(f.counts().resolves).toBe(1);
  f.latest("2.0.0");
  await f.add("b");
  expect((await reopened.reconcile()).complete).toBe(true);
  expect(f.counts().resolves).toBe(2);
  for (const name of ["a", "b"]) {
    expect(JSON.parse(await readFile(join(f.root, name, "installed.json"), "utf8"))).toEqual({ ruff: "2.0.0" });
  }
});
test("failed wave retains resolved target and blocks even an already verified project", async () => {
  const f = await fixture();
  const coordinator = await f.start();
  await coordinator.reconcile();
  await f.add("b");
  f.latest("2.0.0");
  f.fail("b");
  const failed = await coordinator.reconcile();
  expect(failed.complete).toBe(false);
  expect(failed.changes.length).toBeGreaterThan(0);
  await expect(
    withReadyLintTarget(f.root, "python:a/pyproject.toml", { python: f.adapter }, async () => true),
  ).rejects.toThrow("wave");
  f.fail("");
  f.latest("3.0.0");
  expect((await coordinator.reconcile()).complete).toBe(true);
  expect(f.counts().resolves).toBe(2);
  expect(JSON.parse(await readFile(join(f.root, "b/installed.json"), "utf8"))).toEqual({ ruff: "2.0.0" });
});
test("policy changes and damaged environment repair without latest, deleted projects disappear", async () => {
  const f = await fixture();
  const coordinator = await f.start();
  await coordinator.reconcile();
  const installed = join(f.root, "a/installed.json");
  const installedBefore = await stat(installed);
  const path = join(f.root, ".justomp/config.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  config.lint.python.ruff["line-length"] = 100;
  await writeFile(path, JSON.stringify(config));
  expect((await coordinator.reconcile()).complete).toBe(true);
  expect(await readFile(join(f.root, "a/pyproject.toml"), "utf8")).toContain("100");
  expect((await stat(installed)).mtimeMs).toBe(installedBefore.mtimeMs);
  await rm(join(f.root, "a/installed.json"));
  await expect(
    withReadyLintTarget(f.root, "python:a/pyproject.toml", { python: f.adapter }, async () => true),
  ).rejects.toThrow("ready");
  expect((await coordinator.reconcile()).complete).toBe(true);
  expect(f.counts().resolves).toBe(1);
  await rm(join(f.root, "a"), { recursive: true });
  expect((await coordinator.reconcile()).complete).toBe(true);
  expect(JSON.parse(await readFile(join(f.root, ".justomp/lint_state.json"), "utf8")).projects).toEqual({});
});

test("exact config watcher reports policy repair without another tool call or latest loop", async () => {
  const f = await fixture();
  const coordinator = await f.start();
  await coordinator.reconcile();
  let repaired = false;
  const unsubscribe = coordinator.subscribe((report) => {
    if (report.complete && report.changes.some((change) => change.path === "a/pyproject.toml")) {
      repaired = true;
    }
  });
  // Let the native watcher finish registration, then test notification independently of getter calls.
  await new Promise((resolve) => setTimeout(resolve, 25));
  repaired = false;
  const path = join(f.root, ".justomp/config.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  config.lint.python.ruff["line-length"] = 102;
  await writeFile(path, JSON.stringify(config));
  for (let attempt = 0; attempt < 100 && !repaired; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  unsubscribe();
  expect(repaired).toBe(true);
  expect(await readFile(join(f.root, "a/pyproject.toml"), "utf8")).toContain("102");
  expect(f.counts().resolves).toBe(1);
});

// Real inspection -> durable target publication -> native-adapter handoff, with no tool installs.
test("JS and Go discovery persists one target for old and new members across restart", async () => {
  for (const ecosystem of ["javascript", "go"] as const) {
    const f = await fixture(ecosystem);
    const first = await f.start();
    expect((await first.reconcile()).complete).toBe(true);
    f.latest("2.0.0");
    await f.add("b");
    expect((await first.reconcile()).complete).toBe(true);
    expect(f.counts().resolves).toBe(2);
    const tool = ecosystem === "go" ? "golangci-lint" : "@biomejs/biome";
    for (const name of ["a", "b"]) {
      expect(JSON.parse(await readFile(join(f.root, name, "installed.json"), "utf8"))).toEqual({ [tool]: "2.0.0" });
    }
    await first.shutdown();
    f.latest("3.0.0");
    const reopened = await f.start();
    expect((await reopened.reconcile()).complete).toBe(true);
    expect(f.counts().resolves).toBe(2);
  }
});
