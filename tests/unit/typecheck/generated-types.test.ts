import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { javascriptAdapter } from "../../../src/typecheck/adapters/javascript";
import {
  prepareJavascriptTypes,
  resolveJavascriptTypes,
  verifyJavascriptTypes,
  withJavascriptTypes,
} from "../../../src/typecheck/javascript/prepare-types";
import { output, scope } from "../checks/fixture";
import { generatedUnit } from "./generated-fixture";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(next = true) {
  const f = generatedUnit(next);
  cleanups.push(f.restore);
  return f;
}
async function prepare(f: ReturnType<typeof fixture>) {
  const plan = await resolveJavascriptTypes(f.selected, f.controller.signal);
  return prepareJavascriptTypes(f.context, plan, plan.project_ids);
}
async function run(
  f: ReturnType<typeof fixture>,
  mode: "prepare" | "check-only" = "prepare",
  check = async () => "checked",
) {
  return withJavascriptTypes(
    f.selected.root,
    f.selected.project.project_id,
    { javascript: javascriptAdapter },
    mode,
    check,
    f.controller.signal,
  );
}

test("Next preparation passes resolved custom paths through generation and saves verifiable output receipts", async () => {
  const f = fixture();
  const result = await prepare(f);
  expect(result.complete).toBe(true);
  expect(result.changes).toContainEqual({
    project_id: f.selected.project.project_id,
    path: "apps/app/next-env.d.ts",
    kind: "created",
  });
  const receipt = f.state.generated?.[f.selected.project.project_id];
  expect(receipt?.next[f.selected.project.project_id]).toEqual({
    config: "apps/app/config/native.json",
    dist: "apps/app/generated-next",
  });
  expect(Object.keys(receipt?.outputs ?? {})).toEqual([
    "apps/app/generated-next/types/validator.ts",
    "apps/app/next-env.d.ts",
  ]);
  const plan = await resolveJavascriptTypes(f.selected, f.controller.signal);
  expect(await verifyJavascriptTypes(plan)).toBe(true);
  f.fingerprints.inputs = "edited-inputs";
  expect(await verifyJavascriptTypes(plan)).toBe(false);
  f.fingerprints.inputs = "inputs-v1";
  f.documents.delete("/repo/apps/app/generated-next/types/validator.ts");
  expect(await verifyJavascriptTypes(plan)).toBe(false);
});
test("readonly refuses stale generated inputs and preserves a completed check after a late change", async () => {
  const f = fixture();
  let checked = 0;
  const check = async () => {
    checked++;
    return "diagnostics";
  };
  expect((await run(f, "check-only", check)).ready).toBe(false);
  expect(checked).toBe(0);
  expect(f.load).not.toHaveBeenCalled();
  expect(f.generate).not.toHaveBeenCalled();
  expect((await prepare(f)).complete).toBe(true);
  f.load.mockClear();
  f.generate.mockClear();
  const clean = await run(f, "check-only", check);
  expect(clean).toMatchObject({ ready: true, value: "diagnostics" });
  expect(f.load).not.toHaveBeenCalled();
  expect(f.generate).not.toHaveBeenCalled();
  const late = await run(f, "check-only", async () => {
    f.fingerprints.inputs = "changed-during-check";
    return "diagnostics";
  });
  expect(late).toMatchObject({ ready: false, value: "diagnostics" });
  expect(late.preparation.errors[0]?.code).toBe("stale-generated-types");
});
test("Next config failure prevents generation and checking while retaining supplied completed effects", async () => {
  const f = fixture();
  f.load.mockImplementation(async () => {
    f.write("apps/app/config-log.txt", "started");
    return output({
      exit_code: 1,
      stderr: "required fixture environment missing",
    });
  });
  const result = await run(f);
  expect(result.ready).toBe(false);
  expect(result.value).toBeUndefined();
  expect(result.preparation.errors[0]?.message).toContain(
    "required fixture environment missing",
  );
  expect(result.preparation.changes).toContainEqual({
    project_id: f.selected.project.project_id,
    path: "apps/app/config-log.txt",
    kind: "created",
  });
  expect(f.generate).not.toHaveBeenCalled();
});
test("typegen rejection never falls back to build or invokes the checker", async () => {
  const f = fixture();
  f.generate.mockResolvedValue(
    output({ exit_code: 1, stderr: "Unknown command typegen" }),
  );
  const result = await run(f);
  expect(result.ready).toBe(false);
  expect(result.value).toBeUndefined();
  expect(result.preparation.errors[0]?.message).toContain("typegen");
  expect(f.generate).toHaveBeenCalledTimes(1);
  expect(f.generate.mock.calls[0]?.[3]).toEqual(["typegen"]);
  expect(f.state.generated?.[f.selected.project.project_id]?.ready).toBe(false);
});
test("cancelled generation retains its effects and blocks checking", async () => {
  const f = fixture();
  f.load.mockImplementation(async () => {
    f.write("apps/app/config-started.txt", "started");
    f.controller.abort(new Error("cancel"));
    return output({ exit_code: null, cancelled: true });
  });
  const result = await run(f);
  expect(result).toMatchObject({
    ready: false,
    preparation: { cancelled: true, complete: false },
  });
  expect(result.value).toBeUndefined();
  expect(result.preparation.changes).toContainEqual({
    project_id: f.selected.project.project_id,
    path: "apps/app/config-started.txt",
    kind: "created",
  });
});
test("generator toolchain changes invalidate readiness without changing the retained version target", async () => {
  const f = fixture();
  f.generate.mockImplementation(async () => {
    f.write("apps/app/package.json", {
      devDependencies: { typescript: "5.9.3" },
    });
    f.verify.mockResolvedValue(false);
    return output();
  });
  const result = await run(f);
  expect(result.ready).toBe(false);
  expect(result.value).toBeUndefined();
  expect(result.preparation.errors[0]?.code).toBe(
    "generator-changed-toolchain",
  );
  expect(f.state.projects[f.selected.project.project_id]?.ready).toBe(false);
  expect(f.state.waves.javascript).toMatchObject({
    complete: false,
    tools: { typescript: "7.0.2" },
  });
  expect(result.preparation.changes).toContainEqual({
    project_id: f.selected.project.project_id,
    path: "apps/app/package.json",
    kind: "updated",
  });
});
for (const boundary of ["config", "generation"] as const)
  test(`source mutation during ${boundary} cannot certify generated outputs`, async () => {
    const f = fixture();
    if (boundary === "config") {
      const original = required(f.load.getMockImplementation());
      f.load.mockImplementation(async (...args) => {
        f.fingerprints.source = "changed";
        return original(...args);
      });
    } else {
      const original = required(f.generate.getMockImplementation());
      f.generate.mockImplementation(async (...args) => {
        f.fingerprints.source = "changed";
        return original(...args);
      });
    }
    const result = await run(f);
    expect(result.ready).toBe(false);
    expect(result.value).toBeUndefined();
    expect(result.preparation.errors[0]?.code).toBe("source-changed");
  });
