import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config/load";
import { testPolicyKey } from "../config/test/resolve";
import { safePath } from "../dependencies/paths";
import { withDomains } from "../dependencies/queue";
import { getPackagingStructure } from "../packaging/get-structure";
import type { TestAdapters } from "./adapters";
import { testArtifacts } from "./artifacts";
import { retainTestCoordinator, waitForTestPreparation } from "./coordinator";
import { testDeadline } from "./execution";
import { goTestAdapter } from "./go/adapter";
import { bunTestAdapter } from "./javascript/bun";
import { vitestTestAdapter } from "./javascript/vitest";
import {
  TestError,
  type TestOutcome,
  type TestPreparation,
  type TestRequest,
  unknownTests,
} from "./model";
import { testDomains, testIssue } from "./prepare";
import { pythonTestAdapter } from "./python/adapter";
import { parseTestRequest } from "./request";
import { coverageVerdict, testResult } from "./result";
import { collectTestScope } from "./scope";
import { TestStateStore } from "./state";
import { resolveTestTarget, type TestTarget } from "./targets";
export const testAdapters: TestAdapters = {
  pytest: pythonTestAdapter,
  vitest: vitestTestAdapter,
  bun: bunTestAdapter,
  go: goTestAdapter,
};
async function refreshTestTarget(
  root: string,
  projectId: string,
  signal?: AbortSignal,
) {
  return resolveTestTarget(
    (
      await getPackagingStructure(root, {
        signal,
        refresh: true,
        publish: false,
      })
    ).structure,
    projectId,
  );
}
export async function inspectTestProject(
  root: string,
  request: TestRequest,
  signal?: AbortSignal,
) {
  const target = await refreshTestTarget(root, request.project_id, signal);
  const config = await loadConfig(target.root, { signal });
  await collectTestScope(
    target,
    config.test[target.project.ecosystem],
    request.test_files,
  );
  return target;
}
const metadataNames = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "bunfig.toml",
  "pyproject.toml",
  "uv.lock",
  "pytest.ini",
  "setup.cfg",
  "tox.ini",
  "go.mod",
  "go.sum",
  "go.work",
  "go.work.sum",
  ".npmrc",
  ".yarnrc.yml",
  "tsconfig.json",
];
async function metadata(target: TestTarget) {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify([
      target.structure.projects,
      target.structure.workspaces,
      target.structure.localDependencies,
      target.scope.env,
    ]),
  );
  for (const dir of new Set([target.scope.cwd, target.scope.owner]))
    for (const name of metadataNames) {
      const path = await safePath(target.root, join(dir, name));
      try {
        const value = await readFile(path);
        hash.update(JSON.stringify([path, value.length]));
        hash.update(value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        hash.update(JSON.stringify([path, null]));
      }
    }
  return hash.digest("hex");
}
/** Execution holds the same native mutation domains as dependency/lint/typecheck setup. */
export async function runTestTarget(
  initial: TestTarget,
  request: TestRequest,
  signal: AbortSignal,
  preparation: TestPreparation,
  adapters: TestAdapters = testAdapters,
) {
  const mode = request.test_files ? "targeted" : "full";
  const config = await loadConfig(initial.root, {
    signal: signal.aborted ? undefined : signal,
  });
  const policy = config.test[initial.project.ecosystem];
  const outcome: TestOutcome = {
    project_id: request.project_id,
    relative_path: initial.project.path,
    runner: initial.runner,
    runner_version: null,
    mode,
    requested_files: request.test_files ?? [],
    executed_files: [],
    duration_ms: 0,
    tests: unknownTests(),
    coverage: coverageVerdict(
      mode,
      policy.coverage,
      initial.runner === "go" ? "statements" : "lines",
    ),
    errors: [],
    logs_truncated: false,
    preparation,
  };
  try {
    await withDomains(
      testDomains(initial.root, [initial]),
      signal,
      async () => {
        const target = await refreshTestTarget(
          initial.root,
          request.project_id,
          signal,
        );
        if (
          target.runner !== initial.runner ||
          JSON.stringify(testDomains(target.root, [target])) !==
            JSON.stringify(testDomains(initial.root, [initial]))
        )
          throw new TestError(
            "scope-changed",
            "Project ownership or runner changed while waiting; call project_test again",
          );
        const current = await loadConfig(target.root, { signal }),
          policy = current.test[target.project.ecosystem];
        const state = (await TestStateStore.load(target.root)).state,
          receipt = state.projects[request.project_id],
          adapter = adapters[target.runner];
        if (
          !adapter ||
          !receipt?.ready ||
          receipt.runner !== target.runner ||
          receipt.policy_hash !== testPolicyKey(policy)
        )
          throw new TestError(
            "not-ready",
            "Selected project's test preparation is not ready",
          );
        const wave = state.waves[target.runner];
        if (
          (target.runner === "pytest" || target.runner === "vitest") &&
          (!wave?.complete || !wave.projects.includes(request.project_id))
        )
          throw new TestError(
            "not-ready",
            "Common test runner alignment is incomplete",
          );
        if (!(await adapter.verify({ target, tools: receipt.tools, signal })))
          throw new TestError(
            "not-ready",
            "Native test tools changed after preparation",
          );
        outcome.runner_version = receipt.tools[target.runner] ?? null;
        outcome.coverage = coverageVerdict(
          mode,
          policy.coverage,
          target.runner === "go" ? "statements" : "lines",
        );
        const started = performance.now(),
          deadline = testDeadline(request.timeout_seconds, signal);
        let artifacts: Awaited<ReturnType<typeof testArtifacts>> | undefined;
        try {
          const scope = await collectTestScope(
              target,
              policy,
              request.test_files,
            ),
            before = await metadata(target);
          deadline.signal.throwIfAborted();
          artifacts = await testArtifacts(target.root);
          if (!scope.selected.length)
            outcome.tests = {
              total: 0,
              passed: 0,
              failed: 0,
              skipped: 0,
              cases: [],
            };
          else {
            const native = await adapter.run({
              target,
              tools: receipt.tools,
              signal: deadline.signal,
              policy,
              scope,
              mode,
              artifacts: artifacts.path,
              remainingMs: deadline.remainingMs,
            });
            const { coverage, ...result } = native;
            Object.assign(outcome, result);
            outcome.coverage = coverageVerdict(
              mode,
              policy.coverage,
              target.runner === "go" ? "statements" : "lines",
              coverage,
            );
          }
          deadline.signal.throwIfAborted();
          const after = await refreshTestTarget(
            target.root,
            request.project_id,
            deadline.signal,
          );
          const latest = await loadConfig(target.root, {
            signal: deadline.signal,
          });
          if (
            after.runner !== target.runner ||
            before !== (await metadata(after)) ||
            current.testKey !== latest.testKey ||
            scope.fingerprint !==
              (
                await collectTestScope(
                  after,
                  latest.test[after.project.ecosystem],
                  request.test_files,
                )
              ).fingerprint
          )
            throw new TestError(
              "sources-changed",
              "Project sources, ownership or test configuration changed during this run; run project_test again",
            );
          deadline.signal.throwIfAborted();
        } catch (error) {
          const issue = testIssue(
            deadline.signal.aborted ? deadline.signal.reason : error,
            request.project_id,
          );
          if (deadline.signal.aborted)
            outcome.errors = outcome.errors.filter(
              (e) => e.code !== "cancelled" && e.code !== "timeout",
            );
          outcome.errors.push(issue);
        } finally {
          deadline.dispose();
          try {
            await artifacts?.cleanup();
          } catch (error) {
            outcome.errors.push({
              code: "cleanup-failed",
              message: testIssue(error).message,
            });
          }
          outcome.duration_ms = Math.round(performance.now() - started);
        }
      },
    );
  } catch (error) {
    outcome.errors.push(
      testIssue(
        signal.aborted
          ? new TestError("cancelled", "Project test call cancelled")
          : error,
        request.project_id,
      ),
    );
  }
  return testResult(outcome);
}
/** Full API: validate identity/selection before any setup, retain shared preparation, then execute. */
export async function testProject(
  root: string,
  input: unknown,
  signal = new AbortController().signal,
  adapters: TestAdapters = testAdapters,
) {
  const request = parseTestRequest(input),
    target = await inspectTestProject(root, request, signal),
    owned = await retainTestCoordinator(target.root, adapters);
  try {
    return await runTestTarget(
      target,
      request,
      signal,
      await waitForTestPreparation(owned.coordinator, signal),
      adapters,
    );
  } finally {
    await owned.release();
  }
}
export function testFailure(error: unknown, signal?: AbortSignal) {
  return {
    success: false,
    complete: false,
    cancelled: signal?.aborted ?? false,
    error: testIssue(
      signal?.aborted
        ? new TestError("cancelled", "Project test call cancelled")
        : error,
    ),
  };
}
