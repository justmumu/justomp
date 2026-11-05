import { afterEach, expect, spyOn, test } from "bun:test";
import { parse } from "smol-toml";
import { resolveTypecheckConfig } from "../../../src/config/typecheck/resolve";
import { object } from "../../../src/dependencies/inventory";
import * as files from "../../../src/lint/files";
import { planPythonProjection } from "../../../src/typecheck/projections/python";
import * as scopes from "../../../src/typecheck/scope";
import { scope, target } from "../checks/fixture";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) {
    restore();
  }
});
function fixture() {
  const selected = target("python");
  selected.project.manifest = "apps/app/pyproject.toml";
  const docs = new Map<string, string>([["/repo/apps/app/pyproject.toml", '[project]\nname="app"\nversion="1"\n']]);
  const read = spyOn(files, "readProjectionFile").mockImplementation(async (_root, path) => ({
    text: docs.get(path) ?? null,
    identity: docs.has(path) ? path : null,
    mode: 0o644,
  }));
  const collect = spyOn(scopes, "collectTypecheckScope").mockResolvedValue({
    ...scope("module.py"),
    files: ["module.py", "tests/example.py"],
  });
  restores.push(
    () => read.mockRestore(),
    () => collect.mockRestore(),
  );
  const plan = () => planPythonProjection(selected, resolveTypecheckConfig().policy, new AbortController().signal);
  return { selected, docs, collect, plan };
}
test("Pyright TOML projection retains import paths and replaces native diagnostic opt-outs", async () => {
  const f = fixture();
  f.docs.set(
    "/repo/apps/app/pyproject.toml",
    '[project]\nname="app"\nversion="1"\n[tool.pyright]\nextraPaths=["stubs"]\ntypeCheckingMode="off"\nreportUnknownParameterType="none"\nvenvPath="/other/environment"\nvenv=".venv"\nexclude=["**"]\nignore=["**"]\n',
  );
  const plan = await f.plan();
  expect(plan.configs.check).toEqual(["/repo/apps/app/pyproject.toml"]);
  const config = object(object(parse(plan.files[0]?.content ?? "").tool).pyright);
  expect(config).toMatchObject({
    extraPaths: ["stubs"],
    typeCheckingMode: "strict",
    include: ["module.py", "tests/example.py"],
    exclude: [],
    ignore: [],
  });
  expect(config.reportUnknownParameterType).toBeUndefined();
  expect(config.venvPath).toBeUndefined();
  expect(config.venv).toBeUndefined();
  expect(f.docs.get("/repo/apps/app/pyproject.toml")).toContain('typeCheckingMode="off"');
});
test("Pyright native projection detects scope changes and adopts existing project config", async () => {
  const f = fixture();
  const first = await f.plan();
  const generated = first.files[0];
  if (!generated) {
    throw new Error("missing projection");
  }
  f.docs.set(generated.path, generated.content.replaceAll("\n", "\r\n").replaceAll("  ", "\t"));
  expect((await f.plan()).current).toBe(true);
  f.collect.mockResolvedValue(scope("new.py"));
  expect((await f.plan()).current).toBe(false);
  f.collect.mockResolvedValue({ ...scope("unused"), files: [], empty: true });
  expect(object(object(parse((await f.plan()).files[0]?.content ?? "").tool).pyright).include).toEqual([]);
  f.docs.set("/repo/apps/app/pyrightconfig.json", '{"extraPaths":["native-stubs"]}');
  const native = await f.plan();
  expect(native.configs.check).toEqual(["/repo/apps/app/pyrightconfig.json"]);
  expect(Bun.JSONC.parse(native.files[0]?.content ?? "{}")).toMatchObject({
    extraPaths: ["native-stubs"],
    typeCheckingMode: "strict",
  });
});

test("Pyright inherited import-context changes invalidate captured native inputs", async () => {
  const f = fixture();
  f.docs.set("/repo/apps/app/pyrightconfig.json", '{"extends":"./base.json"}');
  f.docs.set("/repo/apps/app/base.json", '{"extraPaths":["first-stubs"]}');
  const initial = await f.plan();
  for (const file of initial.files) {
    f.docs.set(file.path, file.content);
  }
  const ready = await f.plan();
  expect(ready.current).toBe(true);
  f.docs.set("/repo/apps/app/base.json", '{"extraPaths":["second-stubs"]}');
  const changed = await f.plan();
  expect(changed.input_fingerprint).not.toBe(ready.input_fingerprint);
  expect(changed.files.every((file) => !file.changed)).toBe(true);
});

test("Pyright inherited environment selectors require explicit reconciliation", async () => {
  const f = fixture();
  f.docs.set("/repo/apps/app/pyrightconfig.json", '{"extends":"./base.json"}');
  f.docs.set("/repo/apps/app/base.json", '{"venvPath":"elsewhere","venv":".venv","extraPaths":["stubs"]}');
  await expect(f.plan()).rejects.toThrow(
    "Inherited Pyright environment selector venv in /repo/apps/app/base.json must be removed",
  );
  expect(f.docs.get("/repo/apps/app/base.json")).toContain('"extraPaths":["stubs"]');
});

test("Pyright refuses inherited environment policy overrides while preserving clean context", async () => {
  const f = fixture();
  f.docs.set("/repo/apps/app/pyrightconfig.json", '{"extends":"./base.json"}');
  const context = { root: "src", extraPaths: ["stubs"], pythonVersion: "3.13", pythonPlatform: "Linux" };
  f.docs.set(
    "/repo/apps/app/base.json",
    JSON.stringify({ executionEnvironments: [{ ...context, reportMissingImports: "none" }] }),
  );
  await expect(f.plan()).rejects.toThrow("executionEnvironments[0].reportMissingImports");
  f.docs.set("/repo/apps/app/base.json", JSON.stringify({ executionEnvironments: [context] }));
  const clean = await f.plan();
  expect(Bun.JSONC.parse(clean.files[0]?.content ?? "{}")).toMatchObject({ extends: "./base.json" });
  expect(object(Bun.JSONC.parse(clean.files[0]?.content ?? "{}")).executionEnvironments).toBeUndefined();
  expect(JSON.parse(f.docs.get("/repo/apps/app/base.json") ?? "{}")).toEqual({ executionEnvironments: [context] });
  f.docs.set(
    "/repo/apps/app/base.json",
    JSON.stringify({ executionEnvironments: [{ ...context, reportMissingImports: "none" }] }),
  );
  f.docs.set(
    "/repo/apps/app/pyrightconfig.json",
    JSON.stringify({
      extends: "./base.json",
      executionEnvironments: [{ root: "local", reportMissingImports: "none" }],
    }),
  );
  const local = await f.plan();
  expect(object(Bun.JSONC.parse(local.files[0]?.content ?? "{}")).executionEnvironments).toEqual([{ root: "local" }]);
});
