import { dirname, join, relative, resolve } from "node:path";
import { type FormatPolicy } from "../../config/format/model";
import { loadConfig } from "../../config/load";
import { type TypecheckPolicy } from "../../config/typecheck/model";
import { within } from "../../dependencies/paths";
import { formatPrettier } from "../../format/engines/prettier";
import { equivalentConfig, hasProjectionMarker } from "../../format/readiness";
import { formatterFor } from "../../format/selection";
import { readProjectionFile } from "../../lint/files";
import { editNativeConfig } from "../../native-config/edit";
import { type NativeConfigEntry } from "../../native-config/ownership";
import { excludeSourceFiles } from "../../packaging/source-exclusions";
import { contentHash } from "../freshness";
import { planBuildConsumers } from "../javascript/build-consumers";
import {
  type JavascriptConfigGraph,
  type JavascriptConfigNode,
  javascriptCheckContexts,
  readJavascriptConfigGraph,
} from "../javascript/config-graph";
import {
  buildConfigPath,
  declarationNode,
  inheritedBuild,
  nativeBuildNodes,
  typesConfigPath,
} from "../javascript/entrypoints";
import { TypecheckError } from "../model";
import { type ProjectionPlan } from "../projection";
import { TypecheckStateStore } from "../state";
import { type TypecheckTarget } from "../targets";
export const STRICT_OPTIONS = [
  "noImplicitAny",
  "noImplicitThis",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "alwaysStrict",
  "useUnknownInCatchVariables",
  "strictBuiltinIteratorReturn",
] as const;
const EMIT_FIELDS = [
  "rootDir",
  "outDir",
  "outFile",
  "declarationDir",
  "declaration",
  "declarationMap",
  "emitDeclarationOnly",
  "composite",
  "incremental",
  "tsBuildInfoFile",
];
function localPath(directory: string, path: string): string {
  const value = relative(directory, path).replaceAll("\\", "/");
  return value.startsWith(".") ? value : `./${value}`;
}
function sharedOptions(policy: TypecheckPolicy): Record<string, unknown> {
  const {
    noEmit: _noEmit,
    emitDeclarationOnly: _emit,
    composite: _composite,
    incremental: _incremental,
    rootDir: _rootDir,
    ...shared
  } = policy.javascript.compilerOptions;
  return { ...Object.fromEntries(STRICT_OPTIONS.map((key) => [key, shared.strict])), ...shared, noCheck: false };
}
function requiresBuild(node: JavascriptConfigNode, files: string[]): boolean {
  if (inheritedBuild(node) || node.compilerOptions.noEmit === true) {
    return false;
  }
  const root = node.compilerOptions.rootDir;
  const outsideRoot =
    typeof root === "string" && files.some((path) => !within(resolve(dirname(node.path), root), path));
  const existing = new Set(node.files),
    selected = new Set(files);
  const changesScope = files.some((path) => !existing.has(path)) || node.files.some((path) => !selected.has(path));
  return outsideRoot || (changesScope && EMIT_FIELDS.some((key) => node.compilerOptions[key] !== undefined));
}
interface Entry {
  path: string;
  node?: JavascriptConfigNode;
  files: string[];
  build?: string;
  types?: string;
}
type AddConfig = (
  path: string,
  desired: Record<string, unknown>,
  retiredFields?: string[][],
  initial?: string,
) => Promise<void>;
interface NativeGraphPlan {
  target: TypecheckTarget;
  policy: TypecheckPolicy;
  graph: JavascriptConfigGraph;
  entries: Entry[];
  solutions: Entry[];
  options: Record<string, unknown>;
  add: AddConfig;
}
function formatConfigContent(path: string, content: string, format: FormatPolicy): Promise<string> | string {
  const formatter = formatterFor(path, "javascript");
  return formatter?.engine === "prettier" ? formatPrettier(content, formatter.parser, format.prettier) : content;
}
function configWriter(target: TypecheckTarget, previous: NativeConfigEntry[], format: FormatPolicy) {
  const files: ProjectionPlan["files"] = [];
  const ownership: NativeConfigEntry[] = [];
  const add: AddConfig = async (path, desired, retiredFields = [], initial) => {
    const before = await readProjectionFile(target.root, path);
    const name = relative(target.root, path).replaceAll("\\", "/");
    const owned = previous.find((entry) => entry.path === name);
    const edited = editNativeConfig(before.text ?? initial ?? null, path, desired, [
      ...(owned?.fields ?? []),
      ...retiredFields,
    ]);
    const changed = !(await equivalentConfig(
      before.text,
      edited.content,
      /\.[cm]?[jt]s$/.test(path) ? "babel" : "jsonc",
    ));
    const content = changed ? await formatConfigContent(path, edited.content, format) : (before.text ?? edited.content);
    files.push({ path, before, content, changed });
    ownership.push({ role: "typescript", path: name, fields: edited.fields });
  };
  return { files, ownership, add };
}
function checkEntries(target: TypecheckTarget, graph: JavascriptConfigGraph): Entry[] {
  return javascriptCheckContexts(target, graph).map((context) => {
    const path = context.node?.path ?? graph.entry ?? join(target.scope.cwd, "tsconfig.json");
    const entry: Entry = { ...context, path };
    if (context.node && (inheritedBuild(context.node) || requiresBuild(context.node, context.files))) {
      entry.build = inheritedBuild(context.node) ?? buildConfigPath(path);
    }
    return entry;
  });
}
function needsSolutionBuild(node: JavascriptConfigNode, selected: Map<string, Entry>, split: Set<string>): boolean {
  return (
    !selected.has(node.path) && (inheritedBuild(node) !== undefined || node.references.some((path) => split.has(path)))
  );
}
function solutionEntries(target: TypecheckTarget, graph: JavascriptConfigGraph, entries: Entry[]): Entry[] {
  const builds = nativeBuildNodes(graph.nodes);
  const candidates = graph.nodes.filter(
    (node) =>
      node.project_id === target.project.project_id &&
      !builds.has(node.path) &&
      !entries.some((entry) => entry.path === node.path) &&
      node.files.length === 0 &&
      node.references.length > 0,
  );
  const selected = new Map<string, Entry>();
  const split = new Set(entries.filter((entry) => entry.build).map((entry) => entry.path));
  for (;;) {
    const before = selected.size;
    for (const node of candidates) {
      if (needsSolutionBuild(node, selected, split)) {
        selected.set(node.path, {
          path: node.path,
          node,
          files: [],
          build: inheritedBuild(node) ?? buildConfigPath(node.path),
        });
        split.add(node.path);
      }
    }
    if (selected.size === before) {
      return [...selected.values()];
    }
  }
}
async function projectSolutions(context: NativeGraphPlan): Promise<void> {
  for (const entry of context.solutions) {
    await projectBuild(entry, context);
    if (entry.build) {
      await context.add(entry.path, { extends: localPath(dirname(entry.path), entry.build) });
    }
  }
}
function productionNode(entry: Entry, graph: JavascriptConfigGraph): JavascriptConfigNode | undefined {
  if (!entry.node) {
    return undefined;
  }
  return graph.nodes.find((node) => node.path === inheritedBuild(entry.node as JavascriptConfigNode)) ?? entry.node;
}
function assignTypesEntries(context: NativeGraphPlan): void {
  for (const entry of context.entries) {
    const production = productionNode(entry, context.graph);
    const path = typesConfigPath(entry.build ?? entry.path);
    const existing = context.graph.nodes.some(
      (node) => node.path === path && node.compilerOptions.emitDeclarationOnly === true,
    );
    if (production && (needsTypesEntry(production, context.target, context.policy.javascript.exclude) || existing)) {
      entry.types = path;
    }
  }
}
function referenceTarget(context: NativeGraphPlan, path: string, purpose: "check" | "build"): string {
  const entry = [...context.entries, ...context.solutions].find((item) => item.path === path || item.build === path);
  if (entry) {
    return purpose === "check" ? (entry.types ?? entry.build ?? path) : (entry.build ?? path);
  }
  const node = context.graph.nodes.find((item) => item.path === path);
  if (!node) {
    return path;
  }
  return purpose === "check" ? declarationNode(node, context.graph.nodes).path : (inheritedBuild(node) ?? path);
}
function nativeReferences(context: NativeGraphPlan, paths: string[], directory: string, purpose: "check" | "build") {
  return paths.map((path) => ({ path: localPath(directory, referenceTarget(context, path, purpose)) }));
}
async function projectBuild(entry: Entry, context: NativeGraphPlan): Promise<void> {
  const production = productionNode(entry, context.graph);
  if (!entry.build || !production || !entry.node) {
    return;
  }
  const before = await readProjectionFile(context.target.root, entry.build);
  if (before.text !== null && !inheritedBuild(entry.node)) {
    throw new TypecheckError("projection-conflict", `Native build target already exists: ${entry.build}`);
  }
  const initial =
    (await readProjectionFile(context.target.root, production.path)).text ?? JSON.stringify(production.raw);
  const { allowJs: _allowJs, checkJs: _checkJs, ...buildOptions } = context.options;
  const desired: Record<string, unknown> = { compilerOptions: buildOptions };
  if (production.raw.references !== undefined) {
    desired.references = nativeReferences(context, production.references, dirname(entry.build), "build");
  }
  await context.add(entry.build, desired, [], initial);
}
async function projectTypes(entry: Entry, context: NativeGraphPlan): Promise<void> {
  const production = productionNode(entry, context.graph);
  if (!entry.types || !production) {
    return;
  }
  const base = entry.build ?? entry.path;
  const selected = excludeSourceFiles(
    production.files.map((path) => relative(context.target.scope.cwd, path)),
    context.policy.javascript.exclude,
  ).map((path) => resolve(context.target.scope.cwd, path));
  const directory = dirname(entry.types);
  const compilerOptions = {
    ...context.options,
    declaration: true,
    emitDeclarationOnly: true,
    noEmit: false,
    composite: true,
    ...(typeof production.compilerOptions.rootDir === "string" ? { rootDir: production.compilerOptions.rootDir } : {}),
  };
  await context.add(entry.types, {
    extends: localPath(directory, base),
    compilerOptions,
    files: selected.map((path) => localPath(directory, path)),
    include: [],
    exclude: [],
    references: nativeReferences(context, production.references, directory, "check"),
  });
}
function expandedCheckRoot(entry: Entry): boolean {
  if (entry.build) {
    return true;
  }
  const options = entry.node?.compilerOptions;
  const root = options?.rootDir;
  return (
    options?.noEmit === true &&
    typeof root === "string" &&
    entry.files.some((path) => !within(resolve(dirname(entry.path), root), path))
  );
}
function checkConfiguration(entry: Entry, context: NativeGraphPlan): Record<string, unknown> {
  const compilerOptions = {
    ...(!entry.node ? { target: "ESNext", module: "NodeNext", moduleResolution: "NodeNext", jsx: "preserve" } : {}),
    ...context.options,
  };
  if (expandedCheckRoot(entry)) {
    Object.assign(compilerOptions, {
      rootDir: localPath(dirname(entry.path), context.target.scope.cwd),
      composite: false,
      incremental: false,
    });
  }
  return {
    compilerOptions,
    ...(entry.build ? { extends: localPath(dirname(entry.path), entry.build) } : {}),
    files: entry.files.map((path) => localPath(dirname(entry.path), path)),
    include: [],
    exclude: [],
    references: nativeReferences(context, entry.node?.references ?? [], dirname(entry.path), "check"),
  };
}
async function projectEntries(context: NativeGraphPlan): Promise<void> {
  assignTypesEntries(context);
  for (const entry of context.entries) {
    await projectBuild(entry, context);
    await projectTypes(entry, context);
    const retired = entry.build ? EMIT_FIELDS.map((field) => ["compilerOptions", field]) : [];
    await context.add(entry.path, checkConfiguration(entry, context), retired);
  }
}
/** Native check/build files expose the same graph to the editor, CLI and managed checker. */
export async function planJavascriptProjection(
  target: TypecheckTarget,
  policy: TypecheckPolicy,
  signal: AbortSignal,
  entryConfig?: string,
): Promise<ProjectionPlan> {
  const graph = await readJavascriptConfigGraph(target, signal, entryConfig, undefined, policy.javascript.exclude);
  const store = await TypecheckStateStore.load(target.root);
  const previous = store.state.projects[target.project.project_id]?.native_configs?.configs ?? [];
  const format = (await loadConfig(target.root, { signal })).format;
  const { files, ownership, add } = configWriter(target, previous, format);
  const entries = checkEntries(target, graph);
  const solutions = solutionEntries(target, graph, entries);
  const context = { target, policy, graph, entries, solutions, options: sharedOptions(policy), add };
  await projectEntries(context);
  await projectSolutions(context);
  const next = Object.values(store.state.generated ?? {})
    .map((receipt) => receipt.next[target.project.project_id])
    .find(Boolean);
  const consumers = await planBuildConsumers(
    target,
    [...entries, ...solutions].filter((entry): entry is Entry & { node: JavascriptConfigNode } => !!entry.node),
    signal,
    next?.config,
    previous
      .find((entry) => entry.path === target.project.manifest)
      ?.fields.flatMap((field) => (field.length === 2 && field[0] === "scripts" && field[1] ? [field[1]] : [])) ?? [],
  );
  for (const consumer of consumers) {
    await add(consumer.path, consumer.desired);
  }
  const retired = await legacyFiles(target, entries, graph.nodes);
  return {
    target,
    files,
    configs: { check: entries.map((entry) => entry.path) },
    native_configs: { version: 1, configs: ownership },
    input_fingerprint: contentHash(JSON.stringify([graph.entry, graph.nodes, graph.scope.files, graph.generatedFiles])),
    current: files.every((file) => !file.changed) && retired.length === 0,
    retired,
  };
}

