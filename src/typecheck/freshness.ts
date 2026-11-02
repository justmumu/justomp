import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { safePath, within } from "../dependencies/paths";
import { type PreparationChange } from "./model";
import { collectTypecheckScope } from "./scope";
import { type TypecheckTarget } from "./targets";

const OMIT = new Set([
  ".git",
  ".justomp",
  "node_modules",
  ".yarn",
  ".pnpm-store",
  ".venv",
  "venv",
  "__pycache__",
  "vendor",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "coverage",
  ".cache",
]);
export type FileHashes = Record<string, string>;
export function contentHash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
/** Snapshot first-party files and shared metadata; explicitly include required generated outputs. */
export async function snapshotTypecheckFiles(
  targets: readonly TypecheckTarget[],
  outputs: readonly string[] = [],
  excludedRoots: readonly string[] = [],
): Promise<FileHashes> {
  const files: FileHashes = {};
  const visited = new Set<string>();
  for (const target of targets) {
    const dependencyRoots = snapshotDependencyRoots(target);
    const children = target.structure.projects
      .filter(
        (project) =>
          project.project_id !== target.project.project_id &&
          within(target.scope.cwd, resolve(target.root, project.path)) &&
          resolve(target.root, project.path) !== target.scope.cwd,
      )
      .map((project) => resolve(target.root, project.path));
    const visit = snapshotVisitor(target, files, visited, children, dependencyRoots, excludedRoots);
    await visit(target.scope.cwd);
    for (const name of [
      "pyproject.toml",
      "uv.lock",
      "go.work",
      "go.work.sum",
      "go.mod",
      "go.sum",
      "package.json",
      "package-lock.json",
      "npm-shrinkwrap.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
      ".npmrc",
      ".yarnrc.yml",
    ]) {
      await visit(join(target.scope.owner, name), true);
    }
    for (const output of outputs) {
      await visit(resolve(target.root, output), true);
    }
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}
export function changedTypecheckFiles(
  targets: readonly TypecheckTarget[],
  before: FileHashes,
  after: FileHashes,
): PreparationChange[] {
  const first = targets[0];
  if (!first) {
    return [];
  }
  const owners = [...first.structure.projects]
    .sort((a, b) => b.path.length - a.path.length)
    .map((project) => ({ project, root: resolve(first.root, project.path) }));
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((path) => before[path] !== after[path])
    .map((path) => {
      const absolute = resolve(first.root, path);
      return {
        project_id:
          owners.find((owner) => within(owner.root, absolute))?.project.project_id ?? first.project.project_id,
        path,
        kind: before[path] === undefined ? "created" : after[path] === undefined ? "removed" : "updated",
      };
    });
}
/** Includes discovery/config metadata; excludes generated content from the source fingerprint. */
export async function fingerprintTypecheckSources(
  targets: readonly TypecheckTarget[],
  generated: readonly string[] = [],
): Promise<string> {
  const root = targets[0]?.root;
  const snapshot = await snapshotTypecheckFiles(targets, [], generated);
  return contentHash(
    JSON.stringify(
      Object.entries(snapshot).filter(
        ([path]) =>
          !path.endsWith(".tsbuildinfo") &&
          !generated.some((output) => root && within(resolve(root, output), resolve(root, path))),
      ),
    ),
  );
}
/** Native generation may rewrite metadata, but cannot certify concurrently changed source/routes. */
export async function fingerprintTypecheckAnalysisSources(
  targets: readonly TypecheckTarget[],
  generated: readonly string[] = [],
  exclude: readonly string[] = [],
  imported: readonly string[] = [],
): Promise<string> {
  const files: FileHashes = {};
  for (const target of targets) {
    const selected = (await collectTypecheckScope(target, exclude)).files.map((file) =>
      resolve(target.scope.cwd, file),
    );
    for (const absolute of new Set([...selected, ...imported.filter((file) => within(target.scope.cwd, file))])) {
      if (generated.some((output) => within(resolve(target.root, output), absolute))) {
        continue;
      }
      files[relative(target.root, absolute)] = contentHash(await readFile(await safePath(target.root, absolute)));
    }
  }
  return contentHash(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))));
}

function snapshotDependencyRoots(target: TypecheckTarget): string[] {
  return target.scope.pnpm
    ? [
        ...target.scope.pnpm.memberDirectories.map((directory) =>
          resolve(directory, target.scope.pnpm?.modulesDirectory ?? "node_modules"),
        ),
        ...target.scope.pnpm.virtualStoreDirectories,
      ]
    : target.scope.manager === "uv"
      ? [resolve(target.scope.owner, target.scope.env.UV_PROJECT_ENVIRONMENT || ".venv")]
      : [];
}
function snapshotVisitor(
  target: TypecheckTarget,
  files: FileHashes,
  visited: Set<string>,
  children: string[],
  dependencyRoots: string[],
  excludedRoots: readonly string[],
) {
  const visit = async (path: string, explicit = false): Promise<void> => {
    if (visited.has(path) || skipSnapshotPath(target, path, explicit, children, dependencyRoots, excludedRoots)) {
      return;
    }
    const info = await snapshotInfo(target.root, path);
    if (!info || info.isSymbolicLink()) {
      return;
    }
    visited.add(path);
    if (info.isFile()) {
      files[relative(target.root, path).replaceAll("\\", "/")] = contentHash(await readFile(path));
      return;
    }
    if (!info.isDirectory()) {
      return;
    }
    await visitSnapshotChildren(path, explicit, visit);
  };
  return visit;
}

async function snapshotInfo(root: string, path: string): Promise<import("node:fs").Stats | undefined> {
  let info: import("node:fs").Stats;
  try {
    info = await lstat(await safePath(root, path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  return info;
}

async function visitSnapshotChildren(
  path: string,
  explicit: boolean,
  visit: (path: string, explicit: boolean) => Promise<void>,
): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || OMIT.has(entry.name) || /^tsconfig\.justomp\./.test(entry.name)) {
      continue;
    }
    await visit(join(path, entry.name), explicit);
  }
}

function skipSnapshotPath(
  target: TypecheckTarget,
  path: string,
  explicit: boolean,
  children: string[],
  dependencyRoots: string[],
  excludedRoots: readonly string[],
): boolean {
  return (
    !explicit &&
    (children.includes(path) ||
      dependencyRoots.some((root) => within(root, path)) ||
      excludedRoots.some((root) => within(resolve(target.root, root), path)))
  );
}
