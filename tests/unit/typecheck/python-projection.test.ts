import { afterEach, expect, spyOn, test } from "bun:test";
import { resolveTypecheckConfig } from "../../../src/config/typecheck/resolve";
import { object } from "../../../src/dependencies/inventory";
import * as files from "../../../src/lint/files";
import { planPythonProjection } from "../../../src/typecheck/projections/python";
import * as scopes from "../../../src/typecheck/scope";
import { scope, target } from "../checks/fixture";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});
function fixture() {
  const selected = target("python");
  selected.project.manifest = "apps/app/pyproject.toml";
  const docs = new Map<string, string>([
    ["/repo/apps/app/pyproject.toml", '[project]\nname="app"\nversion="1"\n'],
  ]);
  const read = spyOn(files, "readProjectionFile").mockImplementation(
    async (_root, path) => ({
      text: docs.get(path) ?? null,
      identity: docs.has(path) ? path : null,
      mode: 0o644,
    }),
  );
  const collect = spyOn(scopes, "collectTypecheckScope").mockResolvedValue({
    ...scope("module.py"),
    files: ["module.py", "tests/example.py"],
  });
  restores.push(
    () => read.mockRestore(),
    () => collect.mockRestore(),
  );
  const plan = () =>
    planPythonProjection(
      selected,
      resolveTypecheckConfig().policy,
      new AbortController().signal,
    );
  return { selected, docs, collect, plan };
}
test("Pyright TOML projection retains import paths and replaces native diagnostic opt-outs", async () => {
  const f = fixture();
  f.docs.set(
    "/repo/apps/app/pyproject.toml",
    '[project]\nname="app"\nversion="1"\n[tool.pyright]\nextraPaths=["stubs"]\ntypeCheckingMode="off"\nreportUnknownParameterType="none"\nexclude=["**"]\nignore=["**"]\n',
  );
  const plan = await f.plan();
  const config = object(Bun.JSONC.parse(plan.files[0]?.content ?? "{}"));
  expect(config).toMatchObject({
    extraPaths: ["/repo/apps/app/stubs"],
    typeCheckingMode: "strict",
    include: ["module.py", "tests/example.py"],
    exclude: [],
    ignore: [],
    venvPath: "/repo/apps/app",
    venv: ".venv",
  });
  expect(config.reportUnknownParameterType).toBeUndefined();
  expect(f.docs.get("/repo/apps/app/pyproject.toml")).toContain(
    'typeCheckingMode="off"',
  );
});
test("Pyright projection detects new sources, empty scope and unowned output without a compiler", async () => {
  const f = fixture();
  const first = await f.plan();
  const generated = first.files[0];
  if (!generated) throw new Error("missing projection");
  f.docs.set(generated.path, generated.content);
  expect((await f.plan()).current).toBe(true);
  f.collect.mockResolvedValue(scope("new.py"));
  expect((await f.plan()).current).toBe(false);
  f.collect.mockResolvedValue({ ...scope("unused"), files: [], empty: true });
  expect(
    object(Bun.JSONC.parse((await f.plan()).files[0]?.content ?? "{}")).include,
  ).toEqual([]);
  f.docs.set(generated.path, "{}");
  await expect(f.plan()).rejects.toMatchObject({ code: "projection-conflict" });
});
