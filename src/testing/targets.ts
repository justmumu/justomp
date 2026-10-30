import { readdir, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "smol-toml";
import { resolveManagerScope } from "../dependencies/executable";
import { safePath } from "../dependencies/paths";
import { validateExistingSources } from "../dependencies/source-boundaries";
import type { PackagingStructure, Project } from "../inspect/model";
import { detectRunner } from "./detect";
import { TestError, type TestRunner } from "./model";
export interface TestTarget {
  root: string;
  project: Project;
  structure: PackagingStructure;
  scope: Awaited<ReturnType<typeof resolveManagerScope>>;
  runner: TestRunner;
}
export async function resolveTestTarget(
  structure: PackagingStructure,
  id: string,
): Promise<TestTarget> {
  if (!structure.complete)
    throw new TestError(
      "incomplete-inspection",
      "Testing requires a complete inspection",
    );
  const project = structure.projects.find((p) => p.project_id === id);
  if (!project)
    throw new TestError("project-not-found", `Unknown project_id: ${id}`);
  const root = await realpath(structure.root);
  const manifestPath = await safePath(root, project.manifest);
  const text = await readFile(manifestPath, "utf8");
  const manifest =
    project.ecosystem === "javascript"
      ? JSON.parse(text)
      : project.ecosystem === "python"
        ? parse(text)
        : {};
  const runner = detectRunner(
    project.ecosystem,
    manifest,
    await readdir(resolve(root, project.path)),
  );
  await validateExistingSources(root, project, structure);
  return {
    root,
    project,
    structure,
    runner,
    scope: await resolveManagerScope(root, project, structure.projects),
  };
}