function needsTypesEntry(node: JavascriptConfigNode, target: TypecheckTarget, exclude: string[]): boolean {
  if (
    !exclude.length ||
    !(node.compilerOptions.composite || node.compilerOptions.declaration || node.compilerOptions.declarationDir)
  ) {
    return false;
  }
  return (
    excludeSourceFiles(
      node.files.map((path) => relative(target.scope.cwd, path)),
      exclude,
    ).length !== node.files.length
  );
}
async function legacyFiles(target: TypecheckTarget, entries: Entry[], nodes: JavascriptConfigNode[]) {
  const candidates = [
    ...entries.map((_entry, index) => join(target.scope.cwd, `tsconfig.justomp.${index}.json`)),
    ...nodes
      .filter((node) => node.project_id === target.project.project_id)
      .map((node) =>
        join(dirname(node.path), `tsconfig.justomp.declarations.${contentHash(node.path).slice(0, 12)}.json`),
      ),
  ];
  const retired = [];
  for (const path of candidates) {
    const before = await readProjectionFile(target.root, path);
    if (
      before.text !== null &&
      (hasProjectionMarker(before.text, "// Generated by justomp; managed typecheck policy v1.\n") ||
        hasProjectionMarker(before.text, "// Generated by justomp; managed typecheck declarations v1.\n"))
    ) {
      retired.push({ path, before });
    }
  }
  return retired;
}
