export class TestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TestError";
  }
}
export type TestRunner = "pytest" | "vitest" | "bun" | "go";
export type TestSuite = "unit" | "integration";
export type TestMode = "full" | "targeted";
export interface TestRequest {
  project_id: string;
  test_files?: string[];
  timeout_seconds: number;
}
export interface TestIssue {
  code: string;
  message: string;
  project_id?: string;
  file?: string;
}
export interface TestCase {
  name: string;
  file?: string;
  package?: string;
  status: "passed" | "failed" | "skipped";
  message?: string;
  duration_ms?: number;
  parent?: string;
}
export interface TestSummary {
  total: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  cases: TestCase[];
}
export interface CoverageTotals {
  covered: number;
  total: number;
}
export interface TestCoverage {
  status: "disabled" | "not-enforced-targeted" | "passed" | "below-threshold" | "unavailable" | "not-applicable";
  metric: "lines" | "statements";
  minimum: number;
  percentage: number | null;
  covered: number | null;
  total: number | null;
}
export interface TestPreparation {
  status: "unprepared" | "preparing" | "ready" | "failed";
  action: "prepared" | "waited" | "already-ready" | "not-attempted";
  tools: Record<string, Record<string, string>>;
  affected_projects: string[];
  changes: {
    project_id: string;
    path: string;
    kind: "created" | "updated" | "removed";
  }[];
  complete: boolean;
  cancelled: boolean;
  errors: TestIssue[];
}
export interface TestOutcome {
  suite?: TestSuite;
  project_id: string;
  relative_path: string;
  runner: TestRunner | null;
  runner_version: string | null;
  mode: TestMode;
  requested_files: string[];
  executed_files: string[];
  duration_ms: number;
  tests: TestSummary;
  coverage: TestCoverage;
  errors: TestIssue[];
  logs_truncated: boolean;
  preparation?: TestPreparation;
  stdout?: string;
  stderr?: string;
}
export interface ProjectTestResult extends TestOutcome {
  complete: boolean;
  success: boolean;
}
export interface ProjectIntegrationTestResult extends ProjectTestResult {
  suite: "integration";
}
export function unknownTests(): TestSummary {
  return { total: null, passed: null, failed: null, skipped: null, cases: [] };
}
