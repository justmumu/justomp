import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pnpmDirectories } from "../dependencies/executable";
import { within } from "../dependencies/paths";
import { LOCK_MANAGERS } from "../inspect/exclusions";
import type { PackagingStructure } from "../inspect/model";
import { TypecheckStateStore } from "../typecheck/state";

type ProtectionStructure = Pick<
  PackagingStructure,
  "root" | "complete" | "projects" | "workspaces"
>;
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
  if (!within(root, absolute))
    throw new ProtectionPathError(
      "outside-root",
      `Protected metadata path is outside the inspection root: ${path}`,
    );
  return absolute;
}

/** Project metadata decides the deny list; an ambiguous manager never picks one lock. */
export function collectProtectedPaths(
  structure: ProtectionStructure,
): string[] {
  if (!structure.complete)
    throw new ProtectionPathError(
      "incomplete-inspection",
      "Cannot protect paths from an incomplete inspection",
    );
  if (!isAbsolute(structure.root))
    throw new ProtectionPathError(
      "invalid-root",
      "Inspection root must be absolute",
    );
  const root = resolve(structure.root);
  const paths = new Set<string>();
  const add = (path: string) => paths.add(metadataPath(root, path));
  const locks = (owner: string, managers: readonly string[]) => {
    for (const [name, manager] of Object.entries(LOCK_MANAGERS))
      if (managers.includes(manager)) add(join(owner, name));
    if (managers.includes("pnpm")) add(join(owner, "pnpm-workspace.yaml"));
  };
  for (const name of [
    "config.json",
    "packaging_structure.json",
    "lint_state.json",
    "typecheck_state.json",
    "test_state.json",
  ])
    add(join(".justomp", name));
  for (const project of structure.projects) {
    add(project.manifest);
    const cwd = metadataPath(root, project.path);
    const owner = metadataPath(root, project.managerRoot);
    const managers = [
      ...project.managerCandidates,
      ...(project.manager ? [project.manager] : []),
    ];
    if (project.ecosystem === "python") {
      add(join(owner, "pyproject.toml"));
      add(join(owner, "uv.lock"));
      add(join(cwd, "pyright.justomp.json"));
      locks(owner, managers);
    } else if (project.ecosystem === "javascript") {
      add(join(owner, "package.json"));
      locks(owner, managers);
      add(join(cwd, "eslint.justomp.config.mjs"));
      add(join(cwd, "prettier.justomp.json"));
    } else {
      // go.sum belongs to the module, even when a go.work owner is above it.
      add(join(cwd, "go.sum"));
      add(join(cwd, "golangci.justomp.yml"));
    }
  }
  for (const workspace of structure.workspaces) {
    add(workspace.declaration);
    const owner = metadataPath(root, workspace.path);
    if (workspace.kind === "go") {
      add(join(owner, "go.work"));
      add(join(owner, "go.work.sum"));
    } else {
      locks(owner, [workspace.kind]);
      if (["npm", "pnpm", "yarn", "bun"].includes(workspace.kind))
        add(join(owner, "package.json"));
    }
  }
  return [...paths].sort();
}

/** Resolve the existing prefix, including dangling links, without creating placeholders. */
export async function canonicalProtectionPath(
  path: string,
  links = 0,
): Promise<string> {
  const absolute = resolve(path);
  if (links > 40)
    throw new ProtectionPathError(
      "symlink-loop",
      `Too many symlinks resolving protected path: ${absolute}`,
    );
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let ancestor = absolute;
  const suffix: string[] = [];
  for (;;) {
    try {
      const info = await lstat(ancestor);
      if (info.isSymbolicLink()) {
        const target = resolve(dirname(ancestor), await readlink(ancestor));
        return resolve(
          await canonicalProtectionPath(target, links + 1),
          ...suffix,
        );
      }
      return resolve(await realpath(ancestor), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

/** A move/delete of an ancestor affects its protected children as well. */
export function findProtectedPath(
  target: string,
  protectedPaths: readonly string[],
): string | undefined {
  const absolute = resolve(target);
  return protectedPaths.find(
    (path) => within(path, absolute) || within(absolute, path),
  );
}

/** Caller supplies the current getPackagingStructure() snapshot for every general call. */
export async function resolveProtectedPaths(
  structure: ProtectionStructure,
): Promise<string[]> {
  const paths = new Set(collectProtectedPaths(structure));
  const pnpmOwners = new Set<string>();
  const addPnpmLock = async (cwd: string, owner: string) => {
    const { lockDirectory } = await pnpmDirectories(cwd, owner);
    paths.add(
      metadataPath(structure.root, join(lockDirectory, "pnpm-lock.yaml")),
    );
  };
  for (const project of structure.projects) {
    if (project.ecosystem !== "javascript") continue;
    const cwd = metadataPath(structure.root, project.path);
    if (
      project.manager === "pnpm" ||
      project.managerCandidates.includes("pnpm")
    ) {
      const owner = metadataPath(structure.root, project.managerRoot);
      await addPnpmLock(cwd, owner);
      pnpmOwners.add(owner);
    }
    for (const name of await readdir(cwd))
      if (/^tsconfig\.justomp\..+\.json$/.test(name))
        paths.add(join(cwd, name));
  }
  for (const workspace of structure.workspaces) {
    if (workspace.kind !== "pnpm") continue;
    const owner = metadataPath(structure.root, workspace.path);
    if (!pnpmOwners.has(owner)) await addPnpmLock(owner, owner);
  }
  // Declaration configs may live beside a nested native tsconfig. Reuse the
  // existing receipts instead of starting another recursive repository scan.
  const store = await TypecheckStateStore.load(await realpath(structure.root));
  if (store.recovery)
    throw new ProtectionPathError("invalid-typecheck-state", store.recovery);
  for (const receipt of Object.values(store.state.generated ?? {}))
    for (const path of Object.values(receipt.declarations ?? {}))
      paths.add(metadataPath(structure.root, path));
  for (const path of [...paths]) {
    const canonical = await canonicalProtectionPath(path);
    paths.add(canonical);
    try {
      const info = await stat(canonical);
      if (info.isFile() && info.nlink > 1)
        throw new ProtectionPathError(
          "hardlink",
          `Protected file has a hardlink alias and cannot be safely confined: ${path}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return [...paths].sort();
}
