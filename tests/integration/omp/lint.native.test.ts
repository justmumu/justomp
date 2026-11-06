import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkProjectLint } from "../../../src/lint/index";
import { ruffPath } from "../../../src/lint/ruff-install";
import { VERSION } from "../../fixtures/lint/python/fixture";
import { cleanups, fixture, heldRegistry, json, registry, until } from "./lint-fixture";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
test("OMP native lint exposes setup effects and the same diagnostics as readonly API", async () => {
  const { f, h } = await fixture();
  const network = registry();
  try {
    const updates: unknown[] = [];
    const first = await h
      .getTool("project_lint")
      .execute("prepare", { project_id: "python:pyproject.toml" }, undefined, (result) => updates.push(result));
    const result = json(first);
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.preparation.tools).toEqual({ ruff: VERSION });
    expect(result.preparation.changes.some((c: { path: string }) => c.path === "pyproject.toml")).toBe(true);
    expect(updates.length).toBeGreaterThan(0);
  } finally {
    network.mockRestore();
  }
  await writeFile(join(f.root, "module.py"), '"""Example module."""\n\nvalue=unknown\n');
  const bytes = await f.bytes();
  const direct = await checkProjectLint(f.root, "python:pyproject.toml");
  const tool = json(await h.getTool("project_lint").execute("check", { project_id: "python:pyproject.toml" }));
  expect(tool.diagnostics).toEqual(direct.diagnostics);
  expect(tool.checks.map((c: { status: string }) => c.status)).toEqual(["failed", "failed"]);
  expect(await f.bytes()).toEqual(bytes);
  expect(JSON.parse(await readFile(join(f.root, ".justomp/config.json"), "utf8")).lint).toBeDefined();
}, 30000);
for (const transition of ["shutdown", "root change"] as const) {
  test(`session ${transition} aborts and joins the owned Ruff artifact download`, async () => {
    const { f, h } = await fixture([], true, true);
    const network = heldRegistry();
    try {
      await h.runner.emit({ type: "session_start" });
      await until(async () => network.entered(), "Ruff artifact download did not start");
      expect(network.calls()).toBe(1);
      if (transition === "shutdown") {
        await h.close();
      } else {
        const next = join(f.root, ".new-root");
        await mkdir(next);
        await h.session.moveTo(next, join(next, ".host/sessions"));
        await h.runner.emit({ type: "session_start" });
      }
      expect(network.aborted()).toBe(true);
      expect(await Bun.file(ruffPath(f.root)).exists()).toBe(false);
    } finally {
      network.release();
      await h.close();
      network.fetcher.mockRestore();
    }
  }, 30000);
}
