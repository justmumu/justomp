import { relative, resolve } from "node:path";
import { type ProcessResult, redact } from "../../dependencies/model";
import { within } from "../../dependencies/paths";
import type { TypecheckCheckContext } from "../adapters/types";
import {
  type TypecheckCheck,
  type TypecheckDiagnostic,
  TypecheckError,
} from "../model";

export function goProcessSucceeded(result: ProcessResult): boolean {
  return result.exit_code === 0 && !result.cancelled && !result.truncated;
}
export function assertGoSuccess(result: ProcessResult, message: string): void {
  if (!goProcessSucceeded(result))
    throw new TypecheckError(
      result.cancelled ? "cancelled" : "not-ready",
      redact(
        `${message}: ${result.stderr || result.stdout || `exit ${result.exit_code}`}${result.truncated ? " (output truncated)" : ""}`,
      ),
    );
}
export function goDiagnostics(
  context: TypecheckCheckContext,
  output: string,
): TypecheckDiagnostic[] {
  const result: TypecheckDiagnostic[] = [];
  const owners = context.target.structure.projects
    .filter((project) => project.ecosystem === "go")
    .sort((a, b) => b.path.length - a.path.length)
    .map((project) => ({
      project,
      root: resolve(context.target.root, project.path),
    }));
  for (const line of output.split(/\r?\n/)) {
    const match = /^(.+\.go):(\d+)(?::(\d+))?:\s*(.+)$/.exec(line);
    if (!match?.[1] || !match[2] || !match[4]) continue;
    const path = resolve(context.target.scope.cwd, match[1]);
    const origin =
      owners.find((owner) => within(owner.root, path))?.project ??
      context.target.project;
    result.push({
      project_id: origin.project_id,
      path: relative(context.target.root, path).replaceAll("\\", "/"),
      project_path: relative(
        resolve(context.target.root, origin.path),
        path,
      ).replaceAll("\\", "/"),
      line: Number(match[2]),
      ...(match[3] ? { column: Number(match[3]) } : {}),
      severity: "error",
      message: redact(match[4]),
    });
  }
  return result;
}
// Loader/toolchain failures can carry file positions too; they are not a complete
// compiler result. Missing dependencies remain an explicit dependency_sync task.
const unavailable =
  /^(?:.+\.go:\d+(?::\d+)?:\s*)?(?:go:|cgo:|missing go\.sum|updates to go\.(?:mod|sum)|module lookup disabled|no required module provides|cannot find (?:module|package)|cannot download|C compiler|C\+\+ compiler|exec:|permission denied|no space left|resource temporarily unavailable|signal:|build cache|error obtaining buildID|toolchain not available)/im;

/** Aggregate process state without letting a later clean package erase a failure. */
export function recordGoProcess(
  check: TypecheckCheck,
  result: ProcessResult,
): void {
  if (result.exit_code !== 0 || check.exit_code === null)
    check.exit_code = result.exit_code;
  check.truncated ||= result.truncated;
  check.cancelled ||= result.cancelled;
}
export function goCompileOutcome(
  context: TypecheckCheckContext,
  result: ProcessResult,
): {
  status: "passed" | "failed" | "not-run";
  diagnostics: TypecheckDiagnostic[];
  reason?: string;
} {
  const output = `${result.stderr}\n${result.stdout}`;
  const diagnostics = goDiagnostics(context, output);
  if (goProcessSucceeded(result)) return { status: "passed", diagnostics };
  if (
    result.cancelled ||
    result.truncated ||
    unavailable.test(output) ||
    !diagnostics.length
  )
    return {
      status: "not-run",
      diagnostics,
      reason: redact(
        `Go compilation did not complete; reconcile runtime/compiler availability or run dependency_sync for missing dependencies: ${output.trim() || `exit ${result.exit_code}`}${result.truncated ? " (output truncated)" : ""}`,
      ),
    };
  return { status: "failed", diagnostics };
}
