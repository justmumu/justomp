import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { resolveIntegrationTestConfig } from "../../../src/config/integration-test/resolve";
import * as configModule from "../../../src/config/load";
import { resolveTestConfig, testPolicyKey } from "../../../src/config/test/resolve";
import * as paths from "../../../src/dependencies/paths";
import * as packaging from "../../../src/packaging/get-structure";
import { type NativeTestResult, type TestAdapter } from "../../../src/testing/adapters";
import * as artifacts from "../../../src/testing/artifacts";
import { type TestSuite } from "../../../src/testing/model";
import { preparationReport } from "../../../src/testing/prepare";
import * as scopeModule from "../../../src/testing/scope";
import { runTestTarget } from "../../../src/testing/service";
import { TestStateStore } from "../../../src/testing/state";
import * as targets from "../../../src/testing/targets";
import { type TestTarget } from "../../../src/testing/targets";
import { suppliedResponse } from "./fixture";

test("service preserves native and cleanup errors, rejects changed policy, and reports cancellation without invented counts", async () => {
  const policy = resolveTestConfig().policy,
    target = {
      root: "/repo",
      runner: "vitest",
      project: { project_id: "id", path: ".", ecosystem: "javascript" },
      structure: { projects: [], workspaces: [], localDependencies: [] },
      scope: { cwd: "/repo", owner: "/repo", env: {}, domains: ["/repo/lock"] },
    } as unknown as TestTarget;
  target.structure.projects = [target.project];
  const integrationPolicy = resolveIntegrationTestConfig().policy;
  let changedSuite: TestSuite | undefined;
  let mutated = false;
  let runs = 0;
  let cleanupFails = false,
    abort = false;
  const controller = new AbortController();
  const native: NativeTestResult = {
    tests: { total: 2, passed: 1, failed: 1, skipped: 0, cases: [] },
    coverage: { total: 10, covered: 9 },
    errors: [
      { code: "test-failed", message: "assertion" },
      { code: "invalid-report", message: "malformed" },
    ],
    executed_files: ["a.test.ts"],
    stdout: "",
    stderr: "",
    logs_truncated: false,
  };
  const adapter: TestAdapter = {
    resolve: async () => ({ vitest: "4.0.0" }),
    preflight: () => {
      return Promise.resolve();
    },
    prepare: () => {
      return Promise.resolve();
    },
    verify: async () => true,
    run: () => {
      return suppliedResponse(() => {
        runs++;
        mutated = changedSuite !== undefined;
        if (abort) {
          controller.abort();
        }
        return structuredClone(native);
      });
    },
  };
  const mocks = [
    spyOn(configModule, "loadConfig").mockImplementation(() => {
      return suppliedResponse(() => {
        const unit = structuredClone(policy);
        const integration = structuredClone(integrationPolicy);
        if (mutated) {
          const other = changedSuite === "unit" ? unit : integration;
          other.javascript.include.push("custom/**/*.test.ts");
        }
        return {
          test: unit,
          integrationTest: integration,
          testKey: testPolicyKey(unit),
          integrationTestKey: testPolicyKey(integration),
          testingKey: testPolicyKey({ unit, integration }),
        } as Awaited<ReturnType<typeof configModule.loadConfig>>;
      });
    }),
    spyOn(packaging, "getPackagingStructure").mockResolvedValue({
      structure: target.structure,
    } as Awaited<ReturnType<typeof packaging.getPackagingStructure>>),
    spyOn(targets, "resolveTestTarget").mockImplementation(async (_structure, id) =>
      id === "other"
        ? {
            ...target,
            runner: "bun",
            project: { ...target.project, project_id: id },
          }
        : target,
    ),
    spyOn(paths, "safePath").mockImplementation(async (_root, path) => path),
    spyOn(fs, "readFile").mockRejectedValue(Object.assign(new Error("absent"), { code: "ENOENT" })),
    spyOn(scopeModule, "collectTestScope").mockResolvedValue({
      tests: ["a.test.ts"],
      selected: ["a.test.ts"],
      sources: ["a.ts"],
      fingerprint: "same",
    }),
    spyOn(artifacts, "testArtifacts").mockResolvedValue({
      path: "/reports/new",
      cleanup: () => {
        return suppliedResponse(() => {
          if (cleanupFails) {
            throw new Error("cleanup");
          }
        });
      },
    }),
    spyOn(TestStateStore, "load").mockResolvedValue({
      state: {
        projects: {
          id: {
            ready: true,
            runner: "vitest",
            tools: { vitest: "4.0.0" },
            policy_hash: testPolicyKey({
              unit: policy.javascript,
              integration: resolveIntegrationTestConfig().policy.javascript,
            }),
          },
        },
        waves: {
          vitest: {
            complete: true,
            projects: ["id"],
            tools: { vitest: "4.0.0" },
            pending: [],
          },
        },
      },
    } as unknown as TestStateStore),
  ];
  const run = (suite: TestSuite = "unit") =>
    runTestTarget(
      target,
      { project_id: "id", timeout_seconds: 300 },
      controller.signal,
      preparationReport(),
      { vitest: adapter },
      suite,
    );
  try {
    cleanupFails = true;
    const failure = await run();
    expect(failure.errors.map((e) => e.code)).toEqual(["test-failed", "invalid-report", "cleanup-failed"]);
    expect(failure.tests.total).toBe(2);
    expect(failure.complete).toBe(false);
    cleanupFails = false;
    native.errors = [];
    native.tests = { total: 2, passed: 2, failed: 0, skipped: 0, cases: [] };
    for (const suite of ["unit", "integration"] as const) {
      mutated = false;
      changedSuite = suite === "unit" ? "integration" : "unit";
      const stale = await run(suite);
      expect(stale.errors.map((e) => e.code)).toEqual(["sources-changed"]);
      expect(stale).toMatchObject({ suite, success: false, complete: false });
    }
    mutated = false;
    changedSuite = undefined;
    target.structure.projects.push({ ...target.project, project_id: "other" });
    const control = await run();
    expect(control.errors).toEqual([]);
    expect(control.tests.total).toBe(2);
    target.structure.projects.pop();
    const before = runs;
    target.structure.projects.push({ ...target.project, project_id: "new" });
    const discovered = await run();
    expect(discovered.errors.map((e) => e.code)).toEqual(["not-ready", "coverage-unavailable"]);
    target.structure.projects.pop();
    const state = (await TestStateStore.load(target.root)).state;
    const wave = state.waves.vitest;
    if (!wave) {
      throw new Error("Missing fixture wave");
    }
    wave.tools.vitest = "5.0.0";
    const mismatched = await run();
    expect(mismatched.errors.map((e) => e.code)).toEqual(["not-ready", "coverage-unavailable"]);
    expect(runs).toBe(before);
    wave.tools.vitest = "4.0.0";
    abort = true;
    const cancelled = await run();
    expect(cancelled.errors.some((e) => e.code === "cancelled")).toBe(true);
    expect(cancelled.tests.total).toBe(2);
    expect(cancelled.complete).toBe(false);
  } finally {
    for (const mock of mocks.reverse()) {
      mock.mockRestore();
    }
  }
});
