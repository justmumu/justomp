import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { loadConfig } from "../config/load";
import { RELEASE_DEFAULTS } from "../config/release/defaults";
import { type ReleasePolicy } from "../config/release/model";
import { pnpmDirectories } from "../dependencies/executable";
import { object } from "../dependencies/inventory";
import { within } from "../dependencies/paths";
import { LOCK_MANAGERS } from "../inspect/exclusions";
import { type PackagingStructure, type Project, type Workspace } from "../inspect/model";
import { readProjectionFile } from "../lint/files";
import { LintStateStore } from "../lint/state";
import { type NativeConfigOwnership } from "../native-config/ownership";
import { BIOME_CONFIGS, GO_CONFIGS, PRETTIER_CONFIGS } from "../native-config/selection";
import { VITEST_CONFIG_NAMES } from "../testing/javascript/native-config";
import { TestStateStore } from "../testing/state";
import { TypecheckStateStore } from "../typecheck/state";

type ProtectionStructure = Pick<PackagingStructure, "root" | "complete" | "projects" | "workspaces">;
export class ProtectionPathError extends Error {
  override name = "ProtectionPathError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function metadataPath(root: string, path: string): string {
  const absolute = resolve(root, path);
  if (!within(root, absolute)) {
    throw new ProtectionPathError("outside-root", `Protected metadata path is outside the inspection root: ${path}`);
  }
  return absolute;
}

/** Project metadata decides the deny list; an ambiguous manager never picks one lock. */
export function collectProtectedPaths(
  structure: ProtectionStructure,
  release: Pick<ReleasePolicy, "version_file"> = RELEASE_DEFAULTS,
): string[] {
  if (!structure.complete) {
    throw new ProtectionPathError("incomplete-inspection", "Cannot protect paths from an incomplete inspection");
  }
  if (!isAbsolute(structure.root)) {
    throw new ProtectionPathError("invalid-root", "Inspection root must be absolute");
  }
  const root = resolve(structure.root);
  const paths = new Set<string>();
  const add = (path: string) => paths.add(metadataPath(root, path));
  for (const name of [
    "config.json",
    "packaging_structure.json",
    "lint_state.json",
    "typecheck_state.json",
    "test_state.json",
  ]) {
    add(join(".justomp", name));
  }
  add(release.version_file);
  for (const project of structure.projects) {
    addProjectPaths(root, add, project);
  }
  for (const workspace of structure.workspaces) {
    addWorkspacePaths(root, add, workspace);
  }
  return [...paths].sort();
}

function addLocks(add: (path: string) => void, owner: string, managers: readonly string[]): void {
  for (const [name, manager] of Object.entries(LOCK_MANAGERS)) {
    if (managers.includes(manager)) {
      add(join(owner, name));
    }
  }
  if (managers.includes("pnpm")) {
    add(join(owner, "pnpm-workspace.yaml"));
  }
}

function addProjectPaths(root: string, add: (path: string) => void, project: Project): void {
  add(project.manifest);
  const cwd = metadataPath(root, project.path);
  const owner = metadataPath(root, project.managerRoot);
  const managers = [...project.managerCandidates, ...(project.manager ? [project.manager] : [])];
  addProjectConfigNames(add, cwd, project.ecosystem);
  if (project.ecosystem === "python") {
    add(join(owner, "pyproject.toml"));
    add(join(owner, "uv.lock"));
    addLocks(add, owner, managers);
  } else if (project.ecosystem === "javascript") {
    add(join(owner, "package.json"));
    addLocks(add, owner, managers);
  } else {
    // go.sum belongs to the module, even when a go.work owner is above it.
    add(join(cwd, "go.sum"));
  }
}
function projectConfigNames(ecosystem: Project["ecosystem"]): readonly string[] {
  if (ecosystem === "python") {
    return [
      "pyright.justomp.json",
      "pyrightconfig.json",
      "ruff.toml",
      ".ruff.toml",
      ".coveragerc",
      "setup.cfg",
      "tox.ini",
    ];
  }
  if (ecosystem === "javascript") {
    return [
      "eslint.justomp.config.mjs",
      "biome.justomp.jsonc",
      "prettier.justomp.json",
      ...BIOME_CONFIGS,
      ...PRETTIER_CONFIGS,
      "bunfig.toml",
      "tsconfig.json",
      "jsconfig.json",
      "tsconfig.build.json",
      "tsconfig.types.json",
      ...VITEST_CONFIG_NAMES,
    ];
  }
  return ["golangci.justomp.yml", ...GO_CONFIGS];
}
function addProjectConfigNames(add: (path: string) => void, cwd: string, ecosystem: Project["ecosystem"]): void {
  for (const name of projectConfigNames(ecosystem)) {
    add(join(cwd, name));
  }
}

