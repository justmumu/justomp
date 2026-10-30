import { expect, test } from "bun:test";
import type { LintCheck, LintPreparation } from "../../../src/lint/model";
import { lintResult } from "../../../src/lint/result";

const project = {
  project_id: "python:pyproject.toml",
  path: ".",
  ecosystem: "python" as const,
};
function result(status: LintCheck["status"], truncated = false) {
  const preparation: LintPreparation = {
    status: "ready",
    action: "already-ready",
    tools: { ruff: "0.17.3" },
    affected_projects: [project.project_id],
    changes: [],
    complete: true,
    cancelled: false,
    errors: [],
  };
  const checks: LintCheck[] = (["lint", "format"] as const).map((kind) => ({
    kind,
    status,
    tool: "ruff",
    version: "0.17.3",
    exit_code: 0,
    duration_ms: 0,
    diagnostics: [],
    truncated: false,
    cancelled: false,
  }));
  const first = checks[0];
  if (truncated && first)
    checks[0] = {
      ...first,
      status: "not-run",
      truncated: true,
      exit_code: 1,
    };
  return lintResult(
    project,
    { preparation, checks, policyHash: "policy", selectedReady: true },
    false,
  );
}
test("empty source checks are complete without claiming a passing lint run", () => {
  expect(result("no-sources")).toMatchObject({
    complete: true,
    success: false,
    incomplete_stages: [],
  });
});
test("truncated lint leaves formatting evidence and an incomplete public result", () => {
  const value = result("passed", true);
  expect(value).toMatchObject({
    truncated: true,
    complete: false,
    success: false,
    incomplete_stages: ["lint"],
  });
  expect(value.checks[1]).toMatchObject({ status: "passed", exit_code: 0 });
  expect(
    value.remediation.some((message) => message.includes("truncated")),
  ).toBe(true);
});
