import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pythonAdapter } from "../../../src/typecheck/adapters/python";
import { applyProjection } from "../../../src/typecheck/projection";
import { projectionCurrent } from "../../fixtures/typecheck/projection";
import { VERSION } from "../../fixtures/typecheck/python/fixture";
import { cleanups, fixture } from "./python-fixture";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
test("native Pyright checks sources and tests strictly, retains imports, and writes nothing", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "tests"));
  await mkdir(join(f.root, "native"));
  const manifest = join(f.root, "pyproject.toml");
  await writeFile(
    manifest,
    (await readFile(manifest, "utf8")) +
      '\n[tool.pyright]\nextraPaths=["wrong-import-context"]\ntypeCheckingMode="off"\n',
  );
  await mkdir(join(f.root, "native/lib"));
  await writeFile(join(f.root, "native/lib/helper.pyi"), "VALUE: int\n");
  await writeFile(
    join(f.root, "native/base.json"),
    JSON.stringify({
      extraPaths: ["lib"],
      typeCheckingMode: "off",
      reportUnknownParameterType: "none",
      strictListInference: false,
    }),
  );
  await writeFile(
    join(f.root, "pyrightconfig.json"),
    "// native precedence\n" +
      JSON.stringify({
        extends: "native/base.json",
        exclude: ["**"],
        ignore: ["**"],
        executionEnvironments: [
          {
            root: ".",
            reportUnknownParameterType: "none",
            reportMissingParameterType: "none",
          },
        ],
      }),
  );
  await writeFile(join(f.root, "module.py"), "from helper import VALUE\nanswer: int = VALUE\n");
  await writeFile(join(f.root, "tests/test_types.py"), "def unknown(value):\n    return value\n");
  await f.prepare();
  const context = await f.checkContext();
  expect(await projectionCurrent(pythonAdapter, context)).toBe(true);
  expect(await readFile(join(f.root, "pyproject.toml"), "utf8")).toContain(`pyright==${VERSION}`);
  const before = await f.bytes();
  const [check] = await pythonAdapter.check(context);
  expect(check).toMatchObject({ status: "failed" });
  expect(
    check?.diagnostics.some((d) => d.project_path === "tests/test_types.py" && d.rule === "reportUnknownParameterType"),
  ).toBe(true);
  expect(check?.diagnostics.some((d) => d.rule === "reportMissingImports")).toBe(false);
  expect(await f.bytes()).toEqual(before);
}, 60000);

test("workspace declarations upgrade together and retain completed partial effects", async () => {
  const f = await fixture(true, '[dependency-groups]\ndev=["pyright==1.1.413"]');
  for (const tools of Object.values(f.context.versions)) {
    tools.pyright = "1.1.413";
  }
  await f.prepare();
  const oldLock = await readFile(join(f.root, "uv.lock"), "utf8");
  for (const tools of Object.values(f.context.versions)) {
    tools.pyright = VERSION;
  }
  f.context.changes.length = 0;
  const shim = join(f.root, "fault-bin");
  await mkdir(shim);
  const uv = Bun.which("uv");
  if (!uv) {
    throw new Error("uv required");
  }
  await writeFile(
    join(shim, "uv"),
    `#!/bin/sh\n'${uv.replaceAll("'", "'\\''")}' "$@"\nstatus=$?\nif [ "$1" = add ] && [ "$status" = 0 ]; then echo 'injected declaration failure' >&2; exit 71; fi\nexit "$status"\n`,
    { mode: 0o755 },
  );
  const paths = f.targets.map((t) => t.scope.env.PATH);
  for (const target of f.targets) {
    target.scope.env.PATH = `${shim}:${target.scope.env.PATH}`;
  }
  await expect(f.prepare()).rejects.toThrow("injected declaration failure");
  expect(f.context.changes).toEqual([{ project_id: "python:.", path: "pyproject.toml", kind: "updated" }]);
  expect(await readFile(join(f.root, "uv.lock"), "utf8")).toBe(oldLock);
  for (const [index, target] of f.targets.entries()) {
    target.scope.env.PATH = paths[index];
  }
  await f.prepare();
  for (const [index, target] of f.targets.entries()) {
    expect(await readFile(join(f.root, target.project.manifest), "utf8")).toContain(`pyright==${VERSION}`);
    expect(await projectionCurrent(pythonAdapter, await f.checkContext(index))).toBe(true);
  }
  await writeFile(join(f.root, "module.py"), "answer: int = 1\n");
  await writeFile(join(f.root, "packages/a/bad.py"), "bad: int = 'wrong'\n");
  expect((await pythonAdapter.check(await f.checkContext()))[0]?.status).toBe("passed");
  const childContext = await f.checkContext(1);
  await applyProjection(childContext.projection);
  const child = (await pythonAdapter.check(await f.checkContext(1)))[0];
  expect(child?.diagnostics[0]).toMatchObject({
    project_id: "python:packages/a",
    path: "packages/a/bad.py",
    project_path: "bad.py",
  });
}, 60000);

