import { basename, extname, isAbsolute } from "node:path";
import picomatch from "picomatch";
import type { FormatPolicy } from "../config/format/model";
import { DEPENDENCY_DIRECTORIES } from "../config/scope-defaults";
import { isInternalStatePath, LOCK_MANAGERS } from "../inspect/exclusions";
import type { LintEcosystem } from "../lint/model";
import { FormatError, type FormatScope, type Formatter } from "./model";

const PARSERS: Readonly<Record<string, string>> = {
  ".js": "babel",
  ".jsx": "babel",
  ".mjs": "babel",
  ".cjs": "babel",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".json": "json",
  ".jsonc": "jsonc",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".md": "markdown",
  ".mdx": "mdx",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".toml": "toml",
};
const JSONC_BASENAMES = new Set([
  "jsconfig.json",
  "pyrightconfig.json",
  "pyright.justomp.json",
  "settings.json",
  "tasks.json",
  "launch.json",
  "extensions.json",
]);
export function formatterFor(
  path: string,
  ecosystem: LintEcosystem,
): Formatter | undefined {
  const extension = extname(path).toLowerCase();
  if (ecosystem === "python" && (extension === ".py" || extension === ".pyi"))
    return { engine: "ruff" };
  if (ecosystem === "go" && extension === ".go")
    return isNativeGoPath(path) ? { engine: "go" } : undefined;
  const parser = PARSERS[extension];
  if (!parser) return undefined;
  const name = basename(path).toLowerCase();
  return {
    engine: "prettier",
    parser:
      extension === ".json" &&
      (JSONC_BASENAMES.has(name) || /^tsconfig.*\.json$/.test(name))
        ? "jsonc"
        : parser,
  };
}
/** golangci-lint fmt skips dot basenames and strips every ... from CLI paths. */
export function isNativeGoPath(path: string): boolean {
  return (
    exactRelativePath(path) &&
    path.endsWith(".go") &&
    !basename(path).startsWith(".") &&
    !path.includes("...")
  );
}
function exactRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  );
}
export function isFormatDependencyPath(path: string): boolean {
  return path
    .split("/")
    .some((part) => DEPENDENCY_DIRECTORIES.some((name) => name === part));
}
function below(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}
/** Matches ancestor directories as well as files; dot directories are intentional inputs. */
export function formatExclusionMatcher(
  policy: FormatPolicy,
): (path: string) => boolean {
  const matches = picomatch(policy.exclude, { dot: true });
  return (path) => {
    const parts = path.split("/");
    return parts.some((_, index) =>
      matches(parts.slice(0, index + 1).join("/")),
    );
  };
}
export function formatFileMatcher(
  ecosystem: LintEcosystem,
  policy: FormatPolicy,
): (path: string) => boolean {
  const included = picomatch(policy.include, { dot: true });
  const excluded = formatExclusionMatcher(policy);
  return (path) =>
    exactRelativePath(path) &&
    !path.split("/").includes(".git") &&
    !isFormatDependencyPath(path) &&
    !isInternalStatePath(path) &&
    !Object.hasOwn(LOCK_MANAGERS, basename(path)) &&
    basename(path) !== ".pnp.cjs" &&
    basename(path) !== ".pnp.loader.mjs" &&
    included(path) &&
    !excluded(path) &&
    formatterFor(path, ecosystem) !== undefined;
}
export function createFormatScope(
  metadata: {
    ecosystem: LintEcosystem;
    files: readonly string[];
    childRoots?: readonly string[];
    dependencyRoots?: readonly string[];
  },
  policy: FormatPolicy,
): FormatScope {
  const eligible = formatFileMatcher(metadata.ecosystem, policy);
  return {
    ecosystem: metadata.ecosystem,
    files: [
      ...new Set(
        metadata.files.filter(
          (path) =>
            !below(path, metadata.childRoots ?? []) &&
            !below(path, metadata.dependencyRoots ?? []) &&
            eligible(path),
        ),
      ),
    ].sort(),
  };
}
export function selectFormatFiles(
  scope: FormatScope,
  files?: readonly string[],
): string[] {
  if (files === undefined) return [...scope.files];
  if (files.length === 0)
    throw new FormatError(
      "invalid-files",
      "files must be a non-empty list of exact project-relative file paths",
    );
  const owned = new Set(scope.files);
  for (const file of files) {
    if (!exactRelativePath(file) || !owned.has(file))
      throw new FormatError(
        "invalid-files",
        `${file} is not an owned supported file in the current format scope (missing, excluded, unsupported, or unsafe path)`,
      );
  }
  return [...new Set(files)].sort();
}
