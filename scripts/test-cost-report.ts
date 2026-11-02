import { ROOT_PROJECT_ID, record, unitResult, WORKLOAD } from "./development/receipt";
export interface TestCase {
  file: string;
  name: string;
  seconds: number;
}
export interface TestCounts {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
}
export const WARM_BUDGET_SECONDS = 300;
export function evaluateCost(seconds: number, counts: TestCounts, exits: number[], baselineSeconds?: number) {
  const complete =
    Number.isFinite(seconds) &&
    seconds >= 0 &&
    counts.tests > 0 &&
    counts.failures === 0 &&
    counts.errors === 0 &&
    counts.skipped === 0 &&
    exits.length === 2 &&
    exits.every((code) => code === 0);
  if (baselineSeconds !== undefined && (!Number.isFinite(baselineSeconds) || baselineSeconds <= 0)) {
    throw new Error("Invalid successful baseline duration");
  }
  const reduction = baselineSeconds === undefined ? null : 1 - seconds / baselineSeconds;
  return {
    complete,
    budget_met: complete && seconds <= WARM_BUDGET_SECONDS,
    reduction,
    reduction_met: complete && reduction !== null && reduction >= 0.6,
  };
}

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}
function seconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Missing or invalid test duration");
  }
  return value / 1000;
}
function successful(value: unknown): Record<string, unknown> {
  const result = record(value);
  if (result.success !== true || result.complete !== true || result.cancelled === true) {
    throw new Error("Command failed, was cancelled or did not complete");
  }
  return result;
}
function readCase(value: unknown): TestCase {
  const item = record(value);
  if (
    typeof item.name !== "string" ||
    !item.name ||
    typeof item.file !== "string" ||
    !item.file ||
    item.status !== "passed"
  ) {
    throw new Error("Missing, failed or skipped test case");
  }
  return { name: item.name, file: item.file, seconds: seconds(item.duration_ms) };
}
function readCounts(tests: Record<string, unknown>): TestCounts {
  const total = integer(tests.total, "total"),
    passed = integer(tests.passed, "passed"),
    failed = integer(tests.failed, "failed"),
    skipped = integer(tests.skipped, "skipped");
  if (!total || total !== passed + failed + skipped || failed || skipped) {
    throw new Error("Inconsistent, empty, failed or skipped tests");
  }
  return { tests: total, failures: failed, errors: 0, skipped };
}
function readTestResult(value: unknown) {
  const result = successful(value);
  if (
    result.project_id !== ROOT_PROJECT_ID ||
    result.relative_path !== "." ||
    result.mode !== "full" ||
    result.logs_truncated !== false
  ) {
    throw new Error("Wrong, targeted or truncated repository test result");
  }
  if (!Array.isArray(result.errors) || result.errors.length) {
    throw new Error("Test result contains errors");
  }
  seconds(result.duration_ms);
  const tests = record(result.tests),
    counts = readCounts(tests);
  if (!Array.isArray(tests.cases) || tests.cases.length !== counts.tests) {
    throw new Error("Missing test cases");
  }
  return { counts, cases: tests.cases.map(readCase) };
}
function readCoverage(value: unknown) {
  const coverage = record(record(value).coverage);
  const covered = integer(coverage.covered, "covered lines"),
    total = integer(coverage.total, "source lines");
  if (!total || covered > total || coverage.status !== "passed" || coverage.metric !== "lines") {
    throw new Error("Unit coverage is unavailable or failed");
  }
  const minimum = coverage.minimum,
    percentage = coverage.percentage;
  if (typeof minimum !== "number" || !Number.isFinite(minimum) || minimum < 70 || minimum > 100) {
    throw new Error("Invalid unit coverage minimum");
  }
  if (
    typeof percentage !== "number" ||
    !Number.isFinite(percentage) ||
    percentage < minimum ||
    Math.abs(percentage - (covered / total) * 100) > 0.01
  ) {
    throw new Error("Invalid or insufficient unit coverage");
  }
  return { status: "passed", covered, total, minimum, percentage };
}
function receipt(value: unknown, action: string) {
  const data = successful(value);
  if (
    data.version !== 1 ||
    data.workload !== WORKLOAD ||
    data.action !== action ||
    data.project_id !== ROOT_PROJECT_ID ||
    typeof data.root !== "string" ||
    !data.root
  ) {
    throw new Error("Wrong repository receipt identity");
  }
  if (!integer(data.source_count, "owned source count") || !Array.isArray(data.errors) || data.errors.length) {
    throw new Error("Incomplete repository scope or command errors");
  }
  return data;
}
export function readManagedGateReports(checkValue: unknown, integrationValue: unknown) {
  const check = receipt(checkValue, "check"),
    integrationReceipt = receipt(integrationValue, "integration");
  if (check.root !== integrationReceipt.root) {
    throw new Error("Lane repository roots differ");
  }
  successful(check.result);
  const unitValue = unitResult(check.result),
    unit = readTestResult(unitValue);
  const integration = readTestResult(integrationReceipt.result);
  if (record(integrationReceipt.result).suite !== "integration") {
    throw new Error("Missing integration suite identity");
  }
  const counts = { tests: unit.counts.tests + integration.counts.tests, failures: 0, errors: 0, skipped: 0 };
  return {
    unit,
    integration,
    counts,
    coverage: readCoverage(unitValue),
    managed_tools: managedToolVersions(check.result, unitValue),
  };
}
export function baselineDuration(value: unknown, environment: unknown): number {
  const baseline = record(value);
  if (
    baseline.version !== 2 ||
    baseline.workload !== WORKLOAD ||
    baseline.complete !== true ||
    baseline.cache !== "warm" ||
    JSON.stringify(baseline.environment) !== JSON.stringify(environment)
  ) {
    throw new Error("Baseline is non-comparable: require a complete warm run of the same workload and environment");
  }
  if (typeof baseline.seconds !== "number" || !Number.isFinite(baseline.seconds) || baseline.seconds <= 0) {
    throw new Error("Baseline must record a positive finite duration");
  }
  return baseline.seconds;
}

function managedToolVersions(value: unknown, unit: unknown): Record<string, string> {
  const versions: Record<string, string> = {};
  const stages = record(value).stages;
  if (!Array.isArray(stages)) {
    throw new Error("Missing checker version evidence");
  }
  for (const name of ["lint", "typecheck"]) {
    const stage = stages.map(record).find((item) => item.stage === name && item.project_id === ROOT_PROJECT_ID);
    const checks = record(stage?.details).checks;
    if (!Array.isArray(checks) || !checks.length) {
      throw new Error(`Missing ${name} versions`);
    }
    for (const check of checks) {
      const tool = record(check);
      recordVersion(versions, name, tool.tool, tool.version);
    }
  }
  const runner = record(unit);
  recordVersion(versions, "unit", runner.runner, runner.runner_version);
  return versions;
}
function recordVersion(versions: Record<string, string>, stage: string, name: unknown, version: unknown): void {
  if (typeof name !== "string" || !name || typeof version !== "string" || !version) {
    throw new Error(`Missing effective ${stage} tool version`);
  }
  versions[`${stage}:${name}`] = version;
}
export function compareBaseline(baseline: unknown, environment: unknown) {
  if (baseline === undefined) {
    return { kind: "no-matching-baseline", seconds: undefined, error: undefined };
  }
  try {
    return { kind: "matching-workload", seconds: baselineDuration(baseline, environment), error: undefined };
  } catch (error) {
    return {
      kind: "non-comparable",
      seconds: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
