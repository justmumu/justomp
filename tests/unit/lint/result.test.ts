import { expect, test } from "bun:test";
import type {
  LintCheck,
  LintFix,
  LintPreparation,
} from "../../../src/lint/model";
import { lintResult } from "../../../src/lint/result";

const project = {
  project_id: "python:pyproject.toml",
  path: ".",
  ecosystem: "python" as const,
};
function result(
  status: LintCheck["status"],
  truncated = false,
  fix?: LintFix,
  failure?: string,
) {
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
    {
      preparation,
      checks,
      policyHash: "policy",
      selectedReady: true,
      ...(fix ? { fix } : {}),
      ...(failure ? { failure } : {}),
    },
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

function fix(overrides: Partial<LintFix> = {}): LintFix {
  return {
    requested: true,
    supported: true,
    status: "completed",
    changed_files: ["module.py"],
    observation_complete: true,
    errors: [],
    ...overrides,
  };
}
test("completed fixes report edits and remaining violations without calling them partial", () => {
  const value = result("failed", false, fix());
  expect(value).toMatchObject({
    complete: true,
    success: false,
    partial_change: false,
    fix: { status: "completed", changed_files: ["module.py"] },
  });
  expect(result("passed")).not.toHaveProperty("fix");
});
test("unsupported Go fixes and empty scope keep ordinary check semantics", () => {
  expect(
    result(
      "passed",
      false,
      fix({ supported: false, status: "unsupported", changed_files: [] }),
    ),
  ).toMatchObject({ complete: true, success: true });
  expect(
    result(
      "no-sources",
      false,
      fix({ status: "not-run", reason: "no-sources", changed_files: [] }),
    ),
  ).toMatchObject({ complete: true, success: false });
});
test("native fix failures retain partial writes even if supplied checks passed", () => {
  expect(
    result(
      "passed",
      false,
      fix({
        status: "failed",
        errors: [{ code: "fix-failed", message: "Native process failed" }],
      }),
    ),
  ).toMatchObject({
    complete: false,
    success: false,
    partial_change: true,
    incomplete_stages: ["fix"],
  });
  expect(
    result("passed", false, fix({ status: "cancelled", cancelled: true })),
  ).toMatchObject({ complete: false, cancelled: true, partial_change: true });
  expect(
    result("passed", false, fix({ status: "failed", truncated: true })),
  ).toMatchObject({ complete: false, truncated: true });
});
test("incomplete observation and final verification preserve known source effects", () => {
  const observed = result(
    "passed",
    false,
    fix({
      observation_complete: false,
      errors: [
        {
          code: "observation-failed",
          path: "other.py",
          message: "Cannot read file",
        },
      ],
    }),
  );
  expect(observed).toMatchObject({
    complete: false,
    partial_change: true,
    incomplete_stages: ["observation"],
  });
  expect(result("passed", false, fix(), "Policy changed")).toMatchObject({
    complete: false,
    partial_change: true,
    fix: { status: "completed", changed_files: ["module.py"] },
    incomplete_stages: ["verification"],
  });
});
