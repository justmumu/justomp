import { relative, resolve } from "node:path";
import { object } from "../../dependencies/inventory";
import { type ProcessResult, redact } from "../../dependencies/model";
import { within } from "../../dependencies/paths";
import { type LintCheckContext } from "../adapters/types";
import { type CheckKind, type LintCheck, type LintDiagnostic, LintError } from "../model";

function diagnostics(context: LintCheckContext, output: string): LintDiagnostic[] {
  const data = object(JSON.parse(output));
  if (data.Issues !== null && !Array.isArray(data.Issues)) {
    throw new LintError("invalid-output", "Go lint did not return its JSON issue list");
  }
  return ((data.Issues ?? []) as unknown[]).map((raw) => {
    const issue = object(raw),
      position = object(issue.Pos);
    if (typeof issue.FromLinter !== "string" || typeof issue.Text !== "string") {
      throw new LintError("invalid-output", "Go lint returned an invalid issue");
    }
    const path = typeof position.Filename === "string" ? resolve(context.target.scope.cwd, position.Filename) : null;
    const kind: CheckKind = context.policy.go.golangci.formatters.enable.includes(issue.FromLinter) ? "format" : "lint";
    return {
      kind,
      rule: issue.FromLinter,
      message: redact(issue.Text),
      severity:
        issue.Severity === "warning" || issue.Severity === "warn"
          ? "warning"
          : issue.Severity === "info"
            ? "info"
            : "error",
      ...(path && within(context.target.scope.cwd, path) && within(context.target.root, path)
        ? {
            path: relative(context.target.root, path).replaceAll("\\", "/"),
            project_path: relative(context.target.scope.cwd, path).replaceAll("\\", "/"),
          }
        : {}),
      ...(typeof position.Line === "number" ? { line: position.Line } : {}),
      ...(typeof position.Column === "number" ? { column: position.Column } : {}),
    };
  });
}
/** Map one complete native response to the two independently reported checks. */
export function applyGoLintResult(context: LintCheckContext, checks: LintCheck[], result: ProcessResult): void {
  for (const check of checks) {
    check.exit_code = result.exit_code;
    check.cancelled = result.cancelled;
    check.truncated = result.truncated;
  }
  if (!result.cancelled && !result.truncated && (result.exit_code === 0 || result.exit_code === 1)) {
    const issues = diagnostics(context, result.stdout);
    if (result.exit_code === 1 && !issues.length) {
      throw new LintError("invalid-output", "Go lint failed without complete JSON diagnostics");
    }
    for (const check of checks) {
      check.diagnostics = issues.filter((issue) => issue.kind === check.kind);
      if (issues.some((issue) => issue.rule === "typecheck")) {
        check.status = "not-run";
        check.reason =
          "Go type analysis could not complete; fix the reported compiler diagnostics before lint and format checks can complete";
      } else {
        check.status = check.diagnostics.length ? "failed" : "passed";
      }
    }
  } else {
    for (const check of checks) {
      check.reason = redact(result.stderr || `Go lint did not complete (exit ${result.exit_code})`);
    }
  }
}

/** A bounded dependency probe must finish before either lint stage can run. */
export function applyGoReadiness(checks: LintCheck[], ready: ProcessResult): void {
  for (const check of checks) {
    check.exit_code = ready.exit_code;
    check.truncated = ready.truncated;
    check.cancelled = ready.cancelled;
  }
  if (ready.exit_code !== 0 || ready.truncated || ready.cancelled) {
    throw new LintError(
      ready.cancelled ? "cancelled" : "not-ready",
      redact(
        `Go dependencies are not ready; run dependency_sync explicitly: ${ready.stderr || ready.stdout || `exit ${ready.exit_code}`}${ready.truncated ? " (truncated)" : ""}`,
      ),
    );
  }
}
