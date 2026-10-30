import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as configModule from "../../../src/config/load";
import {
  resolveTestConfig,
  testPolicyKey,
} from "../../../src/config/test/resolve";
import * as paths from "../../../src/dependencies/paths";
import * as packaging from "../../../src/packaging/get-structure";
import type {
  NativeTestResult,
  TestAdapter,
} from "../../../src/testing/adapters";
import * as artifacts from "../../../src/testing/artifacts";
import { preparationReport } from "../../../src/testing/prepare";
import * as scopeModule from "../../../src/testing/scope";
import { runTestTarget } from "../../../src/testing/service";
import { TestStateStore } from "../../../src/testing/state";
import type { TestTarget } from "../../../src/testing/targets";
import * as targets from "../../../src/testing/targets";

test("service preserves native and cleanup errors, rejects changed policy, and reports cancellation without invented counts", async () => {
  const policy = resolveTestConfig().policy,
    target = {
      root: "/repo",
      runner: "vitest",
      project: { project_id: "id", path: ".", ecosystem: "javascript" },
      structure: { projects: [], workspaces: [], localDependencies: [] },
      scope: { cwd: "/repo", owner: "/repo", env: {}, domains: ["/repo/lock"] },
    } as unknown as TestTarget;
  let configRead = 0;
  let changed = false,
    cleanupFails = false,
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
    preflight: async () => {},
    prepare: async () => {},
    verify: async () => true,
    run: async () => {
      if (abort) controller.abort();
      return structuredClone(native);
    },
  };
  const mocks = [
    spyOn(configModule, "loadConfig").mockImplementation(
      async () =>
        ({
          test: policy,
          testKey: changed ? String(++configRead) : "same",
        }) as Awaited<ReturnType<typeof configModule.loadConfig>>,
    ),
    spyOn(packaging, "getPackagingStructure").mockResolvedValue({
      structure: target.structure,
    } as Awaited<ReturnType<typeof packaging.getPackagingStructure>>),
    spyOn(targets, "resolveTestTarget").mockResolvedValue(target),
    spyOn(paths, "safePath").mockImplementation(async (_root, path) => path),
    spyOn(fs, "readFile").mockRejectedValue(
      Object.assign(new Error("absent"), { code: "ENOENT" }),
    ),
    spyOn(scopeModule, "collectTestScope").mockResolvedValue({
      tests: ["a.test.ts"],
      selected: ["a.test.ts"],
      sources: ["a.ts"],
      fingerprint: "same",
    }),
    spyOn(artifacts, "testArtifacts").mockResolvedValue({
      path: "/reports/new",
      cleanup: async () => {
        if (cleanupFails) throw new Error("cleanup");
      },
    }),
    spyOn(TestStateStore, "load").mockResolvedValue({
      state: {
        projects: {
          id: {
            ready: true,
            runner: "vitest",
            tools: { vitest: "4.0.0" },
            policy_hash: testPolicyKey(policy.javascript),
          },
        },
        waves: { vitest: { complete: true, projects: ["id"] } },
      },
    } as unknown as TestStateStore),
  ];
  const run = () =>
    runTestTarget(
      target,
      { project_id: "id", timeout_seconds: 300 },
      controller.signal,
      preparationReport(),
      { vitest: adapter },
    );
  try {
    cleanupFails = true;
    const failure = await run();
    expect(failure.errors.map((e) => e.code)).toEqual([
      "test-failed",
      "invalid-report",
      "cleanup-failed",
    ]);
    expect(failure.tests.total).toBe(2);
    expect(failure.complete).toBe(false);
    cleanupFails = false;
    changed = true;
    const stale = await run();
    expect(stale.errors.some((e) => e.code === "sources-changed")).toBe(true);
    changed = false;
    abort = true;
    const cancelled = await run();
    expect(cancelled.errors.some((e) => e.code === "cancelled")).toBe(true);
    expect(cancelled.tests.total).toBe(2);
    expect(cancelled.complete).toBe(false);
  } finally {
    for (const mock of mocks.reverse()) mock.mockRestore();
  }
});
