import { relative } from "node:path";
import { type FileSnapshot, publishProjectionFile, removeProjectionFile } from "../lint/files";
import { type NativeConfigOwnership } from "../native-config/ownership";
import { type PreparationChange } from "./model";
import { type TypecheckTarget } from "./targets";
export interface ProjectionFile {
  path: string;
  before: FileSnapshot;
  content: string;
  changed: boolean;
}
export interface ProjectionPlan {
  target: TypecheckTarget;
  files: ProjectionFile[];
  /** Native check configurations, including separate app/test contexts. */
  configs: { check: string[] };
  current: boolean;
  /** Captured native leaf/inheritance inputs for one check invocation. */
  input_fingerprint?: string;
  native_configs?: NativeConfigOwnership;
  retired?: { path: string; before: FileSnapshot }[];
}
/** Append each actual publication even if a later file fails. */
export async function applyProjection(
  plan: ProjectionPlan,
  changes: PreparationChange[] = [],
): Promise<PreparationChange[]> {
  for (const file of plan.files) {
    if (!file.changed) {
      continue;
    }
    await publishProjectionFile(plan.target.root, file.path, file.before, file.content);
    changes.push({
      project_id: plan.target.project.project_id,
      path: relative(plan.target.root, file.path).replaceAll("\\", "/"),
      kind: file.before.text === null ? "created" : "updated",
    });
  }
  return changes;
}

/** Retire owned legacy files only after native publication and receipt persistence. */
export async function retireProjection(
  plan: ProjectionPlan,
  changes: PreparationChange[] = [],
): Promise<PreparationChange[]> {
  for (const file of plan.retired ?? []) {
    await removeProjectionFile(plan.target.root, file.path, file.before);
    changes.push({
      project_id: plan.target.project.project_id,
      path: relative(plan.target.root, file.path).replaceAll("\\", "/"),
      kind: "removed",
    });
  }
  return changes;
}
