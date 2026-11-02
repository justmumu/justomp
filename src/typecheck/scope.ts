import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { canonicalWritePath, safePath, within } from "../dependencies/paths";
import { isInternalPath } from "../inspect/exclusions";
import { childProjectRoots, scopeIgnores } from "../lint/scope";

export { childProjectRoots, scopeIgnores } from "../lint/scope";

import { excludeSourceFiles } from "../packaging/source-exclusions";
import { TypecheckError } from "./model";
import { type TypecheckTarget } from "./targets";

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".justomp",
  "node_modules",
  "bower_components",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  "__pypackages__",
  ".yarn",
  ".pnpm-store",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".cache",
  ".ruff_cache",
  ".mypy_cache",
  ".pytest_cache",
]);
const EXTENSIONS = {
  python: /\.(?:py|pyi)$/i,
  javascript: /\.(?:[cm]?[jt]s|[jt]sx)$/i,
  go: /\.go$/,
};
function literalGlobPath(path: string): string {
  return path.replace(/[\\*?[\]{}()!+@]/g, "\\$&");
}
export interface TypecheckScope {
  /** Explicit source arguments, relative to target.scope.cwd. */
  files: string[];
  /** Exact Go package directories, not recursive ./... patterns. */
  packages: string[];
  childRoots: string[];
  ignores: string[];
  hasTypescript: boolean;
  empty: boolean;
}
/** Native dependency destinations were validated by manager scope resolution. */
async function dependencyRoots(target: TypecheckTarget): Promise<string[]> {
  const directories = dependencyDirectories(target);
  const roots: string[] = [];
  for (const directory of directories) {
    const canonical = await canonicalWritePath(target.root, directory);
    if (canonical === target.scope.cwd) {
      throw new TypecheckError("unsupported-config", "A dependency directory overlaps the selected project root");
    }
    if (within(target.scope.cwd, canonical)) {
      roots.push(relative(target.scope.cwd, canonical).replaceAll("\\", "/"));
    }
  }
  return roots;
}
export async function collectTypecheckScope(
  target: TypecheckTarget,
  exclude: readonly string[] = [],
): Promise<TypecheckScope> {
  const childRoots = childProjectRoots(target.project, target.structure.projects);
  const dependencies = await dependencyRoots(target);
  const owned: string[] = [];
  const visit = async (directory: string) => {
    if (dependencies.some((path) => path === directory || directory.startsWith(`${path}/`))) {
      return;
    }
    await visitDirectory(target, directory, childRoots, owned, visit);
  };
  await visit("");
  const files = target.project.ecosystem === "javascript" ? excludeSourceFiles(owned, exclude) : owned;
  files.sort();
  return {
    files,
    packages:
      target.project.ecosystem === "go"
        ? [...new Set(files.map((file) => (dirname(file) === "." ? "." : `./${dirname(file)}`)))].sort()
        : [],
    childRoots,
    ignores: [
      ...scopeIgnores(target.project, target.structure.projects),
      ...dependencies.map((path) => `${literalGlobPath(path)}/**`),
    ],
    hasTypescript: files.some((file) => /\.(?:[cm]?ts|tsx)$/i.test(file)),
    empty: files.length === 0,
  };
}

function dependencyDirectories(target: TypecheckTarget): Set<string> {
  const directories = new Set<string>();
  if (target.scope.manager === "uv") {
    directories.add(resolve(target.scope.owner, target.scope.env.UV_PROJECT_ENVIRONMENT || ".venv"));
  }
  const pnpm = target.scope.pnpm;
  if (pnpm) {
    for (const directory of new Set([pnpm.lockDirectory, ...pnpm.memberDirectories])) {
      directories.add(join(directory, pnpm.modulesDirectory));
    }
    for (const directory of pnpm.virtualStoreDirectories) {
      directories.add(directory);
    }
  }
  return directories;
}

function excludedEntry(entry: import("node:fs").Dirent, path: string, childRoots: string[]): boolean {
  return (
    entry.isSymbolicLink() ||
    entry.name === ".pnp.cjs" ||
    entry.name === ".pnp.loader.mjs" ||
    isInternalPath(path) ||
    childRoots.some((child) => path === child || path.startsWith(`${child}/`))
  );
}

async function visitDirectory(
  target: TypecheckTarget,
  directory: string,
  childRoots: string[],
  owned: string[],
  visit: (path: string) => Promise<void>,
): Promise<void> {
  const absolute = await safePath(target.root, resolve(target.scope.cwd, directory));
  const entries = await readdir(absolute, { withFileTypes: true });
  for (const entry of entries) {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (excludedEntry(entry, path, childRoots)) {
      continue;
    }
    await visitEntry(target, entry, path, owned, visit);
  }
}

async function visitEntry(
  target: TypecheckTarget,
  entry: import("node:fs").Dirent,
  path: string,
  owned: string[],
  visit: (path: string) => Promise<void>,
): Promise<void> {
  if (entry.isDirectory()) {
    if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
      await visit(path);
    }
  } else if (entry.isFile() && EXTENSIONS[target.project.ecosystem].test(path)) {
    owned.push(path);
  }
}
