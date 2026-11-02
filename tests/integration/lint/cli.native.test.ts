import { afterEach, expect, spyOn, test } from "bun:test";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pythonAdapter } from "../../../src/lint/adapters/python";
import { checkProjectLint, prepareLintProjects } from "../../../src/lint/index";
import { cleanups, cli, fixture, registry } from "./cli-fixture";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
test("explicit preparation then API and CLI share native diagnostics without metadata writes", async () => {
  const f = await fixture();
  const network = registry();
  try {
    expect((await prepareLintProjects(f.root)).complete).toBe(true);
  } finally {
    network.mockRestore();
  }
  expect((await checkProjectLint(f.root, "python:pyproject.toml")).success).toBe(true);
  await writeFile(join(f.root, "module.py"), '"""Example module."""\n\nvalue=unknown\n');
  const before = await f.bytes();
  const config = await readFile(join(f.root, ".justomp/config.json"), "utf8");
  const snapshot = await readFile(join(f.root, ".justomp/packaging_structure.json"), "utf8");
  const state = await readFile(join(f.root, ".justomp/lint_state.json"), "utf8");
  const direct = await checkProjectLint(f.root, "python:pyproject.toml");
  const command = await cli(f.root, "python:pyproject.toml");
  expect(command.exit).toBe(1);
  expect(direct.checks.map((c) => c.status)).toEqual(["failed", "failed"]);
  expect(command.result.diagnostics).toEqual(direct.diagnostics);
  expect(await f.bytes()).toEqual(before);
  expect(await readFile(join(f.root, ".justomp/config.json"), "utf8")).toBe(config);
  expect(await readFile(join(f.root, ".justomp/packaging_structure.json"), "utf8")).toBe(snapshot);
  expect(await readFile(join(f.root, ".justomp/lint_state.json"), "utf8")).toBe(state);
}, 30000);
test("service preserves native diagnostics after cancellation and external readiness loss", async () => {
  const f = await fixture();
  const network = registry();
  try {
    await prepareLintProjects(f.root);
  } finally {
    network.mockRestore();
  }
  await writeFile(join(f.root, "module.py"), '"""Example module."""\n\nvalue=unknown\n');
  const actualCheck = pythonAdapter.check;
  const controller = new AbortController();
  const cancelledCheck = spyOn(pythonAdapter, "check").mockImplementation(async (context) => {
    const checks = await actualCheck(context);
    controller.abort(new Error("Cancelled after native diagnostics"));
    return checks;
  });
  try {
    const result = await checkProjectLint(f.root, "python:pyproject.toml", controller.signal);
    expect(result.cancelled).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.diagnostics.some((d) => d.rule === "F821")).toBe(true);
    expect(result.incomplete_stages).toContain("verification");
  } finally {
    cancelledCheck.mockRestore();
  }
  const modifiedCheck = spyOn(pythonAdapter, "check").mockImplementation(async (context) => {
    const checks = await actualCheck(context);
    await unlink(join(f.root, ".venv/bin/ruff"));
    return checks;
  });
  try {
    const result = await checkProjectLint(f.root, "python:pyproject.toml");
    expect(result.complete).toBe(false);
    expect(result.diagnostics.some((d) => d.rule === "F821")).toBe(true);
    expect(result.remediation.some((message) => message.includes("changed during"))).toBe(true);
  } finally {
    modifiedCheck.mockRestore();
  }
}, 30000);
