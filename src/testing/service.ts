import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type LoadedConfig, loadConfig } from "../config/load";
import { safePath } from "../dependencies/paths";
import { withDomains } from "../dependencies/queue";
import { sameVersions } from "../lint/versions";
import { getPackagingStructure } from "../packaging/get-structure";
import { type TestAdapter, type TestAdapters } from "./adapters";
import { testArtifacts } from "./artifacts";
import { retainTestCoordinator, waitForTestPreparation } from "./coordinator";
import { testDeadline } from "./execution";
import { goTestAdapter } from "./go/adapter";
import { bunTestAdapter } from "./javascript/bun";
import { VITEST_CONFIG_NAMES } from "./javascript/native-config";
import { vitestTestAdapter } from "./javascript/vitest";
import {
  type ProjectIntegrationTestResult,
  TestError,
  type TestOutcome,
  type TestPreparation,
  type TestRequest,
  type TestSuite,
  unknownTests,
} from "./model";
import { suitePolicies, testingPolicyKey } from "./policy";
import { testDomains, testIssue } from "./prepare";
import { planTestProjection } from "./projection";
import { pythonTestAdapter } from "./python/adapter";
import { parseTestRequest } from "./request";
import { coverageVerdict, testResult } from "./result";
import { collectTestScope, type TestScope } from "./scope";
import { type TestReceipt, type TestState, TestStateStore } from "./state";
import { resolveTestTarget, type TestTarget } from "./targets";
export const testAdapters: TestAdapters = {
  pytest: pythonTestAdapter,
  vitest: vitestTestAdapter,
  bun: bunTestAdapter,
  go: goTestAdapter,
};
async function refreshTestTarget(root: string, projectId: string, signal?: AbortSignal, suite: TestSuite = "unit") {
  return resolveTestTarget(
    (
      await getPackagingStructure(root, {
        ...(signal !== undefined ? { signal } : {}),
        refresh: true,
        publish: false,
      })
    ).structure,
    projectId,
    suite,
  );
}
export async function inspectTestProject(
  root: string,
  request: TestRequest,
  signal?: AbortSignal,
  suite: TestSuite = "unit",
) {
  const target = await refreshTestTarget(root, request.project_id, signal, suite);
  const config = await loadConfig(target.root, signal !== undefined ? { signal } : {});
  await collectTestScope(target, suitePolicies(config, target.project.ecosystem, suite), request.test_files);
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
  ".coveragerc",
  ...VITEST_CONFIG_NAMES,
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
  for (const dir of new Set([target.scope.cwd, target.scope.owner])) {
    for (const name of metadataNames) {
      const path = await safePath(target.root, join(dir, name));
      await hashMetadataFile(hash, path);
    }
  }
  if (target.configFile) {
    const bytes = await readFile(target.configFile);
    hash.update(JSON.stringify([target.configFile, bytes.length]));
    hash.update(bytes);
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
  suite: TestSuite = "unit",
) {
  const mode = request.test_files ? "targeted" : "full";
  const config = await loadConfig(initial.root, {
    ...(!signal.aborted ? { signal } : {}),
  });
  const policy = suitePolicies(config, initial.project.ecosystem, suite)[suite];
  const outcome: TestOutcome = {
    suite,
    project_id: request.project_id,
    relative_path: initial.project.path,
    runner: initial.runner,
    runner_version: null,
    mode,
    requested_files: request.test_files ?? [],
    executed_files: [],
    duration_ms: 0,
    tests: unknownTests(),
    coverage: coverageVerdict(mode, policy.coverage, initial.runner === "go" ? "statements" : "lines"),
    errors: [],
    logs_truncated: false,
    preparation,
  };
  try {
    await withDomains(testDomains(initial.root, [initial]), signal, () =>
      runLocked({ initial, request, signal, adapters, suite, outcome }),
    );
  } catch (error) {
    outcome.errors.push(
      testIssue(signal.aborted ? new TestError("cancelled", "Project test call cancelled") : error, request.project_id),
    );
  }
  return testResult(outcome);
}
/** Full API: validate identity/selection before any setup, retain shared preparation, then execute. */
async function executeProjectTests(
  root: string,
  input: unknown,
  signal = new AbortController().signal,
  adapters: TestAdapters = testAdapters,
  suite: TestSuite = "unit",
) {
  const request = parseTestRequest(input),
    target = await inspectTestProject(root, request, signal, suite),
    owned = await retainTestCoordinator(target.root, adapters);
  try {
    return await runTestTarget(
      target,
      request,
      signal,
      await waitForTestPreparation(owned.coordinator, signal),
      adapters,
      suite,
    );
  } finally {
    await owned.release();
  }
}
export function testProject(
  root: string,
  input: unknown,
  signal = new AbortController().signal,
  adapters: TestAdapters = testAdapters,
) {
  return executeProjectTests(root, input, signal, adapters, "unit");
}
export async function integrationTestProject(
  root: string,
  input: unknown,
  signal = new AbortController().signal,
  adapters: TestAdapters = testAdapters,
): Promise<ProjectIntegrationTestResult> {
  const result = await executeProjectTests(root, input, signal, adapters, "integration");
  return { ...result, suite: "integration" };
}
export function testFailure(error: unknown, signal?: AbortSignal, suite: TestSuite = "unit") {
  return {
    suite,
    success: false,
    complete: false,
    cancelled: signal?.aborted ?? false,
    error: testIssue(signal?.aborted ? new TestError("cancelled", "Project test call cancelled") : error),
  };
}

async function hashMetadataFile(hash: ReturnType<typeof createHash>, path: string): Promise<void> {
  try {
    const value = await readFile(path);
    hash.update(JSON.stringify([path, value.length]));
    hash.update(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    hash.update(JSON.stringify([path, null]));
  }
}

interface TestCall {
  initial: TestTarget;
  request: TestRequest;
  signal: AbortSignal;
  adapters: TestAdapters;
  suite: TestSuite;
  outcome: TestOutcome;
}
interface PreparedExecution {
  target: TestTarget;
  request: TestRequest;
  signal: AbortSignal;
  suite: TestSuite;
  outcome: TestOutcome;
  current: LoadedConfig;
  receipt: TestReceipt;
  adapter: TestAdapter;
  policy: ReturnType<typeof suitePolicies>[TestSuite];
}
async function runLocked(call: TestCall): Promise<void> {
  const { initial, request, signal, adapters, suite, outcome } = call;
  const mode = outcome.mode;
  const target = await refreshTestTarget(initial.root, request.project_id, signal, suite);
  if (
    target.runner !== initial.runner ||
    JSON.stringify(testDomains(target.root, [target])) !== JSON.stringify(testDomains(initial.root, [initial]))
  ) {
    throw new TestError("scope-changed", "Project ownership or runner changed while waiting; call the test tool again");
  }
  const current = await loadConfig(target.root, { signal }),
    policy = suitePolicies(current, target.project.ecosystem, suite)[suite];
  const state = (await TestStateStore.load(target.root)).state,
    receipt = state.projects[request.project_id],
    adapter = adapters[target.runner];
  if (
    !adapter ||
    !receipt?.ready ||
    receipt.runner !== target.runner ||
    receipt.policy_hash !== testingPolicyKey(current, target.project.ecosystem)
  ) {
    throw new TestError("not-ready", "Selected project's test preparation is not ready");
  }
  await verifyAlignment(target, state, receipt);
  if (!(await adapter.verify({ target, tools: receipt.tools, signal }))) {
    throw new TestError("not-ready", "Native test tools changed after preparation");
  }
  if (!(await planTestProjection(target, current, receipt.native_configs)).current) {
    throw new TestError("not-ready", "Native test configuration changed after preparation");
  }
  outcome.runner_version = receipt.tools[target.runner] ?? null;
  outcome.coverage = coverageVerdict(mode, policy.coverage, target.runner === "go" ? "statements" : "lines");
  await executePrepared({ target, request, signal, suite, outcome, current, receipt, adapter, policy });
}

async function verifyAlignment(target: TestTarget, state: TestState, receipt: TestReceipt): Promise<void> {
  if (target.runner !== "pytest" && target.runner !== "vitest") {
    return;
  }
  const wave = state.waves[target.runner];
  const members = await runnerMembers(target);
  if (
    !wave?.complete ||
    JSON.stringify([...wave.projects].sort()) !== JSON.stringify(members.sort()) ||
    !sameVersions(wave.tools, receipt.tools)
  ) {
    throw new TestError("not-ready", "Common test runner alignment is incomplete");
  }
}

async function executePrepared(execution: PreparedExecution): Promise<void> {
  const { target, request, signal, suite, outcome, current } = execution;
  const started = performance.now(),
    deadline = testDeadline(request.timeout_seconds, signal);
  let artifacts: Awaited<ReturnType<typeof testArtifacts>> | undefined;
  try {
    const scope = await collectTestScope(
        target,
        suitePolicies(current, target.project.ecosystem, suite),
        request.test_files,
      ),
      before = await metadata(target);
    deadline.signal.throwIfAborted();
    artifacts = await testArtifacts(target.root);
    await runCollected(execution, scope, artifacts.path, deadline);
    deadline.signal.throwIfAborted();
    await verifyFreshness(execution, deadline.signal, scope, before);
    deadline.signal.throwIfAborted();
  } catch (error) {
    const issue = testIssue(deadline.signal.aborted ? deadline.signal.reason : error, request.project_id);
    if (deadline.signal.aborted) {
      outcome.errors = outcome.errors.filter((e) => e.code !== "cancelled" && e.code !== "timeout");
    }
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
}

async function runCollected(
  execution: PreparedExecution,
  scope: TestScope,
  artifactPath: string,
  deadline: ReturnType<typeof testDeadline>,
): Promise<void> {
  const { target, suite, outcome, receipt, adapter, policy } = execution;
  const mode = outcome.mode;
  if (!scope.selected.length && !(target.runner === "go" && scope.integration?.length)) {
    outcome.tests = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      cases: [],
    };
  } else {
    const native = await adapter.run({
      target,
      suite,
      tools: receipt.tools,
      signal: deadline.signal,
      policy,
      scope,
      mode,
      artifacts: artifactPath,
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
}

async function verifyFreshness(
  execution: PreparedExecution,
  signal: AbortSignal,
  scope: TestScope,
  before: string,
): Promise<void> {
  const { target, request, suite, current } = execution;
  const after = await refreshTestTarget(target.root, request.project_id, signal, suite);
  const latest = await loadConfig(target.root, {
    signal: signal,
  });
  if (
    after.runner !== target.runner ||
    before !== (await metadata(after)) ||
    current.testingKey !== latest.testingKey ||
    scope.fingerprint !==
      (await collectTestScope(after, suitePolicies(latest, after.project.ecosystem, suite), request.test_files))
        .fingerprint
  ) {
    throw new TestError(
      "sources-changed",
      "Project sources, ownership or test configuration changed during this run; run the test tool again",
    );
  }
}

async function runnerMembers(target: TestTarget): Promise<string[]> {
  const members: string[] = [];
  for (const project of target.structure.projects) {
    if (project.ecosystem !== target.project.ecosystem) {
      continue;
    }
    const member =
      project.project_id === target.project.project_id
        ? target
        : await resolveTestTarget(target.structure, project.project_id);
    if (member.runner === target.runner) {
      members.push(project.project_id);
    }
  }
  return members;
}