test("unexpected emitted paths are reported as effects but never receive a successful receipt", async () => {
  const f = fixture(false),
    member = f.add("core");
  f.compile.mockImplementation(async () => {
    f.write("packages/core/types/extra.d.ts", "unexpected");
    return output({ stdout: "TSFILE: /repo/packages/core/types/extra.d.ts\n" });
  });
  const result = await run(f);
  expect(result.ready).toBe(false);
  expect(result.value).toBeUndefined();
  expect(result.preparation.errors[0]?.message).toContain(
    "differed from effective config prediction",
  );
  expect(result.preparation.changes).toContainEqual({
    project_id: member.project.project_id,
    path: "packages/core/types/extra.d.ts",
    kind: "created",
  });
  expect(f.state.generated?.[f.selected.project.project_id]?.ready).toBe(false);
});
test("required declaration missing from the current compiler response cannot be satisfied by an old file", async () => {
  const f = fixture(false);
  f.add("core");
  f.write("packages/core/types/index.d.ts", "old declaration");
  f.compile.mockResolvedValue(output());
  const result = await prepare(f);
  expect(result.complete).toBe(false);
  expect(result.errors[0]?.message).toContain("missing from this invocation");
});
test("declaration ordering, arguments and rewritten references come from our supplied dependency graph", async () => {
  const f = fixture(false),
    ui = f.add("ui"),
    core = f.add("core");
  f.selected.structure.localDependencies = [
    {
      from: f.selected.project.project_id,
      to: ui.project.project_id,
      kind: "path",
      evidence: { file: "package.json", field: "dependencies.ui" },
    },
    {
      from: ui.project.project_id,
      to: core.project.project_id,
      kind: "path",
      evidence: { file: "package.json", field: "dependencies.core" },
    },
  ];
  const uiNode = required(
    required(f.graphs.get(ui.project.project_id)).nodes[0],
  );
  const coreNode = required(
    required(f.graphs.get(core.project.project_id)).nodes[0],
  );
  uiNode.references = [coreNode.path];
  required(f.graphs.get(ui.project.project_id)).nodes.push(coreNode);
  const plan = await resolveJavascriptTypes(f.selected, f.controller.signal);
  expect(
    plan.declarations.map((step) => step.target.project.project_id),
  ).toEqual([core.project.project_id, ui.project.project_id]);
  const compiled: string[] = [];
  f.compile.mockImplementation(async (member, args) => {
    compiled.push(member.project.project_id);
    expect(args).toContain("--emitDeclarationOnly");
    expect(
      args.slice(
        args.lastIndexOf("--noCheck"),
        args.lastIndexOf("--noCheck") + 2,
      ),
    ).toEqual(["--noCheck", "false"]);
    const path = join(member.scope.cwd, "types/index.d.ts");
    f.write(path, "declaration");
    return output({ stdout: `TSFILE: ${path}\n` });
  });
  const result = await prepareJavascriptTypes(
    f.context,
    plan,
    plan.project_ids,
  );
  expect(result.complete).toBe(true);
  expect(compiled).toEqual([core.project.project_id, ui.project.project_id]);
  const projected = required(
    f.documents.get(required(plan.declarations[1]).projection),
  );
  const data = JSON.parse(projected.slice(projected.indexOf("\n") + 1));
  expect(data.references).toEqual([
    { path: required(plan.declarations[0]).projection },
  ]);
  expect(data.compilerOptions).toMatchObject({
    noEmit: false,
    noCheck: false,
    emitDeclarationOnly: true,
  });
});
test("a dynamically discovered Next reference reacquires the expanded closure and preserves the first effects", async () => {
  const f = fixture();
  let loads = 0;
  f.load.mockImplementation(async () => {
    loads++;
    f.write("apps/app/config-loads.txt", String(loads));
    if (loads === 1) {
      const lib = f.add("library");
      f.graphs.delete(lib.project.project_id);
      f.write(lib.project.manifest, { types: "index.d.ts" });
      f.graphs.set(lib.project.project_id, {
        nodes: [],
        roots: [],
        scope: scope("index.d.ts"),
      });
    }
    return output({
      stdout:
        'JUSTOMP_NEXT_INPUTS={"config":"config/native.json","dist":"generated-next"}',
    });
  });
  const result = await run(f);
  expect(result.ready, JSON.stringify(result)).toBe(true);
  expect(loads).toBe(2);
  expect(result.preparation.changes).toContainEqual({
    project_id: f.selected.project.project_id,
    path: "apps/app/config-loads.txt",
    kind: "created",
  });
  expect(result.preparation.changes).toContainEqual({
    project_id: f.selected.project.project_id,
    path: "apps/app/config-loads.txt",
    kind: "updated",
  });
  expect(
    f.state.generated?.[f.selected.project.project_id]?.project_ids,
  ).toContain("javascript:packages/library/package.json");
});
test("declaration-only and configuration-only local packages need no compiler generation", async () => {
  const f = fixture(false),
    types = f.add("types", { types: "index.d.ts" }),
    settings = f.add("settings", {});
  f.graphs.set(types.project.project_id, {
    nodes: [],
    roots: [],
    scope: scope("index.d.ts"),
  });
  f.graphs.set(settings.project.project_id, {
    nodes: [],
    roots: [],
    scope: { ...scope(""), files: [], empty: true },
  });
  const plan = await resolveJavascriptTypes(f.selected, f.controller.signal);
  expect(plan.declarations).toEqual([]);
  expect(plan.project_ids).toContain(types.project.project_id);
  expect(plan.project_ids).toContain(settings.project.project_id);
  expect((await run(f)).ready).toBe(true);
  expect(f.compile).not.toHaveBeenCalled();
});

