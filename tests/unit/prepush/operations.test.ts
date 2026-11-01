import { afterEach, expect, spyOn, test } from "bun:test";
import * as config from "../../../src/config/load";
import * as lint from "../../../src/lint/prepare";
import { createPushOperations } from "../../../src/prepush/operations";
import type { ProjectTestResult } from "../../../src/testing/model";
import * as testing from "../../../src/testing/prepare";
import * as tests from "../../../src/testing/service";
import type { TestTarget } from "../../../src/testing/targets";
import * as types from "../../../src/typecheck/prepare";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});
function keep<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}
function fixture() {
  const report: lint.PreparationReport = {
    projects: {},
    status: "ready",
    action: "already-ready",
    tools: {},
    affected_projects: [],
    changes: [{ project_id: "api", path: "pyproject.toml", kind: "updated" }],
    complete: true,
    cancelled: false,
    errors: [],
  };
  const lintReport = structuredClone(report);
  const typeReport: types.PreparationReport = {
    ...structuredClone(report),
    projects: {},
    diagnostics: [],
    changes: [
      { project_id: "api", path: "types.json", kind: "updated" as const },
    ],
  };
  const testReport = {
    ...testing.preparationReport(),
    status: "ready" as const,
    complete: true,
  };
  const load = keep(
    spyOn(config, "loadConfig").mockResolvedValue({
      wrote: true,
    } as config.LoadedConfig),
  );
  const prepareLint = keep(
    spyOn(lint, "prepareLint").mockResolvedValue(lintReport),
  );
  const prepareTypes = keep(
    spyOn(types, "prepareTypecheck").mockResolvedValue(typeReport),
  );
  const prepareTests = keep(
    spyOn(testing, "prepareTests").mockResolvedValue(testReport),
  );
  return {
    lintReport,
    typeReport,
    testReport,
    load,
    prepareLint,
    prepareTypes,
    prepareTests,
  };
}
test("preparation retains effects and stops before later service preparation", async () => {
  const f = fixture();
  f.lintReport.complete = false;
  const ops = createPushOperations(),
    signal = new AbortController().signal;
  expect(await ops.prepare("/repo", signal)).toMatchObject({
    success: false,
    complete: false,
    effects: [".justomp/config.json", "pyproject.toml"],
    details: { lint: f.lintReport },
  });
  expect(f.prepareTypes).not.toHaveBeenCalled();
  expect(f.prepareTests).not.toHaveBeenCalled();
  f.lintReport.complete = true;
  f.typeReport.complete = false;
  expect(await ops.prepare("/repo", signal)).toMatchObject({
    success: false,
    complete: false,
    effects: [".justomp/config.json", "pyproject.toml", "types.json"],
  });
  expect(f.prepareTests).not.toHaveBeenCalled();
  f.typeReport.complete = true;
  f.testReport.complete = false;
  expect(await ops.prepare("/repo", signal)).toMatchObject({
    success: false,
    complete: false,
    details: { tests: f.testReport },
  });
});
test("unit checks reuse invocation preparation and forward coverage and incomplete results", async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  const target = { root: "/repo" } as TestTarget;
  const inspect = keep(
    spyOn(tests, "inspectTestProject").mockResolvedValue(target),
  );
  const outcome = {
    project_id: "api",
    relative_path: ".",
    runner: "pytest",
    runner_version: "1",
    mode: "full",
    requested_files: [],
    executed_files: [],
    duration_ms: 0,
    errors: [],
    logs_truncated: false,
    success: false,
    complete: true,
    tests: { total: 1, passed: 1, failed: 0, skipped: 0, cases: [] },
    coverage: {
      status: "below-threshold",
      minimum: 70,
      percentage: 50,
      metric: "lines",
      covered: 1,
      total: 2,
    },
    preparation: {
      ...f.testReport,
      changes: [{ project_id: "api", path: "uv.lock", kind: "updated" }],
    },
  } as ProjectTestResult;
  const run = keep(spyOn(tests, "runTestTarget").mockResolvedValue(outcome));
  const ops = createPushOperations();
  expect((await ops.prepare("/repo", signal)).success).toBe(true);
  for (const complete of [true, false]) {
    outcome.complete = complete;
    const stage = await ops.run("unit", "/repo", "api", signal);
    expect(stage).toEqual({
      stage: "unit",
      project_id: "api",
      success: false,
      complete,
      effects: ["uv.lock"],
      details: outcome,
    });
    expect(stage.details).toBe(outcome);
  }
  expect(inspect).toHaveBeenCalledWith(
    "/repo",
    { project_id: "api", timeout_seconds: 300 },
    signal,
  );
  expect(run).toHaveBeenCalledWith(
    target,
    { project_id: "api", timeout_seconds: 300 },
    signal,
    f.testReport,
  );
  expect(run.mock.calls.every((call) => call[3] === f.testReport)).toBe(true);
  expect(f.prepareTests).toHaveBeenCalledTimes(1);
  expect(f.prepareLint).toHaveBeenCalledTimes(1);
  expect(f.prepareTypes).toHaveBeenCalledTimes(1);
  await expect(
    createPushOperations().run("unit", "/repo", "api", signal),
  ).rejects.toThrow("preparation has not completed");
});
