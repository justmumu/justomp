import { object } from "../../dependencies/inventory";
import type { CoverageTotals, TestCase } from "../model";
import {
  completeCoverage,
  invalidReport,
  reportPath,
  summarize,
} from "../python/reports";
export function vitestReport(text: string, cwd: string, selected: string[]) {
  const data = object(JSON.parse(text));
  if (
    !Array.isArray(data.testResults) ||
    !Number.isSafeInteger(data.numTotalTests)
  )
    invalidReport("Expected Vitest JSON report");
  const cases: TestCase[] = [],
    files: string[] = [];
  let collectionError = false;
  for (const value of data.testResults) {
    const suite = object(value);
    if (
      typeof suite.name !== "string" ||
      !Array.isArray(suite.assertionResults)
    )
      invalidReport("Invalid Vitest suite");
    const file = reportPath(cwd, suite.name);
    if (!selected.includes(file))
      invalidReport(`Foreign test report path: ${suite.name}`);
    files.push(file);
    collectionError ||=
      suite.status === "failed" && suite.assertionResults.length === 0;
    for (const item of suite.assertionResults) {
      const c = object(item);
      if (
        typeof c.title !== "string" ||
        !["passed", "failed", "pending", "todo", "skipped"].includes(
          String(c.status),
        )
      )
        invalidReport("Invalid Vitest case");
      cases.push({
        name: typeof c.fullName === "string" ? c.fullName : c.title,
        file,
        status:
          c.status === "passed"
            ? "passed"
            : c.status === "failed"
              ? "failed"
              : "skipped",
        ...(Array.isArray(c.failureMessages) && c.failureMessages.length
          ? { message: c.failureMessages.join("\n") }
          : {}),
        ...(typeof c.duration === "number" ? { duration_ms: c.duration } : {}),
      });
    }
  }
  if (cases.length !== data.numTotalTests)
    invalidReport("Vitest test count does not match cases");
  collectionError ||=
    typeof data.numRuntimeErrorTestSuites === "number" &&
    data.numRuntimeErrorTestSuites > 0;
  return { tests: summarize(cases), executed_files: files, collectionError };
}
export function vitestCoverage(
  text: string,
  cwd: string,
  sources: string[],
): CoverageTotals {
  const entries = new Map<string, CoverageTotals>();
  for (const [file, value] of Object.entries(object(JSON.parse(text)))) {
    const data = object(value),
      statements = object(data.statementMap),
      hits = object(data.s),
      lines = new Map<number, number>();
    if (!data.statementMap || !data.s) invalidReport("Invalid Vitest coverage");
    for (const [id, statement] of Object.entries(statements)) {
      const line = object(object(statement).start).line,
        count = hits[id];
      if (
        !Number.isSafeInteger(line) ||
        Number(line) < 1 ||
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 0
      )
        invalidReport("Invalid coverage statement");
      lines.set(Number(line), Math.max(lines.get(Number(line)) ?? 0, count));
    }
    entries.set(reportPath(cwd, file), {
      total: lines.size,
      covered: [...lines.values()].filter((n) => n > 0).length,
    });
  }
  return completeCoverage(entries, sources);
}
