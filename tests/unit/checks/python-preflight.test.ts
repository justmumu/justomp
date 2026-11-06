import { afterEach, expect, spyOn, test } from "bun:test";
import { type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import { resolveTypecheckConfig } from "../../../src/config/typecheck/resolve";
import * as runner from "../../../src/dependencies/runner";
import { pythonAdapter as lint } from "../../../src/lint/adapters/python";
import * as ruff from "../../../src/lint/ruff-install";
import * as runtime from "../../../src/lint/runtime";
import { RUFF_VERSION } from "../../../src/lint/toolchain";
import { pythonAdapter as typecheck } from "../../../src/typecheck/adapters/python";
import { suppliedResponse } from "../../response";
import { memoryContext } from "../dependencies/memory";
import { output, target } from "./fixture";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) {
    restore();
  }
});
function keep<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}
function fixture() {
  const f = memoryContext({
    ecosystem: "python",
    manager: "uv",
    managerCandidates: ["uv"],
    project_id: "python:pyproject.toml",
    manifest: "pyproject.toml",
  });
  restores.push(f.close);
  f.context.version = "0.11.6";
  f.write("pyproject.toml", '[project]\nname="app"\nversion="1.0.0"\nrequires-python=">=3.11"\n');
  const selected = target("python");
  Object.assign(selected, {
    root: f.root,
    project: f.context.project,
    structure: f.context.structure,
  });
  Object.assign(selected.scope, { cwd: f.root, owner: f.root });
  keep(spyOn(runtime, "lintManagerContext").mockResolvedValue(f.context));
  let existing = false,
    broken = false;
  keep(
    spyOn(fs, "lstat").mockImplementation((() => {
      return suppliedResponse(() => {
        if (!existing) {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        return {} as Stats;
      });
    }) as unknown as typeof fs.lstat),
  );
  keep(
    spyOn(fs, "realpath").mockImplementation(((path: unknown) => {
      return suppliedResponse(() => {
        if (broken) {
          throw Object.assign(new Error("missing interpreter"), {
            code: "ENOENT",
          });
        }
        return String(path).endsWith(".venv/bin/python") ? "/python/current" : String(path);
      });
    }) as typeof fs.realpath),
  );
  const node = keep(spyOn(Bun, "which").mockReturnValue("/node"));
  const process = keep(spyOn(runner, "runProcess").mockResolvedValue(output({ stdout: "v24.0.0\n" })));
  const run = keep(
    spyOn(f.context, "run").mockImplementation(async (step) =>
      output({
        stdout: step.args.includes("--show-version") ? "3.13.0\n" : "/python/current\n",
      }),
    ),
  );
  const context = {
    targets: [selected],
    versions: { [selected.project.project_id]: { pyright: "1.0.0" } },
    signal: new AbortController().signal,
    changes: [],
  };
  return {
    node,
    process,
    run,
    context,
    existing(value: boolean, damaged = false) {
      existing = value;
      broken = damaged;
    },
    preflight: () =>
      typecheck.preflight({
        ...context,
        policy: resolveTypecheckConfig().policy,
      }),
  };
}
for (const tool of ["pyright"] as const) {
  test(`${tool} preflight validates the selected Python without allowing downloads`, async () => {
    const f = fixture();
    await f.preflight();
    expect(f.run.mock.calls.map(([step]) => step.args)).toEqual([
      ["python", "find"],
      ["python", "find", "--show-version", "/python/current"],
      ["python", "find", ">=3.11,==3.13.0"],
    ]);
    expect(f.run.mock.calls.every(([step]) => step.env?.UV_PYTHON_DOWNLOADS === "never")).toBe(true);
    expect(f.context.changes).toEqual([]);
  });
  test(`${tool} preflight reports an unavailable or incompatible Python before mutations`, async () => {
    const f = fixture();
    f.run.mockResolvedValueOnce(output({ exit_code: 1, stderr: "not installed" }));
    await expect(f.preflight()).rejects.toMatchObject({
      code: "native-preparation-failed",
    });
    f.run
      .mockResolvedValueOnce(output({ stdout: "/python/current\n" }))
      .mockResolvedValueOnce(output({ stdout: "3.13.0\n" }))
      .mockResolvedValueOnce(output({ exit_code: 1, stderr: "incompatible pin" }));
    await expect(f.preflight()).rejects.toThrow("does not satisfy project constraints");
    expect(f.context.changes).toEqual([]);
  });
  test(`${tool} preflight rejects interpreter replacement and damaged environments`, async () => {
    const f = fixture();
    f.existing(true);
    f.run.mockResolvedValueOnce(output({ stdout: "/python/other\n" }));
    await expect(f.preflight()).rejects.toMatchObject({
      code: "runtime-conflict",
    });
    f.existing(true, true);
    await expect(f.preflight()).rejects.toMatchObject({
      code: "runtime-unavailable",
    });
    expect(f.context.changes).toEqual([]);
  });
}
test("Pyright preflight requires an installed Node after validating Python", async () => {
  const f = fixture();
  f.node.mockReturnValue(null);
  await expect(f.preflight()).rejects.toThrow("installed Node");
  expect(f.context.changes).toEqual([]);
  expect(f.process).not.toHaveBeenCalled();
});

test("Ruff selects its release pin and preflights without Python, uv, or dependency inspection", async () => {
  const selected = target("python");
  selected.scope.env = { PATH: "", UV_PROJECT_ENVIRONMENT: "/unused-environment" };
  const signal = new AbortController().signal;
  const policy = resolveLintConfig().policy;
  const manager = keep(spyOn(runtime, "lintManagerContext").mockRejectedValue(new Error("uv must not run")));
  const process = keep(spyOn(runner, "runProcess").mockRejectedValue(new Error("Python must not run")));
  const versions = await lint.resolve([selected], policy, signal, {
    [selected.project.project_id]: { ruff: "0.17.2" },
  });
  expect(versions).toEqual({ [selected.project.project_id]: { ruff: RUFF_VERSION } });
  const context = { targets: [selected], policy, signal, versions, changes: [] };
  await lint.preflight(context);
  expect(manager).not.toHaveBeenCalled();
  expect(process).not.toHaveBeenCalled();
  versions[selected.project.project_id] = { ruff: "0.17.2" };
  await expect(lint.preflight(context)).rejects.toMatchObject({ code: "invalid-version" });
});

test("Ruff readiness requires both the release pin and a successful live owned-binary version", async () => {
  const selected = target("python");
  const local = keep(spyOn(ruff, "localRuff").mockResolvedValue("/repo/owned/ruff"));
  const invoke = keep(spyOn(runner, "runProcess").mockResolvedValue(output({ stdout: `ruff ${RUFF_VERSION}\n` })));
  const context = {
    target: selected,
    versions: { ruff: RUFF_VERSION },
    signal: new AbortController().signal,
    policy: resolveLintConfig().policy,
    projection: { target: selected, files: [], current: true, configs: { lint: "", format: "" } },
  };
  expect(await lint.verify(context)).toBe(true);
  expect(local).toHaveBeenCalledWith(selected.root);
  expect(invoke.mock.calls[0]?.slice(0, 2)).toEqual(["/repo/owned/ruff", ["--version"]]);
  for (const result of [
    output({ stdout: "ruff 0.17.2\n" }),
    output({ stdout: `ruff ${RUFF_VERSION}\n`, exit_code: 1 }),
    output({ stdout: `ruff ${RUFF_VERSION}\n`, truncated: true }),
    output({ stdout: `ruff ${RUFF_VERSION}\n`, cancelled: true }),
  ]) {
    invoke.mockResolvedValueOnce(result);
    expect(await lint.verify(context)).toBe(false);
  }
  invoke.mockClear();
  expect(await lint.verify({ ...context, versions: { ruff: "0.17.2" } })).toBe(false);
  expect(invoke).not.toHaveBeenCalled();
});
