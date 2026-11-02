import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { object } from "../../dependencies/inventory";
import { type ProcessResult } from "../../dependencies/model";
import { safePath, within } from "../../dependencies/paths";
import { nodeRun, succeeded } from "../../lint/javascript/native";
import { TypecheckError } from "../model";
import { collectTypecheckScope, type TypecheckScope } from "../scope";
import { TypecheckStateStore } from "../state";
import { type TypecheckTarget } from "../targets";
import { assertTypecheckNative, typecheckNative, typescriptRun } from "./native";
import { JavascriptConfigRead } from "./read-session";

/** Interpret one compiler response without reading files or starting a process. */
export function effectiveJavascriptConfig(
  result: ProcessResult,
  raw: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  // Empty solution/source configs are valid graph nodes; no-input TS18003 is the only tolerated CLI failure.
  let effective: Record<string, unknown>;
  if (succeeded(result)) {
    try {
      effective = object(JSON.parse(result.stdout));
    } catch {
      invalid(`TypeScript returned invalid --showConfig metadata for ${path}`);
    }
  } else if (!result.cancelled && !result.truncated && /error TS18003:/.test(result.stdout) && !result.stderr.trim()) {
    // --showConfig does not export options for empty configurations. Extending the original still preserves its native context.
    effective = { compilerOptions: object(raw.compilerOptions), files: [] };
  } else {
    assertTypecheckNative(result, `Read TypeScript config ${path}`);
    effective = {};
  }
  return effective;
}

