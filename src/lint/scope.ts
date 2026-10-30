import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { canonicalWritePath, safePath, within } from "../dependencies/paths";
import { isInternalPath } from "../inspect/exclusions";
import type { Project } from "../inspect/model";
import { LintError } from "./model";
import type { LintTarget } from "./targets";

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
  python: /\.(?:py|pyi|ipynb)$/i,
  javascript: /\.(?:[cm]?[jt]s|[jt]sx)$/i,
  go: /\.go$/,
};
export function childProjectRoots(
  project: Project,
  projects: readonly Project[],
): string[] {
  const cwd = resolve("/", project.path);
  return [
    ...new Set(
      projects
        .map((child) => resolve("/", child.path))
        .filter((path) => path !== cwd && within(cwd, path))
        .map((path) => relative(cwd, path).replaceAll("\\", "/")),
    ),
  ].sort();
}
function literalGlobPath(path: string): string {
  return path.replace(/[\\*?[\]{}()!+@]/g, "\\$&");
}
export function scopeIgnores(
  project: Project,
  projects: readonly Project[],
): string[] {
  return [
    ...[...EXCLUDED_DIRECTORIES].map((name) => `**/${name}/**`),
    "**/.pnp.cjs",
    "**/.pnp.loader.mjs",
    "**/eslint.justomp.config.mjs",
    "**/prettier.justomp.json",
    "**/golangci.justomp.yml",
    ...childProjectRoots(project, projects).map(
      (path) => `${literalGlobPath(path)}/**`,
    ),
  ];
}
export interface LintScope {
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
async function dependencyRoots(target: LintTarget): Promise<string[]> {
  const directories = new Set<string>();
  if (target.scope.manager === "uv")
    directories.add(
      resolve(
        target.scope.owner,
        target.scope.env.UV_PROJECT_ENVIRONMENT || ".venv",
      ),
    );
  const pnpm = target.scope.pnpm;
  if (pnpm) {
    for (const directory of new Set([
      pnpm.lockDirectory,
      ...pnpm.memberDirectories,
    ]))
      directories.add(join(directory, pnpm.modulesDirectory));
    for (const directory of pnpm.virtualStoreDirectories)
      directories.add(directory);
  }
  const roots: string[] = [];
  for (const directory of directories) {
    const canonical = await canonicalWritePath(target.root, directory);
    if (canonical === target.scope.cwd)
      throw new LintError(
        "unsupported-config",
        "A dependency directory overlaps the selected project root",
      );
    if (within(target.scope.cwd, canonical))
      roots.push(relative(target.scope.cwd, canonical).replaceAll("\\", "/"));
  }
  return roots;
}
export async function collectLintScope(target: LintTarget): Promise<LintScope> {
  const childRoots = childProjectRoots(
    target.project,
    target.structure.projects,
  );
  const dependencies = await dependencyRoots(target);
  const files: string[] = [];
  const visit = async (directory: string) => {
    if (
      dependencies.some(
        (path) => path === directory || directory.startsWith(`${path}/`),
      )
    )
      return;
    const absolute = await safePath(
      target.root,
      resolve(target.scope.cwd, directory),
    );
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (
        entry.isSymbolicLink() ||
        entry.name === ".pnp.cjs" ||
        entry.name === ".pnp.loader.mjs" ||
        isInternalPath(path) ||
        childRoots.some(
          (child) => path === child || path.startsWith(`${child}/`),
        )
      )
        continue;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await visit(path);
      } else if (
        entry.isFile() &&
        EXTENSIONS[target.project.ecosystem].test(path)
      ) {
        // Go's standard generated marker is authoritative independently of directory.
        if (
          target.project.ecosystem === "go" &&
          /^\/\/ Code generated .* DO NOT EDIT\.$/m.test(
            await readFile(resolve(target.scope.cwd, path), "utf8"),
          )
        )
          continue;
        files.push(path);
      }
    }
  };
  await visit("");
  files.sort();
  return {
    files,
    packages:
      target.project.ecosystem === "go"
        ? [
            ...new Set(
              files.map((file) =>
                dirname(file) === "." ? "." : `./${dirname(file)}`,
              ),
            ),
          ].sort()
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
