import { realpath } from "node:fs/promises";
import { resolveManagerScope } from "../dependencies/executable";
import { safePath } from "../dependencies/paths";
import { validateExistingSources } from "../dependencies/source-boundaries";
import { type PackagingStructure, type Project } from "../inspect/model";
import { TypecheckError } from "./model";

export interface TypecheckTarget {
  root: string;
  project: Project;
  structure: PackagingStructure;
  scope: Awaited<ReturnType<typeof resolveManagerScope>>;
}
/** Resolve again under the manager lease before preparing or checking. */
export async function resolveTypecheckTarget(
  structure: PackagingStructure,
  projectId: string,
): Promise<TypecheckTarget> {
  if (!structure.complete) {
    throw new TypecheckError("incomplete-inspection", "Typecheck requires a complete project inspection");
  }
  const project = structure.projects.find((p) => p.project_id === projectId);
  if (!project) {
    throw new TypecheckError("project-not-found", `Unknown project_id: ${projectId}`);
  }
  const root = await realpath(structure.root);
  await safePath(root, project.manifest);
  await validateExistingSources(root, project, structure);
  return {
    root,
    project,
    structure,
    scope: await resolveManagerScope(root, project, structure.projects),
  };
}
