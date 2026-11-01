export type PushCheckStage =
  | "dependency"
  | "format"
  | "lint"
  | "typecheck"
  | "unit";
export interface PushStage {
  stage: string;
  project_id?: string;
  success: boolean;
  complete: boolean;
  effects: string[];
  details: unknown;
}
export interface PrepushResult {
  success: boolean;
  complete: boolean;
  cancelled: boolean;
  summary: "passed" | "failed" | "incomplete" | "no-projects";
  selected_projects: string[];
  stages: PushStage[];
  changed_files: string[];
  errors: string[];
}
