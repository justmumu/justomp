import { afterEach, expect, spyOn, test } from "bun:test";
import * as config from "../../../src/config/load";
import { resolveTypecheckConfig } from "../../../src/config/typecheck/resolve";
import { type TypecheckCheckContext } from "../../../src/typecheck/adapters/types";
import * as coordinator from "../../../src/typecheck/coordinator";
import * as freshness from "../../../src/typecheck/freshness";
import { type TypecheckCheck } from "../../../src/typecheck/model";
import { type PreparationReport } from "../../../src/typecheck/prepare";
import { checkTypecheckTarget, typecheckAdapters } from "../../../src/typecheck/service";
import * as targets from "../../../src/typecheck/targets";
import { target } from "../checks/fixture";

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
  const selected = target("python");
  selected.structure.localDependencies = [];
  const controller = new AbortController();
  const policy = { typecheck: resolveTypecheckConfig().policy } as config.LoadedConfig;
  const context: TypecheckCheckContext = {
    target: selected,
    policy: policy.typecheck,
    versions: { pyright: "1.0.0" },
    signal: controller.signal,
    projection: { target: selected, files: [], configs: { check: [] }, current: true },
  };
  const report: PreparationReport = {
    status: "ready",
    action: "already-ready",
    tools: context.versions,
    affected_projects: [selected.project.project_id],
    changes: [],
    diagnostics: [],
    complete: true,
    cancelled: false,
    errors: [],
    projects: {},
  };
  report.projects[selected.project.project_id] = { ...report };
  const completed: TypecheckCheck = {
    tool: "pyright",
    version: "1.0.0",
    status: "failed",
    exit_code: 1,
    duration_ms: 2,
    diagnostics: [{ project_id: selected.project.project_id, severity: "error", message: "Compiler diagnostic" }],
    cancelled: false,
    truncated: false,
  };
  keep(spyOn(config, "loadConfig").mockResolvedValue(policy));
  keep(spyOn(targets, "resolveTypecheckTarget").mockResolvedValue(selected));
  keep(
    spyOn(coordinator, "withReadyTypecheckTarget").mockImplementation((_root, _id, _adapters, operation) =>
      operation(context),
    ),
  );
  const fingerprint = keep(spyOn(freshness, "fingerprintTypecheckSources").mockResolvedValue("before"));
  const check = keep(spyOn(typecheckAdapters.python, "check").mockResolvedValue([completed]));
  return {
    controller,
    completed,
    fingerprint,
    check,
    run: () => checkTypecheckTarget(selected, controller.signal, report),
  };
}

test("source drift after compiler completion retains checks and diagnostics", async () => {
  const f = fixture();
  f.fingerprint.mockResolvedValueOnce("before").mockResolvedValueOnce("after");
  const result = await f.run();
  expect(result).toMatchObject({
    complete: false,
    success: false,
    cancelled: false,
    incomplete_stages: ["verification"],
  });
  expect(result.checks).toEqual([f.completed]);
  expect(result.diagnostics).toEqual(f.completed.diagnostics);
  expect(result.preparation.errors).toContainEqual(expect.objectContaining({ code: "sources-changed" }));
});

test("cancellation after compiler completion retains checks and diagnostics", async () => {
  const f = fixture();
  f.check.mockImplementation(() => {
    f.controller.abort(new Error("Caller cancelled"));
    return Promise.resolve([f.completed]);
  });
  const result = await f.run();
  expect(result).toMatchObject({
    complete: false,
    success: false,
    cancelled: true,
    incomplete_stages: ["verification"],
  });
  expect(result.checks).toEqual([f.completed]);
  expect(result.diagnostics).toEqual(f.completed.diagnostics);
  expect(result.preparation.errors).toContainEqual(expect.objectContaining({ message: "Caller cancelled" }));
});