test("source-bearing same-package references emit while solution references only select check contexts", async () => {
  const f = fixture(false),
    member = f.selected,
    id = member.project.project_id,
    cwd = member.scope.cwd;
  const library = {
    path: join(cwd, "tsconfig.lib.json"),
    project_id: id,
    raw: {},
    compilerOptions: {
      composite: true,
      rootDir: "src",
      declarationDir: "types",
    },
    files: [join(cwd, "src/index.ts")],
    references: [],
    inherited: [],
  };
  const app = {
    ...library,
    path: join(cwd, "tsconfig.app.json"),
    compilerOptions: {},
    files: [join(cwd, "app/main.ts")],
    references: [library.path],
  };
  const solution = {
    ...app,
    path: join(cwd, "tsconfig.json"),
    files: [],
    references: [app.path],
  };
  f.graphs.set(id, {
    nodes: [solution, app, library],
    roots: [solution.path],
    scope: scope("app/main.ts"),
  });
  const plan = await resolveJavascriptTypes(member, f.controller.signal);
  expect(plan.declarations.map((step) => step.node.path)).toEqual([
    library.path,
  ]);
});
test("installed local package metadata adds the declaration chain without inspected edges", async () => {
  const f = fixture(false),
    ui = f.add("ui"),
    core = f.add("core");
  f.selected.structure.localDependencies = [];
  f.write(f.selected.project.manifest, { dependencies: { ui: "*" } });
  f.write(ui.project.manifest, {
    types: "types/index.d.ts",
    dependencies: { core: "*" },
  });
  const plan = await resolveJavascriptTypes(f.selected, f.controller.signal);
  expect(
    plan.declarations.map((step) => step.target.project.project_id),
  ).toEqual([core.project.project_id, ui.project.project_id]);
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing supplied fixture value");
  return value;
}
