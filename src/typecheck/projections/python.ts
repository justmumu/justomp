import { dirname, join, relative, resolve } from "node:path";
import { parse } from "smol-toml";
import { type TypecheckPolicy } from "../../config/typecheck/model";
import { object } from "../../dependencies/inventory";
import { equivalentConfig, hasProjectionMarker } from "../../format/readiness";
import { readProjectionFile } from "../../lint/files";
import { configObject, editNativeConfig } from "../../native-config/edit";
import { reconcileFields } from "../../native-config/ownership";
import { contentHash } from "../freshness";
import { TypecheckError } from "../model";
import { type ProjectionPlan } from "../projection";
import { collectTypecheckScope } from "../scope";
import { TypecheckStateStore } from "../state";
import { type TypecheckTarget } from "../targets";

// Pyright's boolean diagnostic rules are policy-owned alongside report* rules.
const BOOLEAN_RULES = new Set([
  "strictListInference",
  "strictSetInference",
  "strictDictionaryInference",
  "analyzeUnannotatedFunctions",
  "strictParameterNoneValue",
  "enableExperimentalFeatures",
  "deprecateTypingAliases",
  "disableBytesTypePromotions",
  "enableTypeIgnoreComments",
  "enableReachabilityAnalysis",
]);
function withoutPolicy(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) =>
        !key.startsWith("report") &&
        !BOOLEAN_RULES.has(key) &&
        !["typeCheckingMode", "strict", "include", "exclude", "ignore", "extends"].includes(key),
    ),
  );
}
function rebase(value: Record<string, unknown>, directory: string): Record<string, unknown> {
  const result = { ...value };
  for (const key of ["extraPaths"]) {
    if (Array.isArray(result[key])) {
      result[key] = result[key].map((path: unknown) => (typeof path === "string" ? resolve(directory, path) : path));
    }
  }
  for (const key of ["stubPath", "typeshedPath", "venvPath", "pythonPath", "root"]) {
    if (typeof result[key] === "string") {
      result[key] = resolve(directory, result[key]);
    }
  }
  if (Array.isArray(result.executionEnvironments)) {
    result.executionEnvironments = result.executionEnvironments.map((value) => rebase(object(value), directory));
  }
  return result;
}
async function load(
  target: TypecheckTarget,
  path: string,
  seen: Set<string>,
  inputs: { path: string; text: string }[],
): Promise<Record<string, unknown>> {
  if (seen.has(path)) {
    throw new TypecheckError("unsupported-config", `Cyclic Pyright extends: ${path}`);
  }
  seen.add(path);
  const snapshot = await readProjectionFile(target.root, path);
  if (snapshot.text === null) {
    throw new TypecheckError("unsupported-config", `Missing inherited Pyright config: ${path}`);
  }
  inputs.push({ path, text: snapshot.text });
  const parsed: unknown = path.endsWith(".toml")
    ? (object(object(parse(snapshot.text)).tool).pyright ?? {})
    : Bun.JSONC.parse(snapshot.text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypecheckError("unsupported-config", `Invalid Pyright configuration: ${path}`);
  }
  const config = object(parsed);
  if (config.extends !== undefined && typeof config.extends !== "string") {
    throw new TypecheckError("unsupported-config", "Pyright extends must be a string");
  }
  const inherited =
    typeof config.extends === "string" ? await load(target, resolve(dirname(path), config.extends), seen, inputs) : {};
  return { ...inherited, ...rebase(config, dirname(path)) };
}
function validateEnvironmentPolicy(
  raw: Record<string, unknown>,
  inherited: Record<string, unknown>,
  inheritedPath: string,
): void {
  if (Array.isArray(raw.executionEnvironments) || !Array.isArray(inherited.executionEnvironments)) {
    return;
  }
  for (const [index, environment] of inherited.executionEnvironments.entries()) {
    const control = Object.keys(object(environment)).find((key) => key.startsWith("report") || BOOLEAN_RULES.has(key));
    if (control) {
      throw new TypecheckError(
        "unsupported-config",
        `Inherited Pyright control executionEnvironments[${index}].${control} in ${inheritedPath} must be removed before native adoption; environment diagnostics override the central policy`,
      );
    }
  }
}
async function validateInheritance(
  target: TypecheckTarget,
  path: string,
  raw: Record<string, unknown>,
  shared: Record<string, unknown>,
  inputs: { path: string; text: string }[],
): Promise<void> {
  if (typeof raw.extends === "string") {
    const inheritedPath = resolve(dirname(path), raw.extends);
    const inherited = await load(target, inheritedPath, new Set([path]), inputs);
    const environment = ["venv", "venvPath"].find((key) => inherited[key]);
    if (environment) {
      throw new TypecheckError(
        "unsupported-config",
        `Inherited Pyright environment selector ${environment} in ${inheritedPath} must be removed before native adoption; Justomp selects the uv interpreter at invocation`,
      );
    }
    validateEnvironmentPolicy(raw, inherited, inheritedPath);
    const unmanaged = Object.keys(inherited).find(
      (key) => (key.startsWith("report") || BOOLEAN_RULES.has(key)) && shared[key] === undefined,
    );
    if (unmanaged) {
      throw new TypecheckError(
        "unsupported-config",
        `Inherited Pyright control ${unmanaged} in ${inheritedPath} must be moved to the central policy or removed before native adoption`,
      );
    }
  } else if (raw.extends !== undefined) {
    throw new TypecheckError("unsupported-config", `Pyright extends must be a string: ${path}`);
  }
}
async function retiredPythonConfig(target: TypecheckTarget): Promise<NonNullable<ProjectionPlan["retired"]>> {
  const path = join(target.scope.cwd, "pyright.justomp.json"),
    before = await readProjectionFile(target.root, path);
  if (
    before.text !== null &&
    hasProjectionMarker(before.text, "// Generated by justomp; managed typecheck policy v1.\n")
  ) {
    return [{ path, before }];
  }
  return [];
}
/** Keep native import context at its original path; shared policy owns diagnostic controls. */
export async function planPythonProjection(
  target: TypecheckTarget,
  policy: TypecheckPolicy,
  signal: AbortSignal,
): Promise<ProjectionPlan> {
  signal.throwIfAborted();
  const nativePath = join(target.scope.cwd, "pyrightconfig.json");
  const hasJson = (await readProjectionFile(target.root, nativePath)).text !== null;
  const path = hasJson ? nativePath : join(target.root, target.project.manifest);
  const before = await readProjectionFile(target.root, path);
  if (before.text === null) {
    throw new TypecheckError("project-not-found", `Python manifest disappeared: ${path}`);
  }
  const document = configObject(before.text, path);
  const raw = hasJson ? document : object(object(document.tool).pyright);
  const { diagnostics, ...options } = policy.python.pyright;
  const shared = { ...options, ...diagnostics };
  const inputs = [{ path, text: before.text }];
  await validateInheritance(target, path, raw, shared, inputs);
  const desired: Record<string, unknown> = {
    ...shared,
    include: (await collectTypecheckScope(target)).files,
    exclude: [],
    ignore: [],
    strict: [],
  };
  if (Array.isArray(raw.executionEnvironments)) {
    desired.executionEnvironments = raw.executionEnvironments.map((value) => withoutPolicy(object(value)));
  }
  const prefix = hasJson ? [] : ["tool", "pyright"];
  const store = await TypecheckStateStore.load(target.root);
  const local = relative(target.root, path).replaceAll("\\", "/");
  const prior =
    store.state.projects[target.project.project_id]?.native_configs?.configs.find(
      (config) => config.role === "pyright" && config.path === local,
    )?.fields ?? [];
  const controls = Object.fromEntries(
    Object.entries(raw).filter(
      ([key]) => key.startsWith("report") || BOOLEAN_RULES.has(key) || ["venv", "venvPath"].includes(key),
    ),
  );
  const previous = [...prior, ...reconcileFields({}, controls).fields.map((field) => [...prefix, ...field])];
  const edited = editNativeConfig(before.text, path, desired, previous, prefix);
  const changed = !(await equivalentConfig(before.text, edited.content, hasJson ? "jsonc" : "toml"));
  const retired = await retiredPythonConfig(target);
  return {
    target,
    files: [{ path, before, content: changed ? edited.content : before.text, changed }],
    configs: { check: [path] },
    current: !changed && retired.length === 0,
    input_fingerprint: contentHash(JSON.stringify(inputs)),
    native_configs: { version: 1, configs: [{ role: "pyright", path: local, fields: edited.fields }] },
    retired,
  };
}
