import { lintPolicyKey } from "../config/lint/resolve";
import { loadConfig } from "../config/load";
import { getPackagingStructure } from "../packaging/get-structure";
import { goLintAdapter } from "./adapters/go";
import { javascriptAdapter } from "./adapters/javascript";
import { pythonAdapter } from "./adapters/python";
import { withReadyLintTarget } from "./coordinator";
import { applyLintFix, pendingLintFix } from "./fix";
import { BIOME_PACKAGE } from "./javascript/tools";
import { type LintCheck, LintError, type LintFix, type LintPreparation, type LintResult } from "./model";
import { type PreparationReport, preparationFailure, prepareLint } from "./prepare";
import { type LintOutcome, lintResult } from "./result";
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
export async function inspectLintProject(root: string, projectId: string, signal?: AbortSignal): Promise<LintTarget> {
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw new LintError("invalid-input", "project_id is required");
  }
  return resolveLintTarget(
    (await getPackagingStructure(root, { ...(signal === undefined ? {} : { signal }), publish: false })).structure,
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
interface LintRun extends LintOutcome {
  readyEntered: boolean;
}
function initialRun(id: string, report: PreparationReport | undefined, fix: LintFix | undefined): LintRun {
  const preparation: LintPreparation = report
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
  if (report) {
    preparation.tools = { ...report.projects[id]?.tools };
  }
  return {
    preparation,
    checks: [],
    policyHash: "",
    selectedReady: report?.projects[id]?.complete ?? !report,
    readyEntered: false,
    ...(fix ? { fix } : {}),
  };
}
function recordFailure(
  run: LintRun,
  error: unknown,
  id: string,
  signal: AbortSignal,
  report: PreparationReport | undefined,
): void {
  const issue = preparationFailure(error, id);
  const fix = run.fix;
  if (fix && run.readyEntered) {
    fix.errors.push({ code: issue.code, message: issue.message });
  } else {
    run.preparation.errors.push(issue);
  }
  if (fix && signal.aborted && fix.status !== "completed") {
    fix.status = "cancelled";
    fix.cancelled = true;
  }
  run.failure = issue.message;
  if (run.checks.length || (fix && run.readyEntered)) {
    return;
  }
  run.selectedReady = false;
  if (!report) {
    run.preparation = { ...run.preparation, status: "failed", complete: false, cancelled: signal.aborted };
  }
}
function unrunChecks(target: LintTarget, run: LintRun, signal: AbortSignal): LintCheck[] {
  const names =
    target.project.ecosystem === "python"
      ? ["ruff", "ruff"]
      : target.project.ecosystem === "go"
        ? ["golangci-lint", "golangci-lint"]
        : ["biome", "prettier"];
  return (["lint", "format"] as const).map((kind, index) => ({
    kind,
    status: "not-run",
    tool: names[index] ?? "",
    version: run.preparation.tools[names[index] === "biome" ? BIOME_PACKAGE : (names[index] ?? "")] ?? null,
    exit_code: null,
    duration_ms: 0,
    diagnostics: [],
    truncated: false,
    cancelled: signal.aborted,
    reason: run.failure ?? "Preparation did not complete",
  }));
}
/** Internal host entry retains selected identity/effects even if its wait was cancelled. */
async function runLintTarget(
  target: LintTarget,
  signal: AbortSignal,
  report?: PreparationReport,
  fix?: LintFix,
): Promise<LintResult> {
  const id = target.project.project_id;
  const run = initialRun(id, report, fix);
  try {
    signal.throwIfAborted();
    if (fix && report && !report.projects[id]?.complete) {
      throw new LintError("preparation-incomplete", "Selected project's preparation did not complete");
    }
    const policy = await loadConfig(target.root, { signal, flush: false });
    run.policyHash = lintPolicyKey(policy.lint[target.project.ecosystem]);
    if (!report) {
      const receipt = (await LintStateStore.load(target.root)).state.projects[id];
      run.preparation.tools = { ...receipt?.tools };
    }
    await withReadyLintTarget(
      target.root,
      id,
      lintAdapters,
      async (context) => {
        run.policyHash = lintPolicyKey(context.policy[context.target.project.ecosystem]);
        run.preparation.tools = { ...context.versions };
        if (!report) {
          run.preparation = { ...run.preparation, status: "ready", action: "already-ready", complete: true };
        }
        run.selectedReady = true;
        run.readyEntered = true;
        if (fix) {
          await applyLintFix(context, lintAdapters[context.target.project.ecosystem], fix);
        }
        run.checks = await lintAdapters[target.project.ecosystem].check(context);
      },
      signal,
    );
    if (report?.projects[id] && !report.projects[id]?.complete) {
      run.selectedReady = false;
      throw new LintError("preparation-incomplete", "Selected project's preparation did not complete");
    }
  } catch (error) {
    recordFailure(run, error, id, signal, report);
  }
  if (!run.checks.length) {
    run.checks = unrunChecks(target, run, signal);
  }
  return lintResult(target.project, run, signal.aborted);
}
/** Host check path: preparation effects are retained, sources are never fixed. */
export async function checkLintTarget(
  target: LintTarget,
  signal: AbortSignal,
  report?: PreparationReport,
): Promise<LintResult> {
  return await runLintTarget(target, signal, report);
}
/** Internal mutating entry; preparation stays outside the fix/check lease. */
export async function fixLintTarget(
  target: LintTarget,
  signal: AbortSignal,
  report?: PreparationReport,
): Promise<LintResult> {
  return await runLintTarget(target, signal, report, pendingLintFix(target.project.ecosystem));
}
/** Read-only check: no installation, defaults flush, state save or snapshot publication. */
export async function checkProjectLint(
  root: string,
  projectId: string,
  signal = new AbortController().signal,
): Promise<LintResult> {
  return checkLintTarget(await inspectLintProject(root, projectId, signal), signal);
}

/** Repository gate fixes first, formats next, then performs the final checks. */
export async function fixProjectLintOnly(root: string, projectId: string, signal: AbortSignal): Promise<LintFix> {
  const target = await inspectLintProject(root, projectId, signal);
  const fix = pendingLintFix(target.project.ecosystem);
  try {
    await withReadyLintTarget(
      root,
      projectId,
      lintAdapters,
      async (context) => {
        await applyLintFix(context, lintAdapters[context.target.project.ecosystem], fix);
      },
      signal,
    );
  } catch (error) {
    const issue = preparationFailure(error, projectId);
    fix.errors.push({ code: issue.code, message: issue.message });
    fix.status = signal.aborted ? "cancelled" : "failed";
  }
  return fix;
}
