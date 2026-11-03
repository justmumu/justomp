import { type ProcessResult } from "../dependencies/model";
import { type Project } from "../inspect/model";
export class ReleaseError extends Error {
  override name = "ReleaseError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface ReleaseParticipant {
  project_id: string;
  path: string;
  manifest: string;
  ecosystem: Project["ecosystem"];
  version: string | null;
  kind: "static" | "versionless" | "repository-version";
}
export interface ReleaseStep {
  owner: string;
  executable: string;
  args: string[];
  result: ProcessResult;
}
export interface ReleaseResult {
  success: boolean;
  status: "success" | "rejected" | "failed" | "cancelled" | "partial_change";
  root: string;
  cancelled: boolean;
  changed_files: string[];
  affected_projects: string[];
  participants: ReleaseParticipant[];
  native_steps: ReleaseStep[];
  diagnostics: { code: string; message: string }[];
  previous_version?: string;
  target_version?: string;
  base_commit?: string | null;
  end_commit?: string;
  included_commits?: string[];
  skipped_commits?: string[];
  changelog_file?: string;
  manual_unreleased?: boolean;
  tag?: string;
  created?: boolean | null;
  observed_target?: string | null;
  default_branch?: string;
}
