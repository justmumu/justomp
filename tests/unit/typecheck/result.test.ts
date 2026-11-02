import { expect, test } from "bun:test";
import { type TypecheckCheck, type TypecheckDiagnostic, type TypecheckPreparation } from "../../../src/typecheck/model";
import { mergePreparation, publicPreparation, typecheckResult } from "../../../src/typecheck/result";

const project = {
  project_id: "python:pyproject.toml",
  path: ".",
  ecosystem: "python" as const,
};
const diagnostic: TypecheckDiagnostic = {
  project_id: project.project_id,
  project_path: "module.py",
  severity: "error",
  rule: "reportAssignmentType",
  message: "Expected int",
};
function preparation(): TypecheckPreparation {
  return {
    status: "ready",
    action: "prepared",
    tools: { pyright: "1.1.414" },
    affected_projects: [project.project_id],
    changes: [],
    diagnostics: [],
    complete: true,
    cancelled: false,
    errors: [],
  };
}
function check(overrides: Partial<TypecheckCheck> = {}): TypecheckCheck {
  return {
    status: "failed",
    tool: "pyright",
    version: "1.1.414",
    exit_code: 1,
    duration_ms: 1,
    diagnostics: [diagnostic],
    truncated: false,
    cancelled: false,
    ...overrides,
  };
}
test("completed diagnostics survive late cancellation without claiming verification complete", () => {
  const result = typecheckResult(
    project,
    {
      preparation: preparation(),
      checks: [check()],
      policyHash: "policy",
      ready: false,
      failure: "Caller cancelled",
    },
    true,
  );
  expect(result).toMatchObject({
    complete: false,
    success: false,
    cancelled: true,
    diagnostics: [diagnostic],
    incomplete_stages: ["verification"],
  });
});
test("truncated check cannot become a complete public result", () => {
  const result = typecheckResult(
    project,
    {
      preparation: preparation(),
      checks: [check({ truncated: true })],
      policyHash: "policy",
      ready: true,
    },
    false,
  );
  expect(result).toMatchObject({
    complete: false,
    success: false,
    truncated: true,
    diagnostics: [diagnostic],
    incomplete_stages: ["typecheck"],
  });
  expect(result.remediation).toContain("Native output was truncated; rerun to obtain complete diagnostics.");
});
test("unrelated preparation failure keeps its effects while a ready selected check succeeds", () => {
  const selected = preparation();
  const report = {
    ...preparation(),
    status: "failed" as const,
    complete: false,
    changes: [
      {
        project_id: project.project_id,
        path: "uv.lock",
        kind: "created" as const,
      },
    ],
    errors: [
      {
        code: "preparation-failed",
        message: "Unrelated JS setup failed",
        project_id: "javascript:js/package.json",
      },
    ],
    projects: { [project.project_id]: selected },
  };
  const publicReport = publicPreparation(project.project_id, report);
  const result = typecheckResult(
    project,
    {
      preparation: publicReport,
      checks: [check({ status: "passed", exit_code: 0, diagnostics: [] })],
      policyHash: "policy",
      ready: true,
    },
    false,
  );
  expect(result.success).toBe(true);
  expect(result.complete).toBe(true);
  expect(result.partial_change).toBe(true);
  expect(result.preparation).toMatchObject({
    complete: false,
    tools: { pyright: "1.1.414" },
    errors: report.errors,
    changes: report.changes,
  });
  expect(result.preparation).not.toHaveProperty("projects");
  publicReport.changes.length = 0;
  expect(report.changes).toHaveLength(1);
});
test("missing check is explicit and no-sources is complete but unsuccessful", () => {
  const missing = typecheckResult(
    project,
    {
      preparation: publicPreparation(project.project_id),
      checks: [],
      policyHash: "",
      ready: false,
    },
    false,
  );
  expect(missing).toMatchObject({
    complete: false,
    success: false,
    incomplete_stages: ["preparation", "typecheck"],
  });
  expect(missing.checks[0]).toMatchObject({
    status: "not-run",
    tool: "pyright",
    version: null,
  });
  const empty = typecheckResult(
    project,
    {
      preparation: preparation(),
      checks: [check({ status: "no-sources", diagnostics: [] })],
      policyHash: "policy",
      ready: true,
    },
    false,
  );
  expect(empty).toMatchObject({
    complete: true,
    success: false,
    incomplete_stages: [],
  });
});
test("generated preparation merges prior effects and preserves a waited incomplete wave", () => {
  const base = {
    ...preparation(),
    action: "waited" as const,
    complete: false,
    status: "failed" as const,
    affected_projects: ["other"],
    errors: [{ code: "failed", message: "other" }],
  };
  const generated = preparation();
  const merged = mergePreparation(base, generated, true);
  expect(merged).toMatchObject({
    action: "waited",
    complete: false,
    status: "failed",
    affected_projects: ["other", project.project_id],
    errors: base.errors,
  });
  expect(mergePreparation(base, generated, false).complete).toBe(true);
});
