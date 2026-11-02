import picomatch from "picomatch";
import { type EcosystemTestPolicy } from "../config/test/model";
import { type Ecosystem } from "../inspect/model";
import { TestError, type TestSuite } from "./model";
export function literalGlob(path: string): string {
  return path.replace(/[\\*?[\]{}()!+@]/g, "\\$&");
}
export function partitionFiles(
  files: readonly string[],
  policy: EcosystemTestPolicy,
  ecosystem: Ecosystem,
): { tests: string[]; sources: string[] } {
  const match = (patterns: string[]) => picomatch(patterns, { dot: true });
  const included = match(policy.include),
    excluded = match(policy.exclude);
  const sourceIncluded = match(policy.source.include),
    sourceExcluded = match(policy.source.exclude);
  const tests = files.filter((file) => included(file) && !excluded(file));
  const testSet = new Set(tests);
  return {
    tests,
    sources: files.filter(
      (file) =>
        (ecosystem !== "python" || file.endsWith(".py")) &&
        sourceIncluded(file) &&
        !sourceExcluded(file) &&
        !testSet.has(file) &&
        !/\.d\.(?:ts|mts|cts)$/.test(file),
    ),
  };
}
export function selectTestFiles(
  available: readonly string[],
  requested?: readonly string[],
  suite: TestSuite = "unit",
): string[] {
  if (!requested) {
    return [...available];
  }
  const availableSet = new Set(available);
  for (const file of requested) {
    if (!availableSet.has(file)) {
      throw new TestError("invalid-selection", `${file} is not an owned ${suite} test file in the current scope`);
    }
  }
  return [...new Set(requested)];
}

/** Evaluate both policies before applying native platform filters. */
export function partitionSuites(
  files: readonly string[],
  unit: EcosystemTestPolicy,
  integration: EcosystemTestPolicy,
  ecosystem: Ecosystem,
  suite: TestSuite,
) {
  const units = partitionFiles(files, unit, ecosystem);
  const integrations = partitionFiles(files, integration, ecosystem);
  const integrationSet = new Set(integrations.tests);
  const conflicts = units.tests.filter((file) => integrationSet.has(file)).sort();
  if (conflicts.length) {
    throw new TestError(
      "test-scope-conflict",
      `test-scope-conflict: files match both test.${ecosystem} and integration_test.${ecosystem}; adjust include/exclude: ${conflicts.join(", ")}`,
    );
  }
  const allTests = new Set([...units.tests, ...integrations.tests]);
  const selected = suite === "unit" ? units : integrations;
  return {
    tests: selected.tests,
    sources: selected.sources.filter((file) => !allTests.has(file)),
    integration: integrations.tests,
  };
}
