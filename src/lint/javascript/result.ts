import { relative, resolve } from "node:path";
import { object } from "../../dependencies/inventory";
import { type ProcessResult, redact } from "../../dependencies/model";
import { within } from "../../dependencies/paths";
import { type LintCheckContext } from "../adapters/types";
import { type LintDiagnostic, LintError } from "../model";

/** Require a completed native traversal; exit 1 alone also covers configuration failures. */
export function biomeDiagnostics(
  context: LintCheckContext,
  result: ProcessResult,
  selectedFiles: readonly string[],
): LintDiagnostic[] {
  const fail = (reason: string): never => {
    throw new LintError("native-check-incomplete", `Biome ${reason}`);
  };
  if (result.cancelled || result.truncated || ![0, 1].includes(result.exit_code ?? -1)) {
    fail("did not complete");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    fail("returned invalid JSON diagnostics");
  }
  const report = object(raw),
    summary = object(report.summary);
  const counts = ["changed", "unchanged", "errors", "warnings", "infos", "skipped", "diagnosticsNotPrinted"];
  if (
    report.command !== "check" ||
    !Array.isArray(report.diagnostics) ||
    counts.some((key) => !Number.isInteger(summary[key]) || Number(summary[key]) < 0)
  ) {
    fail("returned an unsupported report shape");
  }
  if (summary.skipped !== 0 || summary.diagnosticsNotPrinted !== 0) {
    fail("skipped files or diagnostics; traversal is incomplete");
  }
  if (Number(summary.changed) + Number(summary.unchanged) === 0) {
    fail("did not process any selected sources");
  }
  const selectedPaths = new Set(selectedFiles.map((file) => resolve(context.target.scope.cwd, file)));
  if (Number(summary.changed) + Number(summary.unchanged) !== selectedPaths.size) {
    fail("did not process every selected source");
  }
  const diagnostics = (report.diagnostics as unknown[]).map((raw): LintDiagnostic => {
    const item = object(raw);
    if (
      typeof item.message !== "string" ||
      typeof item.category !== "string" ||
      !["error", "warning", "info", "fatal"].includes(String(item.severity))
    ) {
      fail("returned invalid diagnostic fields");
    }
    const category = item.category as string;
    if (!(
      category.startsWith("lint/") ||
      category === "assist/source/organizeImports" ||
      category === "parse" ||
      category.startsWith("parse/")
    )) {
      fail(`reported an execution/configuration diagnostic (${category})`);
    }
    const location = object(item.location);
    const path = typeof location.path === "string" ? resolve(context.target.scope.cwd, location.path) : undefined;
    const owned =
      path && selectedPaths.has(path) && within(context.target.root, path) && within(context.target.scope.cwd, path);
    // Reporter coordinates are native one-based positions; omit absent/invalid locations.
    const start = object(location.start),
      end = object(location.end);
    const position = (value: unknown) => Number.isInteger(value) && Number(value) > 0;
    return {
      kind: "lint",
      severity: item.severity === "fatal" ? "error" : (item.severity as LintDiagnostic["severity"]),
      rule: category,
      message: redact(item.message as string),
      ...(owned
        ? {
            path: relative(context.target.root, path).replaceAll("\\", "/"),
            project_path: relative(context.target.scope.cwd, path).replaceAll("\\", "/"),
            ...(position(start.line) && position(start.column)
              ? { line: Number(start.line), column: Number(start.column) }
              : {}),
            ...(position(end.line) && position(end.column)
              ? { end_line: Number(end.line), end_column: Number(end.column) }
              : {}),
          }
        : {}),
    };
  });
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.filter((d) => d.severity === "warning").length;
  const infos = diagnostics.filter((d) => d.severity === "info").length;
  if (
    errors !== summary.errors ||
    warnings !== summary.warnings ||
    infos !== summary.infos ||
    (result.exit_code === 0 && errors > 0) ||
    (result.exit_code === 1 && errors === 0 && warnings === 0)
  ) {
    fail("returned inconsistent diagnostic totals");
  }
  return diagnostics;
}
