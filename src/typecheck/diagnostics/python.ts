import { relative, resolve } from "node:path";
import { object } from "../../dependencies/inventory";
import { type ProcessResult, redact } from "../../dependencies/model";
import type { TypecheckCheck, TypecheckDiagnostic } from "../model";
export interface PyrightLocation {
  root: string;
  cwd: string;
  project_id: string;
  version: string;
}
function diagnostics(
  context: PyrightLocation,
  stdout: string,
  expectedFiles: number,
): TypecheckDiagnostic[] {
  const data = object(JSON.parse(stdout)),
    summary = object(data.summary);
  if (
    data.version !== context.version ||
    !Array.isArray(data.generalDiagnostics) ||
    !Number.isInteger(summary.filesAnalyzed) ||
    Number(summary.filesAnalyzed) < expectedFiles ||
    !Number.isInteger(summary.errorCount) ||
    !Number.isInteger(summary.warningCount)
  )
    throw new Error("Pyright returned invalid JSON diagnostics");
  const diagnostics = data.generalDiagnostics.map(
    (value): TypecheckDiagnostic => {
      const item = object(value),
        range = object(item.range),
        start = object(range.start),
        end = object(range.end);
      if (
        typeof item.file !== "string" ||
        typeof item.message !== "string" ||
        !["error", "warning", "information"].includes(String(item.severity)) ||
        ![start.line, start.character, end.line, end.character].every(
          (v) => typeof v === "number" && Number.isInteger(v) && v >= 0,
        )
      )
        throw new Error("Pyright returned invalid JSON diagnostics");
      const file = resolve(context.cwd, item.file);
      return {
        project_id: context.project_id,
        path: relative(context.root, file).replaceAll("\\", "/"),
        project_path: relative(context.cwd, file).replaceAll("\\", "/"),
        line: Number(start.line) + 1,
        column: Number(start.character) + 1,
        end_line: Number(end.line) + 1,
        end_column: Number(end.character) + 1,
        severity:
          item.severity === "information"
            ? "info"
            : (item.severity as "error" | "warning"),
        message: redact(item.message),
        ...(typeof item.rule === "string" ? { rule: item.rule } : {}),
      };
    },
  );
  if (
    diagnostics.filter((d) => d.severity === "error").length !==
      summary.errorCount ||
    diagnostics.filter((d) => d.severity === "warning").length !==
      summary.warningCount
  )
    throw new Error("Pyright diagnostic summary is incomplete");
  return diagnostics;
}

export function pyrightOutput(
  context: PyrightLocation,
  result: ProcessResult,
  expectedFiles: number,
) {
  const check: Pick<
    TypecheckCheck,
    | "status"
    | "diagnostics"
    | "exit_code"
    | "truncated"
    | "cancelled"
    | "reason"
  > = {
    status: "not-run",
    diagnostics: [],
    exit_code: result.exit_code,
    truncated: result.truncated,
    cancelled: result.cancelled,
  };
  if (
    !result.truncated &&
    !result.cancelled &&
    (result.exit_code === 0 || result.exit_code === 1) &&
    !result.stderr.trim()
  ) {
    check.diagnostics = diagnostics(context, result.stdout, expectedFiles);
    check.status = check.diagnostics.some((d) => d.severity === "error")
      ? "failed"
      : "passed";
    if (result.exit_code === 1 && check.status === "passed") {
      check.status = "not-run";
      check.reason = "Pyright failed without error diagnostics";
    }
  } else
    check.reason = redact(
      result.stderr || result.stdout || "Pyright did not complete",
    );
  return check;
}
