import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { EcosystemTestPolicy } from "../config/test/model";
import { collectLintScope } from "../lint/scope";
import { partitionFiles, selectTestFiles } from "./selection";
import type { TestTarget } from "./targets";
export interface TestScope {
  tests: string[];
  sources: string[];
  selected: string[];
  fingerprint: string;
}
/** Reuse canonical ownership and validated manager destinations, not lint policy. */
export async function collectTestScope(
  target: TestTarget,
  policy: EcosystemTestPolicy,
  requested?: readonly string[],
): Promise<TestScope> {
  const owned = await collectLintScope(target);
  const { tests, sources } = partitionFiles(
    owned.files,
    policy,
    target.project.ecosystem,
  );
  const selected = selectTestFiles(tests, requested);
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
  return { tests, sources, selected, fingerprint: hash.digest("hex") };
}
