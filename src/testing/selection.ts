import picomatch from "picomatch";
import type { EcosystemTestPolicy } from "../config/test/model";
import type { Ecosystem } from "../inspect/model";
import { TestError } from "./model";
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
  const tests = files.filter(
    (file) =>
      included(file) &&
      !excluded(file) &&
      !file.startsWith("tests/integration/"),
  );
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
): string[] {
  if (!requested) return [...available];
  const availableSet = new Set(available);
  for (const file of requested)
    if (!availableSet.has(file))
      throw new TestError(
        "invalid-selection",
        `${file} is not an owned unit test file in the current scope`,
      );
  return [...new Set(requested)];
}