function addWorkspacePaths(root: string, add: (path: string) => void, workspace: Workspace): void {
  add(workspace.declaration);
  const owner = metadataPath(root, workspace.path);
  if (workspace.kind === "go") {
    add(join(owner, "go.work"));
    add(join(owner, "go.work.sum"));
  } else {
    addLocks(add, owner, [workspace.kind]);
    if (["npm", "pnpm", "yarn", "bun"].includes(workspace.kind)) {
      add(join(owner, "package.json"));
    }
  }
}

/** Resolve the existing prefix, including dangling links, without creating placeholders. */
export async function canonicalProtectionPath(path: string, links = 0): Promise<string> {
  const absolute = resolve(path);
  if (links > 40) {
    throw new ProtectionPathError("symlink-loop", `Too many symlinks resolving protected path: ${absolute}`);
  }
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return resolveExistingPrefix(absolute, links);
}
async function resolveExistingPrefix(absolute: string, links: number): Promise<string> {
  let ancestor = absolute;
  const suffix: string[] = [];
  for (;;) {
    try {
      const info = await lstat(ancestor);
      if (info.isSymbolicLink()) {
        const target = resolve(dirname(ancestor), await readlink(ancestor));
        return resolve(await canonicalProtectionPath(target, links + 1), ...suffix);
      }
      return resolve(await realpath(ancestor), ...suffix);
    } catch (error) {
      requireMissing(error);
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw error;
      }
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

/** A move/delete of an ancestor affects its protected children as well. */
export function findProtectedPath(target: string, protectedPaths: readonly string[]): string | undefined {
  const absolute = resolve(target);
  return protectedPaths.find((path) => within(path, absolute) || within(absolute, path));
}

/** Caller supplies the current getPackagingStructure() snapshot for every general call. */
export async function resolveProtectedPaths(structure: ProtectionStructure): Promise<string[]> {
  const config = await loadConfig(structure.root);
  const paths = new Set(collectProtectedPaths(structure, config.release));
  await addDiscoveredPaths(structure, paths);
  await addNativeConfigPaths(structure, paths);
  await addCanonicalPaths(paths);
  return [...paths].sort();
}

async function addDiscoveredPaths(structure: ProtectionStructure, paths: Set<string>): Promise<void> {
  const pnpmOwners = new Set<string>();
  for (const project of structure.projects) {
    if (project.ecosystem !== "javascript") {
      continue;
    }
    await addJavaScriptPaths(structure, paths, pnpmOwners, project);
  }
  for (const workspace of structure.workspaces) {
    if (workspace.kind !== "pnpm") {
      continue;
    }
    const owner = metadataPath(structure.root, workspace.path);
    if (!pnpmOwners.has(owner)) {
      await addPnpmLock(structure, paths, owner, owner);
    }
  }
}
async function addNativeConfigPaths(structure: ProtectionStructure, paths: Set<string>): Promise<void> {
  const root = await realpath(structure.root);
  const stores = await Promise.all([
    LintStateStore.load(root),
    TypecheckStateStore.load(root),
    TestStateStore.load(root),
  ]);
  for (const store of stores) {
    if (store.recovery) {
      throw new ProtectionPathError("invalid-native-state", store.recovery);
    }
    addOwnedNativePaths(structure.root, Object.values(store.state.projects), paths);
  }
  const typecheck = stores[1];
  if (typecheck instanceof TypecheckStateStore) {
    addLegacyDeclarations(structure.root, typecheck, paths);
  }
  const seen = new Set<string>();
  for (const path of [...paths]) {
    const canonical = await canonicalProtectionPath(path);
    if (within(root, canonical)) {
      await addNativeParents(root, canonical, paths, seen);
    }
  }
}
function addOwnedNativePaths(
  root: string,
  receipts: { native_configs?: NativeConfigOwnership }[],
  paths: Set<string>,
): void {
  for (const receipt of receipts) {
    for (const entry of receipt.native_configs?.configs ?? []) {
      paths.add(metadataPath(root, entry.path));
    }
  }
}
function addLegacyDeclarations(root: string, store: TypecheckStateStore, paths: Set<string>): void {
  for (const receipt of Object.values(store.state.generated ?? {})) {
    for (const path of Object.values(object(object(receipt).declarations))) {
      if (typeof path === "string" && /^tsconfig\.justomp\.declarations\.[^.]+\.json$/.test(basename(path))) {
        paths.add(metadataPath(root, path));
      }
    }
  }
}
interface NativeParent {
  value: unknown;
  relative: boolean;
  pyright?: boolean;
}
function configParents(value: Record<string, unknown>, relativePaths = false): NativeParent[] {
  const parents: unknown[] = Array.isArray(value.extends) ? value.extends : [value.extends];
  const references: unknown[] = Array.isArray(value.references) ? value.references : [];
  return [
    ...parents.map((parent) => ({ value: parent, relative: relativePaths, pyright: relativePaths })),
    ...references.map((reference) => ({ value: object(reference).path, relative: true })),
  ];
}
async function readNativeParents(root: string, path: string, pyright: boolean): Promise<NativeParent[]> {
  const snapshot = await readProjectionFile(root, path);
  if (snapshot.text === null) {
    return [];
  }
  let value: Record<string, unknown>;
  try {
    value = object(path.endsWith(".toml") ? parseToml(snapshot.text) : Bun.JSONC.parse(snapshot.text));
  } catch {
    return [];
  }
  if (path.endsWith(".toml")) {
    const tool = object(value.tool);
    const ruff = basename(path) === "pyproject.toml" ? object(tool.ruff) : value;
    return [...configParents(object(tool.pyright), true), { value: ruff.extend, relative: true }];
  }
  return configParents(value, pyright || basename(path) === "pyrightconfig.json");
}
async function localNativeParent(root: string, path: string, candidate: NativeParent): Promise<string | undefined> {
  const value = candidate.value;
  if (typeof value !== "string" || (!candidate.relative && !value.startsWith(".") && !isAbsolute(value))) {
    return undefined;
  }
  let next = resolve(dirname(path), value);
  if (!within(root, next) || next.split("/").includes("node_modules")) {
    return undefined;
  }
  try {
    if ((await stat(next)).isDirectory()) {
      next = join(next, "tsconfig.json");
    }
  } catch (error) {
    requireMissing(error);
    if (!next.endsWith(".json") && !next.endsWith(".jsonc")) {
      next += ".json";
    }
  }
  return next;
}
async function addNativeParents(
  root: string,
  path: string,
  paths: Set<string>,
  seen: Set<string>,
  pyright = false,
): Promise<void> {
  const key = `${path}:${pyright}`;
  if (seen.has(key) || !/\.(?:jsonc?|toml)$/.test(path) || path.includes("/.justomp/")) {
    return;
  }
  seen.add(key);
  for (const candidate of await readNativeParents(root, path, pyright)) {
    const next = await localNativeParent(root, path, candidate);
    if (next) {
      paths.add(next);
      await addNativeParents(root, next, paths, seen, candidate.pyright ?? false);
    }
  }
}
async function addCanonicalPaths(paths: Set<string>): Promise<void> {
  for (const path of [...paths]) {
    const canonical = await canonicalProtectionPath(path);
    paths.add(canonical);
    try {
      const info = await stat(canonical);
      if (info.isFile() && info.nlink > 1) {
        throw new ProtectionPathError(
          "hardlink",
          `Protected file has a hardlink alias and cannot be safely confined: ${path}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function requireMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw error;
  }
}

async function addPnpmLock(
  structure: ProtectionStructure,
  paths: Set<string>,
  cwd: string,
  owner: string,
): Promise<void> {
  const { lockDirectory } = await pnpmDirectories(cwd, owner);
  paths.add(metadataPath(structure.root, join(lockDirectory, "pnpm-lock.yaml")));
}
async function addJavaScriptPaths(
  structure: ProtectionStructure,
  paths: Set<string>,
  pnpmOwners: Set<string>,
  project: Project,
): Promise<void> {
  const cwd = metadataPath(structure.root, project.path);
  if (project.manager === "pnpm" || project.managerCandidates.includes("pnpm")) {
    const owner = metadataPath(structure.root, project.managerRoot);
    await addPnpmLock(structure, paths, cwd, owner);
    pnpmOwners.add(owner);
  }
  for (const name of await readdir(cwd)) {
    if (/^(?:ts|js)config(?:\.[^.]+)*\.json$/.test(name)) {
      paths.add(join(cwd, name));
    }
  }
}
