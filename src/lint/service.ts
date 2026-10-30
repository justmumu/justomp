import { lintPolicyKey } from "../config/lint/resolve";
import { loadConfig } from "../config/load";
import { getPackagingStructure } from "../packaging/get-structure";
import { goLintAdapter } from "./adapters/go";
import { javascriptAdapter } from "./adapters/javascript";
import { pythonAdapter } from "./adapters/python";
import { withReadyLintTarget } from "./coordinator";
import {
  type LintCheck,
  LintError,
  type LintPreparation,
  type LintResult,
} from "./model";
import {
  type PreparationReport,
  preparationFailure,
  prepareLint,
} from "./prepare";
import { lintResult } from "./result";
import { LintStateStore } from "./state";
import { type LintTarget, resolveLintTarget } from "./targets";

export const lintAdapters = {
  python: pythonAdapter,
  javascript: javascriptAdapter,
  go: goLintAdapter,
};
/** Explicit setup. Check-only callers use checkProjectLint instead. */
export async function prepareLintProjects(
  root: string,
  signal = new AbortController().signal,
): Promise<PreparationReport> {
  await loadConfig(root, { flush: true, signal });
  return prepareLint(root, lintAdapters, signal);
}
/** Resolves an ID without native commands or any config/snapshot publication. */
export async function inspectLintProject(
  root: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<LintTarget> {
  if (typeof projectId !== "string" || !projectId.trim())
    throw new LintError("invalid-input", "project_id is required");
  return resolveLintTarget(
    (await getPackagingStructure(root, { signal, publish: false })).structure,
    projectId,
  );
}
export function lintFailure(error: unknown, signal?: AbortSignal) {
  return {
    success: false,
    complete: false,
    cancelled: signal?.aborted ?? false,
    error: preparationFailure(error),
  };
}
/** Internal host entry retains selected identity/effects even if its wait was cancelled. */
export async function checkLintTarget(
  target: LintTarget,
  signal: AbortSignal,
  report?: PreparationReport,
): Promise<LintResult> {
  const id = target.project.project_id;
  let preparation: LintPreparation = report
    ? structuredClone(report)
    : {
        status: "unprepared",
        action: "not-attempted",
        tools: {},
        affected_projects: [id],
        changes: [],
        complete: false,
        cancelled: false,
        errors: [],
      };
  // Overall setup effects remain visible; tool versions belong to the selected project.
  if (report) preparation.tools = { ...report.projects[id]?.tools };
  let checks: LintCheck[] = [],
    policyHash = "",
    failure: string | undefined;
  let selectedReady = report?.projects[id]?.complete ?? !report;
  try {
    signal.throwIfAborted();
    const policy = await loadConfig(target.root, { signal, flush: false });
    policyHash = lintPolicyKey(policy.lint[target.project.ecosystem]);
    if (!report) {
      const receipt = (await LintStateStore.load(target.root)).state.projects[
        id
      ];
      preparation.tools = { ...receipt?.tools };
    }
    await withReadyLintTarget(
      target.root,
      id,
      lintAdapters,
      async (context) => {
        policyHash = lintPolicyKey(
          context.policy[context.target.project.ecosystem],
        );
        preparation.tools = { ...context.versions };
        if (!report)
          preparation = {
            ...preparation,
            status: "ready",
            action: "already-ready",
            complete: true,
          };
        selectedReady = true;
        checks = await lintAdapters[target.project.ecosystem].check(context);
      },
      signal,
    );
    if (report?.projects[id] && !report.projects[id]?.complete) {
      selectedReady = false;
      throw new LintError(
        "preparation-incomplete",
        "Selected project's preparation did not complete",
      );
    }
  } catch (error) {
    const issue = preparationFailure(error, id);
    preparation.errors.push(issue);
    failure = issue.message;
    if (!checks.length) {
      selectedReady = false;
      if (!report)
        preparation = {
          ...preparation,
          status: "failed",
          complete: false,
          cancelled: signal.aborted,
        };
    }
  }
  if (!checks.length) {
    const names =
      target.project.ecosystem === "python"
        ? ["ruff", "ruff"]
        : target.project.ecosystem === "go"
          ? ["golangci-lint", "golangci-lint"]
          : ["eslint", "prettier"];
    checks = (["lint", "format"] as const).map((kind, index) => ({
      kind,
      status: "not-run",
      tool: names[index] ?? "",
      version: preparation.tools[names[index] ?? ""] ?? null,
      exit_code: null,
      duration_ms: 0,
      diagnostics: [],
      truncated: false,
      cancelled: signal.aborted,
      reason: failure ?? "Preparation did not complete",
    }));
  }
  return lintResult(
    target.project,
    {
      preparation,
      checks,
      policyHash,
      selectedReady,
      ...(failure ? { failure } : {}),
    },
    signal.aborted,
  );
}
/** Read-only check: no installation, defaults flush, state save or snapshot publication. */
export async function checkProjectLint(
  root: string,
  projectId: string,
  signal = new AbortController().signal,
): Promise<LintResult> {
  return checkLintTarget(
    await inspectLintProject(root, projectId, signal),
    signal,
  );
}
