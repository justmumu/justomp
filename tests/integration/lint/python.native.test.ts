import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FORMAT_DEFAULTS } from "../../../src/config/format/defaults";
import { assertFormatProcess } from "../../../src/format/engines/process";
import { formatPython } from "../../../src/format/engines/python";
import { collectFormatScope } from "../../../src/format/scope";
import { selectFormatFiles } from "../../../src/format/selection";
import { pythonAdapter } from "../../../src/lint/adapters/python";
import { applyLintFix, pendingLintFix } from "../../../src/lint/fix";
import { applyProjection } from "../../../src/lint/projection";
import { localRuff, ruffPath } from "../../../src/lint/ruff-install";
import { measureFixture } from "../../fixtures/cost-timing";
import { VERSION } from "../../fixtures/lint/python/fixture";
import { cleanups, fixture } from "./python-fixture";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
test("owned Ruff prepares without Python or uv and checks, fixes, and formats without dependency writes", async () => {
  const f = await fixture();
  for (const target of f.targets) {
    target.scope.env.PATH = "";
  }
  f.context.policy.python.ruff.format.exclude = ["format-only.py"];
  await measureFixture("format.python.prepare", () => f.prepare());
  const context = await f.checkContext();
  expect(await pythonAdapter.verify(context)).toBe(true);
  expect(await readFile(join(f.root, "pyproject.toml"), "utf8")).not.toContain("ruff==");
  expect(await Bun.file(join(f.root, "uv.lock")).exists()).toBe(false);
  expect(await Bun.file(join(f.root, ".venv/pyvenv.cfg")).exists()).toBe(false);
  expect(await localRuff(f.root)).toBe(ruffPath(f.root));
  for (const [source, lint, format] of [
    ['"""A clean module."""\n', "passed", "passed"],
    ['"""A module."""\n\nVALUE = \'bad quotes\'\n', "passed", "failed"],
    ['"""A module."""\n\nimport os\n', "failed", "passed"],
  ] as const) {
    await writeFile(join(f.root, "module.py"), source);
    const before = await f.bytes();
    const checks = await pythonAdapter.check(context);
    expect(checks.map((c) => c.status)).toEqual([lint, format]);
    expect(await f.bytes()).toEqual(before);
    if (format === "failed") {
      expect(checks[1]?.diagnostics[0]?.project_path).toBe("module.py");
    }
    if (lint === "failed") {
      expect(checks[0]?.diagnostics.some((d) => d.rule === "F401")).toBe(true);
    }
    if (lint === "failed") {
      const fix = pendingLintFix("python");
      const metadata = await readFile(join(f.root, "pyproject.toml"), "utf8");
      await applyLintFix(context, pythonAdapter, fix);
      expect(fix).toMatchObject({
        status: "completed",
        changed_files: ["module.py"],
        observation_complete: true,
      });
      expect(await readFile(join(f.root, "module.py"), "utf8")).not.toBe(source);
      expect((await pythonAdapter.check(context)).map((check) => check.status)).toEqual(["passed", "failed"]);
      expect(await readFile(join(f.root, "pyproject.toml"), "utf8")).toBe(metadata);
    }
    if (format === "failed") {
      const manifest = await readFile(join(f.root, "pyproject.toml"), "utf8");
      const untouched = "OTHER = 'unchanged'\n";
      await writeFile(join(f.root, "other.py"), untouched);
      assertFormatProcess(await formatPython(context, ["module.py"]), "ruff");
      expect(await readFile(join(f.root, "other.py"), "utf8")).toBe(untouched);
      await unlink(join(f.root, "other.py"));
      expect((await pythonAdapter.check(context))[1]?.status).toBe("passed");
      const formatted = await f.bytes();
      assertFormatProcess(await formatPython(context, ["module.py"]), "ruff");
      expect(await f.bytes()).toEqual(formatted);
      expect(await readFile(join(f.root, "pyproject.toml"), "utf8")).toBe(manifest);
    }
  }
  // Reuse the prepared native fixture to prove shared selection matches actual Ruff skips.
  await mkdir(join(f.root, ".private"));
  const excluded = "VALUE=  'leave unchanged'\n";
  await writeFile(join(f.root, ".private/draft.py"), excluded);
  await writeFile(join(f.root, "format-only.py"), excluded);
  const scope = await collectFormatScope(context.target, FORMAT_DEFAULTS, context.policy);
  expect(scope.files).toContain("module.py");
  expect(scope.files).not.toContain(".private/draft.py");
  expect(scope.files).not.toContain("format-only.py");
  expect(() => selectFormatFiles(scope, ["module.py", ".private/draft.py"])).toThrow("not an owned supported file");
  assertFormatProcess(await formatPython(context, [".private/draft.py", "format-only.py"]), "ruff");
  expect(await readFile(join(f.root, ".private/draft.py"), "utf8")).toBe(excluded);
  expect(await readFile(join(f.root, "format-only.py"), "utf8")).toBe(excluded);
}, 60000);
test("owned Ruff ignores retained pins and preserves workspace legacy dependencies and lock bytes", async () => {
  const f = await fixture(true, '[dependency-groups]\ndev=["ruff==0.17.2"]');
  const lock = "# Existing application dependency lock remains untouched.\n";
  await writeFile(join(f.root, "uv.lock"), lock);
  const versions = await pythonAdapter.resolve(f.targets, f.context.policy, f.context.signal, {
    "python:.": { ruff: "0.17.2" },
  });
  expect(Object.values(versions).every((tools) => tools.ruff === VERSION)).toBe(true);
  f.context.versions = versions;
  for (const target of f.targets) {
    target.scope.env.PATH = "";
  }
  await f.prepare();
  for (const [index, target] of f.targets.entries()) {
    expect(await readFile(join(f.root, target.project.manifest), "utf8")).toContain("ruff==0.17.2");
    expect(await pythonAdapter.verify(await f.checkContext(index))).toBe(true);
  }
  expect(await readFile(join(f.root, "uv.lock"), "utf8")).toBe(lock);
  expect(await Bun.file(join(f.root, ".venv/pyvenv.cfg")).exists()).toBe(false);
}, 60000);

