import { expect, test } from "bun:test";
import { resolveTestConfig, testPolicyKey } from "../../../src/config/test/resolve";
import { parseTestRequest } from "../../../src/testing/request";
import { coverageVerdict, testResult } from "../../../src/testing/result";

test("test defaults fill attributes and preserve explicit policy", () => {
  const { policy, missing } = resolveTestConfig({
    python: { include: [], coverage: { enabled: false, minimum: 0 } },
    future: 42,
  });
  expect(missing).toBe(true);
  expect(policy.python.include).toEqual([]);
  expect(policy.python.coverage).toEqual({ enabled: false, minimum: 0 });
  expect(policy.javascript.coverage).toEqual({ enabled: true, minimum: 70 });
  expect(policy.go.include).toEqual(["**/*_test.go"]);
  expect(policy.future).toBe(42);
  expect(resolveTestConfig(policy).missing).toBe(false);
  const changed = structuredClone(policy);
  changed.javascript.coverage.minimum = 80;
  expect(testPolicyKey(changed)).not.toBe(testPolicyKey(policy));
});
test.each([
  null,
  { python: { include: null } },
  { go: { coverage: { minimum: 101 } } },
  { javascript: { coverage: { enabled: 0 } } },
  { python: { include: ["../outside"] } },
])("reject invalid policy %j", (value) => {
  expect(() => resolveTestConfig(value)).toThrow();
});
test("request is strict and defaulted without changing exact file meaning", () => {
  expect(parseTestRequest({ project_id: "python:pyproject.toml" })).toEqual({
    project_id: "python:pyproject.toml",
    timeout_seconds: 300,
  });
  expect(
    parseTestRequest({
      project_id: "go:go.mod",
      test_files: ["a_test.go", "a_test.go"],
      timeout_seconds: 12,
    }).test_files,
  ).toEqual(["a_test.go"]);
  for (const extra of [
    { test_files: [] },
    { test_files: ["../a"] },
    { test_files: ["/a"] },
    { test_files: ["x.py::test_y"] },
    { timeout_seconds: null },
    { project_id: "python:.", timeout_seconds: 0 },
    { timeout_seconds: 1.5 },
    { ecosystem: "python" },
  ]) {
    expect(() => parseTestRequest({ project_id: "p", ...extra })).toThrow();
  }
});
test("coverage is aggregate, exact at the threshold and never invented", () => {
  const policy = { enabled: true, minimum: 70 };
  expect(coverageVerdict("full", policy, "lines", { covered: 69, total: 100 }).status).toBe("below-threshold");
  expect(coverageVerdict("full", policy, "lines", { covered: 70, total: 100 }).status).toBe("passed");
  expect(coverageVerdict("full", policy, "lines").status).toBe("unavailable");
  expect(coverageVerdict("targeted", policy, "lines").status).toBe("not-enforced-targeted");
  expect(coverageVerdict("full", policy, "statements", { covered: 0, total: 0 }).percentage).toBeNull();
});
test("assertion failures can be complete; empty and interrupted runs never succeed", () => {
  const base = {
    project_id: "p",
    relative_path: ".",
    runner: "pytest" as const,
    mode: "full" as const,
    requested_files: [],
    executed_files: ["tests/unit/test_x.py"],
    runner_version: "9.0.0",
    duration_ms: 3,
    tests: { total: 2, passed: 1, failed: 1, skipped: 0, cases: [] },
    coverage: coverageVerdict("full", { enabled: false, minimum: 70 }, "lines"),
    errors: [],
    logs_truncated: false,
  };
  expect(testResult(base)).toMatchObject({ complete: true, success: false });
  expect(
    testResult({
      ...base,
      tests: { total: 0, passed: 0, failed: 0, skipped: 0, cases: [] },
    }),
  ).toMatchObject({ success: false, errors: [{ code: "no-tests" }] });
  expect(testResult({ ...base, errors: [{ code: "timeout", message: "deadline" }] })).toMatchObject({
    complete: false,
    success: false,
  });
});

test("normalized test results redact native logs and structured assertion details", () => {
  const outcome = {
    project_id: "go:go.mod",
    relative_path: ".",
    runner: "go",
    runner_version: "1.25.6",
    mode: "full",
    requested_files: [],
    executed_files: [],
    duration_ms: 1,
    tests: {
      total: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
      cases: [{ name: "Test", status: "failed", message: "password=private" }],
    },
    coverage: {
      status: "disabled",
      metric: "statements",
      minimum: 70,
      percentage: null,
      total: null,
      covered: null,
    },
    errors: [],
    logs_truncated: false,
    stdout: "token=private",
    stderr: "https://user:private@example.com/",
  } as Parameters<typeof testResult>[0];
  const result = testResult(outcome);
  expect(JSON.stringify(result)).not.toContain("private");
  expect(result.tests.total).toBe(1);
  expect(result.complete).toBe(true);
  expect(outcome.stdout).toBe("token=private");
});
