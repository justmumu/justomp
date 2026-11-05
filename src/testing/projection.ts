import { basename, join, relative } from "node:path";
import { type LoadedConfig } from "../config/load";
import { type EcosystemTestPolicy } from "../config/test/model";
import { equivalentConfig } from "../format/readiness";
import { type FileSnapshot, publishProjectionFile, readProjectionFile } from "../lint/files";
import { editNativeConfig } from "../native-config/edit";
import { type NativeConfigEntry, type NativeConfigOwnership } from "../native-config/ownership";
import { bunConfig } from "./javascript/config";
import { findVitestConfig } from "./javascript/native-config";
import { type TestPreparation } from "./model";
import { coveragePolicy, editCoverageIni, findCoverageConfig } from "./python/native-config";
import { resolveTestTarget, type TestTarget } from "./targets";

interface TestProjectionFile {
  path: string;
  before: FileSnapshot;
  content: string;
  changed: boolean;
}
export interface TestProjectionPlan {
  target: TestTarget;
  files: TestProjectionFile[];
  ownership: NativeConfigOwnership;
  current: boolean;
}
function vitestPolicy(policy: EcosystemTestPolicy) {
  return {
    test: {
      include: policy.include,
      exclude: policy.exclude,
      includeSource: [],
      watch: false,
      retry: 0,
      repeats: 0,
      bail: 0,
      coverage: {
        enabled: policy.coverage.enabled,
        provider: "v8",
        include: policy.source.include,
        exclude: policy.source.exclude,
        reporter: ["json"],
        reportOnFailure: true,
        thresholds: { lines: policy.coverage.minimum, branches: 0, functions: 0, statements: 0, perFile: false },
        clean: true,
      },
      typecheck: { enabled: false },
    },
  };
}
interface NativeTestConfig {
  path: string;
  role: string;
  desired: Record<string, unknown>;
  prefix: string[];
}
function configParser(path: string): "toml" | "typescript" | "babel" {
  if (path.endsWith(".toml")) {
    return "toml";
  }
  return /\.[cm]?ts$/.test(path) ? "typescript" : "babel";
}
function previousFields(previous: NativeConfigOwnership | undefined, key: string, role: string): string[][] {
  const fields = [...(previous?.configs.find((entry) => entry.path === key && entry.role === role)?.fields ?? [])];
  if (role === "bun") {
    // Explicit false disables even CLI --coverage in supported Bun releases; absence is native default-off.
    fields.push(["test", "rerunEach"], ["test", "coverage"]);
  }
  return fields;
}
function editTestConfig(definition: NativeTestConfig, before: FileSnapshot, fields: string[][]) {
  const { path, role, desired, prefix } = definition;
  if (role === "coverage" && !path.endsWith(".toml")) {
    return editCoverageIni(
      before.text ?? "",
      desired as ReturnType<typeof coveragePolicy>,
      basename(path) === ".coveragerc" ? "" : "coverage:",
      fields,
      path,
    );
  }
  return editNativeConfig(before.text, path, desired, fields, prefix);
}
async function planFile(
  target: TestTarget,
  definition: NativeTestConfig,
  previous: NativeConfigOwnership | undefined,
): Promise<{ file: TestProjectionFile; ownership: NativeConfigEntry }> {
  const { path, role } = definition;
  const before = await readProjectionFile(target.root, path);
  const key = relative(target.root, path).replaceAll("\\", "/");
  const updated = editTestConfig(definition, before, previousFields(previous, key, role));
  const ini = role === "coverage" && !path.endsWith(".toml");
  const changed = ini
    ? before.text !== updated.content
    : !(await equivalentConfig(before.text, updated.content, configParser(path)));
  return {
    file: { path, before, content: changed ? updated.content : (before.text ?? updated.content), changed },
    ownership: { role, path: key, fields: updated.fields },
  };
}
async function nativeTestConfig(
  target: TestTarget,
  policy: EcosystemTestPolicy,
): Promise<NativeTestConfig | undefined> {
  switch (target.runner) {
    case "pytest": {
      const path = await findCoverageConfig(target);
      return {
        path,
        role: "coverage",
        desired: coveragePolicy(policy),
        prefix: path.endsWith(".toml") ? ["tool", "coverage"] : [],
      };
    }
    case "bun":
      return {
        path: target.configFile ?? join(target.scope.cwd, "bunfig.toml"),
        role: "bun",
        desired: { test: bunConfig({}).test },
        prefix: [],
      };
    case "vitest":
      return { path: await findVitestConfig(target), role: "vitest", desired: vitestPolicy(policy), prefix: [] };
    default:
      return undefined;
  }
}
async function configurationTargets(target: TestTarget, config: LoadedConfig) {
  const { configFile: _configFile, ...defaultTarget } = target;
  const selected = [{ target: defaultTarget, policy: config.test[target.project.ecosystem] }];
  if (target.runner === "bun" || target.runner === "vitest") {
    const integration = target.configFile
      ? target
      : await resolveTestTarget(target.structure, target.project.project_id, "integration");
    if (integration.configFile) {
      selected.push({ target: integration, policy: config.integrationTest[target.project.ecosystem] });
    }
  }
  return selected;
}
/** Resolve native policy without publishing; callers use it for preparation and read-only readiness. */
export async function planTestProjection(
  target: TestTarget,
  config: LoadedConfig,
  previous?: NativeConfigOwnership,
): Promise<TestProjectionPlan> {
  const files: TestProjectionFile[] = [],
    configs: NativeConfigEntry[] = [];
  // The default file always carries unit policy; a separate integration file carries its own policy.
  for (const selected of await configurationTargets(target, config)) {
    const definition = await nativeTestConfig(selected.target, selected.policy);
    if (!definition || files.some((file) => file.path === definition.path)) {
      continue;
    }
    const planned = await planFile(target, definition, previous);
    files.push(planned.file);
    configs.push(planned.ownership);
  }
  return { target, files, ownership: { version: 1, configs }, current: files.every((file) => !file.changed) };
}
export async function applyTestProjection(
  plan: TestProjectionPlan,
  changes: TestPreparation["changes"],
): Promise<void> {
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
}