test("corrupt local Ruff is not ready and check never repairs it", async () => {
  const f = await fixture();
  await f.prepare();
  await writeFile(join(f.root, "module.py"), '"""A module."""\n');
  const binary = ruffPath(f.root);
  await unlink(binary);
  await writeFile(binary, "corrupt");
  const context = await f.checkContext();
  expect(await pythonAdapter.verify(context)).toBe(false);
  const before = await f.bytes();
  expect((await pythonAdapter.check(context)).map((c) => c.status)).toEqual(["not-run", "not-run"]);
  expect(await f.bytes()).toEqual(before);
  expect(await readFile(binary, "utf8")).toBe("corrupt");
}, 60000);
test("managed Ruff config wins over project overrides and excludes unowned source", async () => {
  const f = await fixture();
  await f.prepare();
  await writeFile(join(f.root, "ruff.toml"), 'lint.ignore=["ALL"]\n');
  await writeFile(join(f.root, "module.py"), '"""A module."""\n\n\nimport os\n');
  await mkdir(join(f.root, ".private"));
  await writeFile(join(f.root, ".private", "hidden.py"), "not valid python!\n");
  await mkdir(join(f.root, "tests"));
  await writeFile(join(f.root, "tests", "test_example.py"), "def test_example():\n    assert True\n");
  await applyProjection((await f.checkContext()).projection);
  const checks = await pythonAdapter.check(await f.checkContext());
  const rules = checks[0]?.diagnostics.map((d) => d.rule);
  expect(rules).toContain("F401");
  expect(checks.flatMap((c) => c.diagnostics).every((d) => d.project_path === "module.py")).toBe(true);
}, 60000);

test("checks override native auto-fix and output-file environment settings", async () => {
  const f = await fixture();
  f.context.policy.python.ruff.fix = true;
  f.context.policy.python.ruff["fix-only"] = true;
  await f.prepare();
  await writeFile(join(f.root, "module.py"), '"""A module."""\n\nimport os\n');
  const target = f.targets[0];
  if (!target) {
    throw new Error("Missing fixture target");
  }
  target.scope.env.RUFF_OUTPUT_FILE = join(f.root, "module.py");
  const before = await f.bytes();
  expect((await pythonAdapter.check(await f.checkContext()))[0]?.status).toBe("failed");
  expect(await f.bytes()).toEqual(before);
}, 60000);

test("workspace checks report project-relative paths and omit another project's source", async () => {
  const f = await fixture(true);
  await f.prepare();
  await writeFile(join(f.root, "module.py"), '"""Root module."""\n');
  await writeFile(join(f.root, "packages/a/module.py"), '"""Member module."""\n\nimport os\n');
  expect((await pythonAdapter.check(await f.checkContext())).map((c) => c.status)).toEqual(["passed", "passed"]);
  const checks = await pythonAdapter.check(await f.checkContext(1));
  const unused = checks[0]?.diagnostics.find((d) => d.rule === "F401");
  expect(unused?.path).toBe("packages/a/module.py");
  expect(unused?.project_path).toBe("module.py");
  expect(unused?.line).toBe(3);
}, 60000);
test("owned Ruff ignores custom Python environments and honors cancellation", async () => {
  const f = await fixture();
  const target = f.targets[0];
  if (!target) {
    throw new Error("Missing fixture target");
  }
  target.scope.env.UV_PROJECT_ENVIRONMENT = join(f.root, ".lint-env");
  target.scope.env.PATH = "";
  await f.prepare();
  await writeFile(join(f.root, "module.py"), '"""Root module."""\n');
  const context = await f.checkContext();
  expect(await pythonAdapter.verify(context)).toBe(true);
  expect((await pythonAdapter.check(context)).map((c) => c.status)).toEqual(["passed", "passed"]);
  expect(await Bun.file(join(f.root, ".lint-env/pyvenv.cfg")).exists()).toBe(false);
  const controller = new AbortController();
  controller.abort();
  await expect(formatPython({ ...context, signal: controller.signal }, ["module.py"])).rejects.toThrow();
}, 60000);
test("native Ruff exclusions must come from the shared policy, never leftover project options", async () => {
  const f = await fixture();
  f.context.policy.python.ruff.exclude = ["module.py"];
  await f.prepare();
  await writeFile(join(f.root, "module.py"), '"""Example module."""\n\nVALUE = missing_name\n');
  await writeFile(join(f.root, "clean.py"), '"""A clean module."""\n');
  const context = await f.checkContext();
  expect(context.versions.ruff).toBe(VERSION);
  const excluded = await pythonAdapter.check(context);
  expect(excluded.map((check) => check.status)).toEqual(["passed", "passed"]);
  expect(excluded.flatMap((check) => check.diagnostics)).toEqual([]);

  f.context.policy.python.ruff.exclude = [];
  f.context.changes.length = 0;
  await f.prepare();
  expect(f.context.changes.some((change) => change.path.startsWith(".justomp/tools/"))).toBe(false);
  const included = await pythonAdapter.check(await f.checkContext());
  expect(included[0]?.status).toBe("failed");
  expect(included[0]?.diagnostics.map((diagnostic) => diagnostic.rule)).toContain("F821");
}, 60000);
