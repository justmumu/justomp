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
function attributes(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
}
function count(attrs: Record<string, string>, name: string): number {
  const value = Number(attrs[name]);
  if (!(name in attrs) || !Number.isInteger(value) || value < 0) {
    throw new Error(`Missing or invalid JUnit ${name}`);
  }
  return value;
}
/** Bun's JUnit report is completion evidence, not a console-output estimate. */
export function readTestReport(xml: string): {
  counts: TestCounts;
  cases: TestCase[];
} {
  const root = xml.match(/<testsuites\b[^>]*>/)?.[0];
  if (!root || !xml.trimEnd().endsWith("</testsuites>")) {
    throw new Error("Incomplete JUnit report");
  }
  const attrs = attributes(root);
  const counts = {
    tests: count(attrs, "tests"),
    failures: count(attrs, "failures"),
    errors: "errors" in attrs ? count(attrs, "errors") : 0,
    skipped: count(attrs, "skipped"),
  };
  const cases = [...xml.matchAll(/<testcase\b[^>]*>/g)].map(([tag]) => {
    const item = attributes(tag);
    const seconds = Number(item.time);
    if (!item.name || !item.file || !Number.isFinite(seconds) || seconds < 0) {
      throw new Error("Invalid JUnit testcase");
    }
    return { name: item.name, file: item.file, seconds };
  });
  if (!counts.tests || counts.tests !== cases.length) {
    throw new Error("Missing JUnit test cases");
  }
  return { counts, cases };
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

/** Both lanes must supply completion evidence; a successful shell exit is insufficient. */
export function readGateReports(unitXml: string, integrationXml: string) {
  const unit = readTestReport(unitXml);
  const integration = readTestReport(integrationXml);
  const counts: TestCounts = {
    tests: unit.counts.tests + integration.counts.tests,
    failures: unit.counts.failures + integration.counts.failures,
    errors: unit.counts.errors + integration.counts.errors,
    skipped: unit.counts.skipped + integration.counts.skipped,
  };
  return { unit, integration, counts };
}
