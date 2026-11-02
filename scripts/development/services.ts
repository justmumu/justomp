import { loadConfig } from "../../src/config/load";
import { formatProject } from "../../src/format/service";
import { type HookInstallation } from "../../src/git-hooks/install";
import { checkLintTarget, fixLintTarget, inspectLintProject, prepareLintProjects } from "../../src/lint/service";
import { getPackagingStructure } from "../../src/packaging/get-structure";
import { installPrecommit } from "../../src/precommit/install";
import { installPrepush } from "../../src/prepush/install";
import { createPushOperations } from "../../src/prepush/operations";
import { runPrepush } from "../../src/prepush/service";
import { type TestSuite } from "../../src/testing/model";
import { suitePolicies } from "../../src/testing/policy";
import { collectTestScope } from "../../src/testing/scope";
import { integrationTestProject, testProject } from "../../src/testing/service";
import { resolveTestTarget } from "../../src/testing/targets";
import { typecheckProject } from "../../src/typecheck/service";
import { type DevelopmentCommand } from "./command";
import { ROOT_PROJECT_ID } from "./receipt";

export async function repositoryScope(root: string, suite: TestSuite, signal: AbortSignal) {
  const { structure } = await getPackagingStructure(root, { signal, publish: false });
  const project = structure.projects.find((item) => item.project_id === ROOT_PROJECT_ID);
  if (!structure.complete || !project || project.path !== "." || project.ecosystem !== "javascript") {
    throw new Error("Expected the repository root JavaScript project");
  }
  const target = await resolveTestTarget(structure, ROOT_PROJECT_ID, suite);
  const config = await loadConfig(root, { signal });
  return collectTestScope(target, suitePolicies(config, "javascript", suite));
}
async function setup(root: string, signal: AbortSignal) {
  const preparation = await createPushOperations().prepare(root, signal);
  const result = {
    success: false,
    complete: preparation.complete,
    preparation,
    hooks: [] as { stage: string; installation: HookInstallation }[],
    errors: [] as string[],
  };
  if (!preparation.success || !preparation.complete) {
    return result;
  }
  try {
    for (const [stage, install] of [
      ["pre-commit", installPrecommit],
      ["pre-push", installPrepush],
    ] as const) {
      signal.throwIfAborted();
      const installation = await install(root, signal);
      result.hooks.push({ stage, installation });
      if (installation.status !== "ready" && installation.status !== "installed") {
        result.errors.push(`${stage}: ${installation.message}; earlier hooks may already be installed`);
        return result;
      }
    }
    result.success = true;
  } catch (error) {
    result.complete = false;
    result.errors.push(
      `${error instanceof Error ? error.message : String(error)}; earlier hooks may already be installed`,
    );
  }
  return result;
}
async function lint(root: string, fix: boolean, signal: AbortSignal) {
  const target = await inspectLintProject(root, ROOT_PROJECT_ID, signal);
  const preparation = await prepareLintProjects(root, signal);
  return fix ? fixLintTarget(target, signal, preparation) : checkLintTarget(target, signal, preparation);
}
export function invokeDevelopment(root: string, command: DevelopmentCommand, signal: AbortSignal): Promise<unknown> {
  switch (command.action) {
    case "setup":
      return setup(root, signal);
    case "check":
      return runPrepush(root, signal);
    case "lint":
      return lint(root, false, signal);
    case "lint-fix":
      return lint(root, true, signal);
    case "format":
      return formatProject(root, ROOT_PROJECT_ID, { signal });
    case "typecheck":
      return typecheckProject(root, ROOT_PROJECT_ID, signal);
    case "test":
      return testProject(root, command.request, signal);
    case "integration":
      return integrationTestProject(root, command.request, signal);
  }
}
