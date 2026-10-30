export class LintError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LintError";
  }
}
export type LintEcosystem = "python" | "javascript" | "go";
export type CheckKind = "lint" | "format";
export type CheckStatus = "passed" | "failed" | "not-run" | "no-sources";
export type PreparationStatus =
  | "unprepared"
  | "preparing"
  | "ready"
  | "outdated"
  | "failed";
export interface LintDiagnostic {
  kind: CheckKind;
  /** Paths are relative to the repository root and the selected project. */
  path?: string;
  project_path?: string;
  line?: number;
  column?: number;
  end_line?: number;
  end_column?: number;
  rule?: string;
  severity: "error" | "warning" | "info";
  message: string;
}
export interface LintCheck {
  kind: CheckKind;
  status: CheckStatus;
  tool: string;
  version: string | null;
  exit_code: number | null;
  duration_ms: number;
  diagnostics: LintDiagnostic[];
  truncated: boolean;
  cancelled: boolean;
  reason?: string;
}
export interface PreparationChange {
  project_id: string;
  /** Root-relative metadata path actually changed by preparation. */
  path: string;
  kind: "created" | "updated" | "removed";
}
export interface LintPreparation {
  status: PreparationStatus;
  action: "prepared" | "waited" | "already-ready" | "not-attempted";
  tools: Record<string, string>;
  affected_projects: string[];
  changes: PreparationChange[];
  complete: boolean;
  cancelled: boolean;
  errors: { code: string; message: string; project_id?: string }[];
}
export interface LintResult {
  project_id: string;
  relative_path: string;
  ecosystem: LintEcosystem;
  policy_hash: string;
  success: boolean;
  preparation: LintPreparation;
  checks: LintCheck[];
  diagnostics: LintDiagnostic[];
  complete: boolean;
  truncated: boolean;
  cancelled: boolean;
  partial_change: boolean;
  incomplete_stages: string[];
  remediation: string[];
}
