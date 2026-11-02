import { ROOT_PROJECT_ID, WORKLOAD } from "../../scripts/development/receipt";

function result() {
  return {
    success: true,
    complete: true,
    project_id: ROOT_PROJECT_ID,
    relative_path: ".",
    mode: "full",
    runner: "bun",
    runner_version: "1.4.2",
    duration_ms: 1200,
    logs_truncated: false,
    errors: [],
    tests: {
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      cases: [{ name: "owned decision", file: "tests/unit/example.test.ts", status: "passed", duration_ms: 1200 }],
    },
    coverage: { status: "passed", metric: "lines", minimum: 70, percentage: 75, covered: 75, total: 100 },
  };
}
export function receipts() {
  const unit = result(),
    integration = { ...result(), suite: "integration", coverage: { ...result().coverage, status: "disabled" } };
  const common = {
    version: 1,
    workload: WORKLOAD,
    root: "/repo",
    project_id: ROOT_PROJECT_ID,
    source_count: 2,
    success: true,
    complete: true,
    cancelled: false,
    errors: [],
  };
  return {
    unit,
    integration,
    check: {
      ...common,
      action: "check",
      result: {
        success: true,
        complete: true,
        cancelled: false,
        stages: [
          {
            stage: "lint",
            project_id: ROOT_PROJECT_ID,
            success: true,
            complete: true,
            details: {
              checks: [
                { tool: "biome", version: "2.6.4" },
                { tool: "prettier", version: "3.9.10" },
              ],
            },
          },
          {
            stage: "typecheck",
            project_id: ROOT_PROJECT_ID,
            success: true,
            complete: true,
            details: { checks: [{ tool: "typescript", version: "7.0.2" }] },
          },
          { stage: "unit", project_id: ROOT_PROJECT_ID, success: true, complete: true, details: unit },
        ],
      },
    },
    integrated: { ...common, action: "integration", result: integration },
  };
}