test("selected uv owner environment wins over conflicting native Pyright environment settings", async () => {
  const left = await fixture(),
    right = await fixture();
  await left.prepare();
  await right.prepare();
  for (const [f, type] of [
    [left, "int"],
    [right, "str"],
  ] as const) {
    const process = Bun.spawn(
      [join(f.root, ".venv/bin/python"), "-I", "-B", "-c", "import site; print(site.getsitepackages()[0])"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const site = (await new Response(process.stdout).text()).trim();
    expect(await process.exited).toBe(0);
    await mkdir(join(site, "typed_dependency"));
    await writeFile(join(site, "typed_dependency/__init__.pyi"), `VALUE: ${type}\n`);
    await writeFile(join(site, "typed_dependency/py.typed"), "");
    await writeFile(join(f.root, "module.py"), "from typed_dependency import VALUE\nanswer: int = VALUE\n");
  }
  await writeFile(join(left.root, "pyrightconfig.json"), JSON.stringify({ venvPath: right.root, venv: ".venv" }));
  await applyProjection((await left.checkContext()).projection);
  expect((await pythonAdapter.check(await left.checkContext()))[0]?.status).toBe("passed");
  expect((await pythonAdapter.check(await right.checkContext()))[0]?.diagnostics.map((d) => d.rule)).toContain(
    "reportAssignmentType",
  );
}, 60000);
test("check never bootstraps a missing checker or downloads a runtime", async () => {
  const f = await fixture();
  await f.prepare();
  await writeFile(join(f.root, "module.py"), "value: int = 1\n");
  const context = await f.checkContext();
  const process = Bun.spawn(
    [
      join(f.root, ".venv/bin/python"),
      "-I",
      "-B",
      "-c",
      "import pyright; from pathlib import Path; print(Path(pyright.__file__).parent / 'dist' / 'index.js')",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const entry = (await new Response(process.stdout).text()).trim();
  expect(await process.exited).toBe(0);
  const original = await readFile(entry, "utf8");
  await unlink(entry);
  const before = await f.bytes();
  expect(await pythonAdapter.verifyTools(context)).toBe(false);
  expect((await pythonAdapter.check(context))[0]?.status).toBe("not-run");
  expect(await f.bytes()).toEqual(before);
  expect(await Bun.file(entry).exists()).toBe(false);
  // Restore by replacement: the removed entry may have shared a cache inode.
  await writeFile(entry, original);
  const dist = dirname(entry);
  await rename(dist, `${dist}-unavailable`);
  const installedBin = join(f.root, "installed-only");
  await mkdir(installedBin);
  for (const name of ["uv", "node"]) {
    const executable = Bun.which(name);
    if (!executable) {
      throw new Error(`Missing ${name}`);
    }
    await symlink(executable, join(installedBin, name));
  }
  context.target.scope.env.PATH = installedBin;
  context.target.scope.env.PYRIGHT_PYTHON_CACHE_DIR = join(f.root, "wrapper-cache");
  await expect(pythonAdapter.prepareBatch(f.context)).rejects.toThrow(
    "requires installed npm; runtime download is disabled",
  );
  expect(await Bun.file(join(f.root, "wrapper-cache/pyright-python/nodeenv/bin/node")).exists()).toBe(false);
  await writeFile(join(f.root, "pyrightconfig.json"), "{broken");
  await expect(pythonAdapter.plan(context.target, context.policy, context.signal)).rejects.toThrow();
}, 60000);