export interface JavascriptConfigNode {
  /** Original native path, never a managed check projection. */
  path: string;
  project_id: string;
  raw: Record<string, unknown>;
  compilerOptions: Record<string, unknown>;
  /** Native CLI's complete absolute input list, before first-party scope filtering. */
  files: string[];
  /** Absolute original configs in native reference order. */
  references: string[];
  /** Transitive extends inputs, including package configs, for projection freshness. */
  inherited: { path: string; text: string }[];
}
export interface JavascriptConfigGraph {
  nodes: JavascriptConfigNode[];
  roots: string[];
  generatedFiles?: string[];
  scope: TypecheckScope;
}
function invalid(message: string): never {
  throw new TypecheckError("unsupported-config", message);
}
export function parseJavascriptConfig(text: string, path: string): Record<string, unknown> {
  try {
    const value: unknown = Bun.JSONC.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      invalid(`Invalid TypeScript config: ${path}`);
    }
    return object(value);
  } catch (error) {
    invalid(`Invalid TypeScript config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function configPath(target: TypecheckTarget, path: string): Promise<string> {
  await safePath(target.root, path);
  try {
    if ((await stat(path)).isDirectory()) {
      path = join(path, "tsconfig.json");
    }
    await readFile(path, "utf8");
  } catch {
    invalid(`Missing TypeScript configuration/reference: ${path}`);
  }
  return safePath(target.root, path);
}
function owner(target: TypecheckTarget, path: string): string {
  return (
    [...target.structure.projects]
      .filter((p) => p.ecosystem === "javascript" && within(resolve(target.root, p.path), path))
      .sort((a, b) => b.path.length - a.path.length)[0]?.project_id ?? target.project.project_id
  );
}
async function inheritedConfigs(
  target: TypecheckTarget,
  path: string,
  raw: Record<string, unknown>,
  signal: AbortSignal,
  read: JavascriptConfigRead,
  seen = new Set<string>(),
  packaged = false,
): Promise<{ path: string; text: string }[]> {
  if (seen.has(path)) {
    invalid(`Cyclic TypeScript extends: ${path}`);
  }
  seen = new Set([...seen, path]);
  const parents = raw.extends === undefined ? [] : Array.isArray(raw.extends) ? raw.extends : [raw.extends];
  const result: { path: string; text: string }[] = [];
  for (const parent of parents) {
    if (typeof parent !== "string") {
      invalid(`Invalid TypeScript extends: ${path}`);
    }
    const { next, text, packageInput } = await readParent(target, path, parent, signal, read, packaged);
    result.push(
      { path: next, text },
      ...(await inheritedConfigs(target, next, parseJavascriptConfig(text, next), signal, read, seen, packageInput)),
    );
  }
  return result;
}
/** Compiler CLI interprets config semantics; JSONC supplies references and inherited input identities. */
export function readJavascriptConfigGraph(
  target: TypecheckTarget,
  signal: AbortSignal,
  entryConfig?: string,
  read = new JavascriptConfigRead(signal),
  exclude: readonly string[] = [],
): Promise<JavascriptConfigGraph> {
  return typecheckNative(async () => {
    const scope = await collectTypecheckScope(target, exclude);
    const state = await TypecheckStateStore.load(target.root);
    const next =
      state.state.generated?.[target.project.project_id]?.next[target.project.project_id] ??
      Object.values(state.state.generated ?? {})
        .map((receipt) => receipt.next[target.project.project_id])
        .find(Boolean);
    if (!entryConfig && next) {
      entryConfig = resolve(target.root, next.config);
    }
    const generatedFiles: string[] = [];
    await nextSources(target, next, scope, generatedFiles);
    const candidates = await configCandidates(target, scope, entryConfig);
    const nodes = new Map<string, JavascriptConfigNode>(),
      visiting = new Set<string>();
    const visit = async (input: string) => {
      const path = await configPath(target, input);
      if (visiting.has(path)) {
        invalid(`Cyclic TypeScript references: ${path}`);
      }
      if (nodes.has(path)) {
        return;
      }
      visiting.add(path);
      const node = await readNode(target, path, signal, read);
      const references = node.references;
      nodes.set(path, node);
      for (const reference of references) {
        await visit(reference);
      }
      visiting.delete(path);
    };
    for (const candidate of [...candidates].sort()) {
      await visit(candidate);
    }
    const inherited = new Set([...nodes.values()].flatMap((node) => node.inherited.map((input) => input.path)));
    const referenced = new Set([...nodes.values()].flatMap((node) => node.references));
    const roots = [...candidates]
      .filter(
        (path) =>
          !inherited.has(path) ||
          referenced.has(path) ||
          path === resolve(target.scope.cwd, entryConfig ?? "tsconfig.json"),
      )
      .sort();
    return { nodes: [...nodes.values()], roots, scope, generatedFiles };
  });
}
/** Scope membership is separate from imported diagnostics and reference ownership. */
export function javascriptCheckContexts(
  target: TypecheckTarget,
  graph: JavascriptConfigGraph,
): { node?: JavascriptConfigNode; files: string[] }[] {
  const files = [
    ...new Set([...graph.scope.files.map((file) => resolve(target.scope.cwd, file)), ...(graph.generatedFiles ?? [])]),
  ];
  const active = new Set(graph.roots);
  const visit = (path: string) => {
    for (const reference of graph.nodes.find((node) => node.path === path)?.references ?? []) {
      if (!active.has(reference)) {
        active.add(reference);
        visit(reference);
      }
    }
  };
  for (const path of graph.roots) {
    visit(path);
  }
  const nodes = graph.nodes.filter(
    (node) =>
      active.has(node.path) &&
      node.project_id === target.project.project_id &&
      (node.files.length > 0 || node.references.length === 0),
  );
  if (!nodes.length) {
    const node = graph.nodes.find(
      (node) => graph.roots.includes(node.path) && node.project_id === target.project.project_id,
    );
    return [{ ...(node ? { node } : {}), files }];
  }
  const scopeFiles = new Set(files);
  const contexts = nodes.map((node) => ({
    node,
    files: node.files.filter((file) => scopeFiles.has(file)),
  }));
  const assigned = new Set(contexts.flatMap((context) => context.files));
  for (const file of files) {
    if (assigned.has(file)) {
      continue;
    }
    const ranked = [...contexts].sort((a, b) => {
      const score = (node: JavascriptConfigNode) =>
        (within(dirname(node.path), file) ? dirname(node.path).length : 0) +
        (/test|spec/.test(relative(target.scope.cwd, file)) === /test|spec/.test(relative(target.scope.cwd, node.path))
          ? 1
          : 0);
      return score(b.node) - score(a.node) || a.node.path.localeCompare(b.node.path);
    });
    ranked[0]?.files.push(file);
    if (ranked.length) {
      assigned.add(file);
    }
  }
  return contexts
    .filter((context) => context.files.length > 0)
    .map((context) => ({ ...context, files: context.files.sort() }));
}

async function readParent(
  target: TypecheckTarget,
  path: string,
  parent: string,
  signal: AbortSignal,
  read: JavascriptConfigRead,
  packaged: boolean,
) {
  let next: string;
  let packageInput = packaged;
  if (parent.startsWith(".") || parent.startsWith("/")) {
    next = resolve(dirname(path), parent);
    if (!next.endsWith(".json")) {
      next += ".json";
    }
    if (!packageInput) {
      await safePath(target.root, next);
    }
  } else {
    packageInput = true;
    const native = await read.native(target);
    const resolved = await nodeRun(
      target,
      native,
      [
        "-e",
        `const req=require('node:module').createRequire(process.argv[1]); let value; try {value=req.resolve(process.argv[2]);} catch {value=req.resolve(process.argv[2]+'/tsconfig.json');} console.log(value);`,
        path,
        parent,
      ],
      signal,
    );
    assertTypecheckNative(resolved, `Resolve inherited config ${parent}`);
    next = resolved.stdout.trim().split("\n").at(-1) ?? "";
  }
  const text = await parentContents(target, next, packageInput, signal, read);
  return { next, text, packageInput };
}

async function visitTypes(target: TypecheckTarget, directory: string, generatedFiles: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    const path = await safePath(target.root, join(directory, entry.name));
    if (entry.isDirectory()) {
      await visitTypes(target, path, generatedFiles);
    } else if (entry.isFile() && /\.[cm]?tsx?$/.test(entry.name)) {
      generatedFiles.push(path);
    }
  }
}

async function configCandidates(
  target: TypecheckTarget,
  scope: TypecheckScope,
  entryConfig: string | undefined,
): Promise<Set<string>> {
  const candidates = new Set<string>();
  if (entryConfig) {
    candidates.add(await configPath(target, resolve(target.scope.cwd, entryConfig)));
  } else {
    const directories = sourceDirectories(target, scope);
    await discoverConfigs(directories, candidates);
  }
  return candidates;
}

async function readNode(
  target: TypecheckTarget,
  path: string,
  signal: AbortSignal,
  read: JavascriptConfigRead,
): Promise<JavascriptConfigNode> {
  const raw = parseJavascriptConfig(await readFile(path, "utf8"), path);
  const inherited = await inheritedConfigs(target, path, raw, signal, read);
  const packageSpecifiers = [raw, ...inherited.map((input) => parseJavascriptConfig(input.text, input.path))]
    .flatMap((config) => (Array.isArray(config.extends) ? config.extends : [config.extends]))
    .filter((value): value is string => typeof value === "string" && !value.startsWith(".") && !value.startsWith("/"));
  await validatePackageResolution(target, path, signal, read, packageSpecifiers);
  const result = await read.showConfig(target, ["--project", path]);
  const effective = effectiveJavascriptConfig(result, raw, path);
  const references = await readReferences(target, raw, path);
  const node: JavascriptConfigNode = {
    path,
    project_id: owner(target, path),
    raw,
    compilerOptions: object(effective.compilerOptions),
    files: Array.isArray(effective.files)
      ? effective.files.filter((p): p is string => typeof p === "string").map((p) => resolve(dirname(path), p))
      : [],
    references,
    inherited,
  };
  return node;
}

async function validatePackageResolution(
  target: TypecheckTarget,
  path: string,
  signal: AbortSignal,
  read: JavascriptConfigRead,
  packageSpecifiers: string[],
): Promise<void> {
  if (packageSpecifiers.length) {
    // Native TS7 --showConfig can silently omit an unresolved PnP extends.
    // File-list mode validates native resolution without emitting or typechecking.
    const listing = await typescriptRun(
      target,
      ["--listFilesOnly", "--project", path, "--pretty", "false", "--noEmit", "--incremental", "false"],
      signal,
      await read.native(target),
    );
    if (listing.cancelled || listing.truncated || ![0, 1, 2].includes(listing.exit_code ?? -1)) {
      assertTypecheckNative(listing, `Validate native config resolution ${path}`);
    }
    for (const specifier of packageSpecifiers) {
      if (listing.stdout.includes(`error TS6053: File '${specifier}' not found.`)) {
        throw new TypecheckError(
          "incompatible-toolchain",
          `Installed TypeScript cannot resolve installed package config '${specifier}' in the native environment; Yarn PnP requires native compiler support. Reconcile the installed toolchain explicitly; no downgrade or linker change was made.`,
        );
      }
    }
  }
}

async function readReferences(target: TypecheckTarget, raw: Record<string, unknown>, path: string): Promise<string[]> {
  const references: string[] = [];
  if (raw.references !== undefined && !Array.isArray(raw.references)) {
    invalid(`Invalid TypeScript references: ${path}`);
  }
  for (const reference of (raw.references as unknown[] | undefined) ?? []) {
    const value = object(reference).path;
    if (typeof value !== "string") {
      invalid(`Invalid TypeScript reference in ${path}`);
    }
    references.push(await configPath(target, resolve(dirname(path), value)));
  }
  return references;
}

function sourceDirectories(target: TypecheckTarget, scope: TypecheckScope): Set<string> {
  const directories = new Set([target.scope.cwd]);
  for (const file of scope.files) {
    let directory = dirname(resolve(target.scope.cwd, file));
    while (within(target.scope.cwd, directory)) {
      directories.add(directory);
      if (directory === target.scope.cwd) {
        break;
      }
      directory = dirname(directory);
    }
  }
  return directories;
}

async function parentContents(
  target: TypecheckTarget,
  next: string,
  packageInput: boolean,
  signal: AbortSignal,
  read: JavascriptConfigRead,
): Promise<string> {
  let text: string;
  if (packageInput) {
    const contents = await nodeRun(
      target,
      await read.native(target),
      ["-e", "console.log(JSON.stringify(require('node:fs').readFileSync(process.argv[1],'utf8')))", next],
      signal,
    );
    assertTypecheckNative(contents, `Read inherited TypeScript config ${next}`);
    text = JSON.parse(contents.stdout.trim()) as string;
  } else {
    try {
      text = await readFile(next, "utf8");
    } catch {
      invalid(`Missing inherited TypeScript config: ${next}`);
    }
  }
  return text;
}

async function nextSources(
  target: TypecheckTarget,
  next: import("../state").NextTypeInputs | undefined,
  scope: TypecheckScope,
  generatedFiles: string[],
): Promise<void> {
  if (next) {
    const dist = await safePath(target.root, next.dist);
    scope.files = scope.files.filter((file) => !within(dist, resolve(target.scope.cwd, file)));
    await visitTypes(target, join(dist, "types"), generatedFiles);
    const env = join(target.scope.cwd, "next-env.d.ts");
    if (await Bun.file(env).exists()) {
      generatedFiles.push(env);
    }
  }
}

async function discoverConfigs(directories: Set<string>, candidates: Set<string>): Promise<void> {
  for (const directory of [...directories].sort()) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.isFile() && /^(?:ts|js)config(?:\.[^.]+)*\.json$/.test(item.name) && !item.name.includes(".justomp.")) {
        candidates.add(join(directory, item.name));
      }
    }
  }
}
