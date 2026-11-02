import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parse } from "smol-toml";
import { resolveManagerScope } from "../dependencies/executable";
import { safePath, within } from "../dependencies/paths";
import { validateExistingSources } from "../dependencies/source-boundaries";
import { type PackagingStructure, type Project } from "../inspect/model";
import { detectRunner, integrationRunnerEvidence } from "./detect";
import { TestError, type TestRunner, type TestSuite } from "./model";
export interface TestTarget {
  root: string;
  project: Project;
  structure: PackagingStructure;
  scope: Awaited<ReturnType<typeof resolveManagerScope>>;
  runner: TestRunner;
  configFile?: string;
}
export async function resolveTestTarget(
  structure: PackagingStructure,
  id: string,
  suite: TestSuite = "unit",
): Promise<TestTarget> {
  if (!structure.complete) {
    throw new TestError("incomplete-inspection", "Testing requires a complete inspection");
  }
  const project = structure.projects.find((p) => p.project_id === id);
  if (!project) {
    throw new TestError("project-not-found", `Unknown project_id: ${id}`);
  }
  const root = await realpath(structure.root);
  const manifestPath = await safePath(root, project.manifest);
  const text = await readFile(manifestPath, "utf8");
  const manifest =
    project.ecosystem === "javascript" ? JSON.parse(text) : project.ecosystem === "python" ? parse(text) : {};
  const runner = detectRunner(project.ecosystem, manifest, await readdir(resolve(root, project.path)));
  const configFile = await integrationConfigFile(structure, project, root, manifest, runner, suite);
  await validateExistingSources(root, project, structure);
  return {
    root,
    project,
    structure,
    runner,
    ...(configFile ? { configFile } : {}),
    scope: await resolveManagerScope(root, project, structure.projects),
  };
}

async function integrationConfigFile(
  structure: PackagingStructure,
  project: Project,
  root: string,
  manifest: Record<string, unknown>,
  runner: TestRunner,
  suite: TestSuite,
): Promise<string | undefined> {
  let configFile: string | undefined;
  if (suite === "integration" && project.ecosystem === "javascript") {
    const selected = integrationRunnerEvidence(manifest, runner);
    if (selected !== undefined) {
      const cwd = await realpath(resolve(root, project.path));
      if (isAbsolute(selected) || selected.split("/").includes("..")) {
        throw new TestError("invalid-config", "Integration config must stay inside its project");
      }
      const resolvedConfig = await realpath(await safePath(root, resolve(cwd, selected)));
      configFile = resolvedConfig;
      validateConfigOwnership(structure, project, root, cwd, resolvedConfig);
      await readFile(configFile);
    }
  }
  return configFile;
}

function validateConfigOwnership(
  structure: PackagingStructure,
  project: Project,
  root: string,
  cwd: string,
  resolvedConfig: string,
): void {
  if (
    !within(cwd, resolvedConfig) ||
    structure.projects.some(
      (p) =>
        p.project_id !== project.project_id &&
        p.path !== project.path &&
        within(cwd, resolve(root, p.path)) &&
        within(resolve(root, p.path), resolvedConfig),
    )
  ) {
    throw new TestError("invalid-config", "Integration config belongs outside the selected project");
  }
}
