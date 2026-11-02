import { type CoveragePolicy } from "../config/test/model";
import { redactValues } from "../dependencies/model";
import {
  type CoverageTotals,
  type ProjectTestResult,
  type TestCoverage,
  type TestMode,
  type TestOutcome,
} from "./model";
export function coverageVerdict(
  mode: TestMode,
  policy: CoveragePolicy,
  metric: TestCoverage["metric"],
  totals?: CoverageTotals,
): TestCoverage {
  const valid =
    totals &&
    Number.isSafeInteger(totals.total) &&
    Number.isSafeInteger(totals.covered) &&
    totals.total >= 0 &&
    totals.covered >= 0 &&
    totals.covered <= totals.total;
  const base = {
    metric,
    minimum: policy.minimum,
    percentage: valid && totals.total ? (totals.covered / totals.total) * 100 : null,
    covered: valid ? totals.covered : null,
    total: valid ? totals.total : null,
  };
  const status = (): TestCoverage["status"] => {
    if (mode === "targeted") {
      return "not-enforced-targeted";
    }
    if (!policy.enabled) {
      return "disabled";
    }
    if (!valid) {
      return "unavailable";
    }
    if (totals.total === 0) {
      return "not-applicable";
    }
    return totals.covered * 100 >= policy.minimum * totals.total ? "passed" : "below-threshold";
  };
  return { ...base, status: status() };
}
export function testResult(outcome: TestOutcome): ProjectTestResult {
  const errors = [...outcome.errors];
  if (outcome.tests.total === 0 && !errors.some((e) => e.code === "no-tests")) {
    errors.push({
      code: "no-tests",
      message: `No ${outcome.suite ?? "unit"} tests were collected for this selection`,
    });
  }
  if (outcome.coverage.status === "below-threshold" && !errors.some((e) => e.code === "coverage-below-threshold")) {
    errors.push({
      code: "coverage-below-threshold",
      message: `Coverage is below ${outcome.coverage.minimum}%`,
    });
  }
  if (outcome.coverage.status === "unavailable" && !errors.some((e) => e.code === "coverage-unavailable")) {
    errors.push({
      code: "coverage-unavailable",
      message: "Complete coverage is unavailable for this run",
    });
  }
  const complete =
    outcome.tests.total !== null &&
    !errors.some((e) => !["test-failed", "coverage-below-threshold", "no-tests"].includes(e.code));
  return redactValues({
    ...outcome,
    errors,
    complete,
    success: complete && errors.length === 0 && outcome.tests.total !== 0 && outcome.tests.failed === 0,
  });
}
