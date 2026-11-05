import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { object } from "../dependencies/inventory";
import { within } from "../dependencies/paths";
import { type FileSnapshot, readProjectionFile } from "../lint/files";
import { LintError } from "../lint/model";
import { type LintScope } from "../lint/scope";
import { type LintTarget } from "../lint/targets";
import { configObject } from "./edit";
import { BIOME_CONFIGS, type NativeSelection, selectNative } from "./selection";
export async function biomeLeaves(target: LintTarget, scope: LintScope): Promise<NativeSelection[]> {
  const root = await selectNative(target.root, target.scope.cwd, BIOME_CONFIGS, "biome.json");
  const directories = new Set<string>();
  for (const file of scope.files) {
    let directory = dirname(resolve(target.scope.cwd, file));
    while (directory !== target.scope.cwd && within(target.scope.cwd, directory)) {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  const leaves = [root];
  for (const directory of [...directories].sort()) {
    const selected = await selectNative(target.root, directory, BIOME_CONFIGS, "biome.json");
    if (selected.before.text !== null) {
      leaves.push(selected);
    }
  }
  return leaves;
}
function inheritedPaths(text: string, path: string): unknown[] {
  const config = configObject(text, path);
  if (config.extends === undefined) {
    return [];
  }
  return Array.isArray(config.extends) ? config.extends : [config.extends];
}
function resolveParent(value: unknown, path: string, rootPath: string): string {
  if (typeof value !== "string") {
    throw new LintError("unsupported-config", `Invalid Biome inheritance in ${path}`);
  }
  try {
    if (value === "//") {
      return rootPath;
    }
    if (value.startsWith(".") || value.startsWith("/")) {
      return resolve(dirname(path), value);
    }
    return createRequire(path).resolve(value);
  } catch {
    throw new LintError("unsupported-config", `Cannot resolve inherited Biome configuration ${value} from ${path}`);
  }
}
async function readParent(root: string, parent: string, path: string): Promise<FileSnapshot> {
  let snapshot: FileSnapshot;
  try {
    snapshot = await readProjectionFile(root, parent);
  } catch {
    throw new LintError(
      "unsupported-config",
      `Cannot safely read inherited Biome configuration ${parent} from ${path}`,
    );
  }
  if (snapshot.text === null) {
    throw new LintError("unsupported-config", `Missing inherited Biome configuration ${parent} from ${path}`);
  }
  return snapshot;
}
export async function biomeInputs(
  target: LintTarget,
  selected: NativeSelection,
  rootPath: string,
): Promise<{ path: string; before: FileSnapshot }[]> {
  const inputs = new Map<string, FileSnapshot>();
  const visit = async (path: string, before: FileSnapshot, seen: Set<string>) => {
    if (seen.has(path)) {
      throw new LintError("unsupported-config", `Cyclic Biome inheritance: ${path}`);
    }
    if (before.text === null) {
      return;
    }
    for (const value of inheritedPaths(before.text, path)) {
      const parent = resolveParent(value, path, rootPath),
        snapshot = await readParent(target.root, parent, path);
      inputs.set(parent, snapshot);
      await visit(parent, snapshot, new Set([...seen, path]));
    }
  };
  await visit(selected.path, selected.before, new Set());
  return [...inputs].map(([path, before]) => ({ path, before }));
}
function validateRuleGroup(group: string, value: unknown, policy: Record<string, unknown>, path: string): void {
  if (["preset", "recommended", "all"].includes(group)) {
    return;
  }
  for (const [rule, setting] of Object.entries(object(value))) {
    if (object(policy[group])[rule] === undefined && setting !== "off" && object(setting).level !== "off") {
      throw new LintError(
        "unsupported-config",
        `Inherited Biome rule ${group}.${rule} in ${path} must be moved to central policy or removed before native adoption`,
      );
    }
  }
}
/** Inherited rule controls must be represented by central policy before adopting the graph. */
export function validateBiomeInheritance(
  inputs: { path: string; before: FileSnapshot }[],
  desired: Record<string, unknown>,
): void {
  const policy = object(object(desired.linter).rules);
  for (const input of inputs) {
    const data = configObject(input.before.text ?? "{}", input.path),
      rules = object(object(data.linter).rules);
    for (const [group, value] of Object.entries(rules)) {
      validateRuleGroup(group, value, policy, input.path);
    }
    if (Array.isArray(data.overrides) && data.overrides.length) {
      throw new LintError(
        "unsupported-config",
        `Inherited Biome overrides in ${input.path} require explicit local adoption before managed rules can preserve their scope`,
      );
    }
  }
}
export function nestedBiomeScope(scope: LintScope, root: string, path: string): LintScope {
  const directory = dirname(path);
  if (directory === root) {
    return scope;
  }
  const prefix = relative(root, directory).replaceAll("\\", "/") + "/";
  return {
    ...scope,
    ignores: scope.ignores.map((pattern) =>
      pattern.startsWith(prefix) ? pattern.slice(prefix.length) : pattern.startsWith("**/") ? pattern : `../${pattern}`,
    ),
  };
}
