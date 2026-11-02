import { afterEach, expect, spyOn, test } from "bun:test";
import { parseDevelopmentArgs, runDevelopment } from "../../scripts/development/command";
import { ROOT_PROJECT_ID } from "../../scripts/development/receipt";
import * as services from "../../scripts/development/services";

const mocks: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const mock of mocks.splice(0).reverse()) {
    mock.mockRestore();
  }
});
function boundary() {
  const scope = {
    sources: ["src/index.ts"],
    tests: [
      "tests/integration/lint/a.test.ts",
      "tests/integration/omp/lint.test.ts",
      "tests/integration/other.test.ts",
    ],
    selected: [],
    fingerprint: "scope",
  };
  mocks.push(spyOn(services, "repositoryScope").mockResolvedValue(scope));
  const invoke = spyOn(services, "invokeDevelopment").mockResolvedValue({ success: true, complete: true });
  mocks.push(invoke);
  return { scope, invoke };
}
test("arguments preserve exact test selections and reject options on unrelated actions", () => {
  expect(
    parseDevelopmentArgs([
      "test",
      "--test-file",
      "tests/unit/a.test.ts",
      "--timeout-seconds",
      "40",
      "--report",
      "/report.json",
    ]),
  ).toMatchObject({
    action: "test",
    request: { project_id: ROOT_PROJECT_ID, test_files: ["tests/unit/a.test.ts"], timeout_seconds: 40 },
    report: "/report.json",
  });
  for (const args of [
    ["unknown"],
    ["check", "--test-file", "a.ts"],
    ["test", "--timeout-seconds", "0"],
    ["integration", "--group", "unknown"],
    ["test", "--report"],
  ]) {
    expect(() => parseDevelopmentArgs(args)).toThrow();
  }
});
test("individual commands delegate once and retain incomplete failures", async () => {
  const f = boundary();
  for (const action of ["lint", "lint-fix", "format", "typecheck", "setup"] as const) {
    const result = await runDevelopment("/repo", parseDevelopmentArgs([action]));
    expect(result.success).toBe(true);
    expect(result.source_count).toBe(1);
    expect(f.invoke.mock.calls.at(-1)?.[1].action).toBe(action);
  }
  f.invoke.mockResolvedValue({ success: false, complete: false, errors: ["failed preparation"] });
  expect(await runDevelopment("/repo", parseDevelopmentArgs(["lint"]))).toMatchObject({
    success: false,
    complete: false,
    result: { errors: ["failed preparation"] },
  });
  expect(f.invoke).toHaveBeenCalledTimes(6);
});
test("empty owned scope, cancellation and absent unit evidence cannot establish success", async () => {
  const f = boundary();
  f.scope.sources = [];
  expect((await runDevelopment("/repo", parseDevelopmentArgs(["check"]))).success).toBe(false);
  expect(f.invoke).not.toHaveBeenCalled();
  f.scope.sources = ["src/index.ts"];
  expect((await runDevelopment("/repo", parseDevelopmentArgs(["check"]))).success).toBe(false);
  const abort = new AbortController();
  abort.abort(new Error("cancelled"));
  expect(await runDevelopment("/repo", parseDevelopmentArgs(["format"]), abort.signal)).toMatchObject({
    success: false,
    cancelled: true,
  });
});
test("feature aliases select managed integration files once and early failed gates retain details", async () => {
  const f = boundary();
  f.invoke.mockResolvedValue({ success: true, complete: true, tests: { total: 2 } });
  const result = await runDevelopment("/repo", parseDevelopmentArgs(["integration", "--group", "lint"]));
  expect(result.success).toBe(true);
  expect(f.invoke.mock.calls[0]?.[1].request.test_files).toEqual([
    "tests/integration/lint/a.test.ts",
    "tests/integration/omp/lint.test.ts",
  ]);
  f.invoke.mockResolvedValue({ success: false, complete: true, stages: [{ stage: "dependency", success: false }] });
  expect(await runDevelopment("/repo", parseDevelopmentArgs(["check"]))).toMatchObject({
    success: false,
    complete: true,
    result: { stages: [{ stage: "dependency", success: false }] },
  });
});

test("dependency and typecheck aliases retain their distinct managed file selection", async () => {
  const f = boundary();
  f.scope.tests = [
    "tests/integration/dependencies/sync.test.ts",
    "tests/integration/typecheck/references.native.test.ts",
    "tests/integration/omp/typecheck.test.ts",
    "tests/integration/omp/typecheck.native.test.ts",
    "tests/integration/omp/lint.test.ts",
    "tests/integration/other.test.ts",
  ];
  f.invoke.mockResolvedValue({ success: true, complete: true, tests: { total: 4 } });
  await runDevelopment("/repo", parseDevelopmentArgs(["integration", "--group", "dependencies"]));
  expect(f.invoke.mock.calls.at(-1)?.[1].request.test_files).toEqual([
    "tests/integration/dependencies/sync.test.ts",
    "tests/integration/omp/typecheck.test.ts",
    "tests/integration/omp/typecheck.native.test.ts",
    "tests/integration/omp/lint.test.ts",
  ]);
  await runDevelopment("/repo", parseDevelopmentArgs(["integration", "--group", "typecheck"]));
  expect(f.invoke.mock.calls.at(-1)?.[1].request.test_files).toEqual([
    "tests/integration/typecheck/references.native.test.ts",
    "tests/integration/omp/typecheck.test.ts",
    "tests/integration/omp/typecheck.native.test.ts",
  ]);
});
