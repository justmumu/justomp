import { redact } from "../dependencies/model";
import { type PreparationChange } from "../lint/model";
import { type Formatter } from "./model";

export interface FormatIssue {
  code: string;
  message: string;
  path?: string;
}
export interface FormatFileResult {
  path: string;
  engine: Formatter["engine"];
  status: "changed" | "unchanged" | "failed" | "not-run";
  /** A failed native invocation may have written before failing. */
  changed?: boolean;
  error?: FormatIssue;
}
export interface FormatResult {
  success: boolean;
  complete: boolean;
  cancelled: boolean;
  project_id: string;
  relative_path: string | null;
  selection: "all" | "explicit";
  requested_files?: readonly string[];
  files: FormatFileResult[];
  formatters: { engine: Formatter["engine"]; version: string }[];
  preparation_changes: PreparationChange[];
  affected_projects: string[];
  errors: FormatIssue[];
  duration_ms: number;
  summary: "no-files" | "formatted" | "incomplete";
}
export function formatIssue(error: unknown, code = "format-failed"): FormatIssue {
  return {
    code: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : code,
    message: redact(error instanceof Error ? error.message : String(error)),
  };
}
export function finishFormat(result: FormatResult, started: number, cancelled: boolean): FormatResult {
  result.affected_projects = [...new Set(result.affected_projects)].sort();
  result.cancelled = cancelled;
  result.complete =
    !cancelled &&
    !result.errors.length &&
    result.files.every((file) => file.status === "changed" || file.status === "unchanged");
  result.success = result.complete;
  result.summary = !result.complete ? "incomplete" : result.files.length ? "formatted" : "no-files";
  result.duration_ms = Math.round(performance.now() - started);
  return result;
}
