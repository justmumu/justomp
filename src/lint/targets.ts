import { realpath } from "node:fs/promises";
import { resolveManagerScope } from "../dependencies/executable";
import { safePath } from "../dependencies/paths";
import { validateExistingSources } from "../dependencies/source-boundaries";
import { type PackagingStructure, type Project } from "../inspect/model";
import { LintError } from "./model";

export interface LintTarget {
  root: string;
  project: Project;
  structure: PackagingStructure;
  scope: Awaited<ReturnType<typeof resolveManagerScope>>;
}
/** Resolve again under the manager lease before preparing or checking. */
export async function resolveLintTarget(structure: PackagingStructure, projectId: string): Promise<LintTarget> {
  if (!structure.complete) {
    throw new LintError("incomplete-inspection", "Lint requires a complete project inspection");
  }
  const project = structure.projects.find((p) => p.project_id === projectId);
  if (!project) {
    throw new LintError("project-not-found", `Unknown project_id: ${projectId}`);
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
