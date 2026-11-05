import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { EXCLUDED_DIRECTORIES } from "../config/scope-defaults";
import { isInternalPath } from "../inspect/exclusions";
import { type Project } from "../inspect/model";
import { childProjectRoots, collectOwnedFiles, literalGlobPath } from "../packaging/file-scope";
import { excludeSourceFiles } from "../packaging/source-exclusions";
import { type LintTarget } from "./targets";

export { childProjectRoots } from "../packaging/file-scope";

const EXTENSIONS = {
  python: /\.(?:py|pyi|ipynb)$/i,
  javascript: /\.(?:[cm]?[jt]s|[jt]sx)$/i,
  go: /\.go$/,
};
export function scopeIgnores(project: Project, projects: readonly Project[]): string[] {
  return [
    ...[...EXCLUDED_DIRECTORIES].map((name) => `**/${name}/**`),
    "**/.pnp.cjs",
    "**/.pnp.loader.mjs",
    "**/eslint.justomp.config.mjs",
    "**/biome.justomp.jsonc",
    "**/prettier.justomp.json",
    "**/golangci.justomp.yml",
    ...childProjectRoots(project, projects).map((path) => `${literalGlobPath(path)}/**`),
  ];
}
/** Preserve literal directory globs; richer picomatch syntax keeps exact native fallbacks. */
export function sourceIgnores(
  owned: readonly string[],
  selected: ReadonlySet<string>,
  exclude: readonly string[],
): string[] {
  const directories = [
    ...new Set(
      exclude.filter(
        (pattern) =>
          /^[A-Za-z0-9_. /-]+\/\*\*$/.test(pattern) &&
          pattern
            .slice(0, -3)
            .split("/")
            .every((part) => part !== "" && part !== "." && part !== ".."),
      ),
    ),
  ];
  const prefixes = directories.map((pattern) => pattern.slice(0, -2));
  return [
    ...directories,
    ...owned
      .filter((file) => !selected.has(file) && !prefixes.some((prefix) => file.startsWith(prefix)))
      .map(literalGlobPath),
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
export async function collectLintScope(target: LintTarget, exclude: readonly string[] = []): Promise<LintScope> {
  const {
    files: owned,
    childRoots,
    dependencyRoots,
  } = await collectOwnedFiles(target, {
    excludeDirectory: (_path, name) => EXCLUDED_DIRECTORIES.some((excluded) => excluded === name),
    includeFile: async (path) => {
      if (isInternalPath(path) || !EXTENSIONS[target.project.ecosystem].test(path)) {
        return false;
      }
      // Go's standard generated marker is authoritative independently of directory.
      return (
        target.project.ecosystem !== "go" ||
        !/^\/\/ Code generated .* DO NOT EDIT\.$/m.test(await readFile(resolve(target.scope.cwd, path), "utf8"))
      );
    },
  });
  const files = target.project.ecosystem === "javascript" ? excludeSourceFiles(owned, exclude) : owned;
  const selected = new Set(files);
  return {
    files,
    packages:
      target.project.ecosystem === "go"
        ? [...new Set(files.map((file) => (dirname(file) === "." ? "." : `./${dirname(file)}`)))].sort()
        : [],
    childRoots,
    ignores: [
      ...scopeIgnores(target.project, target.structure.projects),
      ...sourceIgnores(owned, selected, exclude),
      ...dependencyRoots.map((path) => `${literalGlobPath(path)}/**`),
    ],
    hasTypescript: files.some((file) => /\.(?:[cm]?ts|tsx)$/i.test(file)),
    empty: files.length === 0,
  };
}
