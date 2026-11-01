export type GateCheckStage =
  | "fix"
  | "format"
  | "lint"
  | "typecheck"
  | "dependency";
export interface GateStage {
  stage: GateCheckStage | "preparation";
  project_id?: string;
  success: boolean;
  complete: boolean;
  effects: string[];
  affected_projects: string[];
  details: unknown;
}
export interface PrecommitResult {
  success: boolean;
  complete: boolean;
  cancelled: boolean;
  selected_projects: string[];
  preparation_projects: string[];
  stages: GateStage[];
  changed_files: string[];
  staged_files: string[];
  errors: string[];
}
