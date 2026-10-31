import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { EcosystemTestPolicy } from "../config/test/model";
import { collectLintScope } from "../lint/scope";
import type { TestSuite } from "./model";
import { partitionSuites, selectTestFiles } from "./selection";
import type { TestTarget } from "./targets";
export interface TestScope {
  tests: string[];
  sources: string[];
  selected: string[];
  fingerprint: string;
  integration?: string[];
}
/** Reuse canonical ownership and validated manager destinations, not lint policy. */
export async function collectTestScope(
  target: TestTarget,
  suites: {
    unit: EcosystemTestPolicy;
    integration: EcosystemTestPolicy;
    suite: TestSuite;
  },
  requested?: readonly string[],
): Promise<TestScope> {
  const owned = await collectLintScope(target);
  const { tests, sources, integration } = partitionSuites(
    owned.files,
    suites.unit,
    suites.integration,
    target.project.ecosystem,
    suites.suite,
  );
  const selected = selectTestFiles(tests, requested, suites.suite);
  const hash = createHash("sha256");
  for (let offset = 0; offset < owned.files.length; offset += 8) {
    const batch = owned.files.slice(offset, offset + 8);
    const contents = await Promise.all(
      batch.map((file) => readFile(resolve(target.scope.cwd, file))),
    );
    for (const [i, file] of batch.entries()) {
      hash.update(JSON.stringify([file, contents[i]?.length]));
      hash.update(contents[i] as Buffer);
    }
  }
  return {
    tests,
    sources,
    selected,
    integration,
    fingerprint: hash.digest("hex"),
  };
}
