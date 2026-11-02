export class TypecheckError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TypecheckError";
  }
}
export type TypecheckEcosystem = "python" | "javascript" | "go";
export type CheckStatus = "passed" | "failed" | "not-run" | "no-sources";
export type PreparationStatus = "unprepared" | "preparing" | "ready" | "outdated" | "failed";
export interface TypecheckDiagnostic {
  /** Origin project, including a dependency whose declaration generation failed. */
  project_id: string;
  /** Paths relative to the repository root and origin project, respectively. */
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
export interface TypecheckCheck {
  context?: { goos: string; goarch: string; build_tags: string[] };
  status: CheckStatus;
  tool: string;
  version: string | null;
  exit_code: number | null;
  duration_ms: number;
  diagnostics: TypecheckDiagnostic[];
  truncated: boolean;
  cancelled: boolean;
  reason?: string;
}
export interface PreparationChange {
  project_id: string;
  /** Root-relative path actually changed, including generated declarations. */
  path: string;
  kind: "created" | "updated" | "removed";
}
export interface TypecheckPreparation {
  status: PreparationStatus;
  action: "prepared" | "waited" | "already-ready" | "not-attempted";
  tools: Record<string, string>;
  affected_projects: string[];
  changes: PreparationChange[];
  diagnostics: TypecheckDiagnostic[];
  complete: boolean;
  cancelled: boolean;
  errors: { code: string; message: string; project_id?: string }[];
}
export interface TypecheckResult {
  project_id: string;
  relative_path: string;
  ecosystem: TypecheckEcosystem;
  policy_hash: string;
  success: boolean;
  preparation: TypecheckPreparation;
  checks: TypecheckCheck[];
  diagnostics: TypecheckDiagnostic[];
  complete: boolean;
  truncated: boolean;
  cancelled: boolean;
  partial_change: boolean;
  incomplete_stages: string[];
  remediation: string[];
}
