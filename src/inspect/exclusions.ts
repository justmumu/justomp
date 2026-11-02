import picomatch from "picomatch";
import { type InspectionRules } from "../config/inspection/model";

import { validateRules } from "../config/inspection/validate";

export function isInternalStatePath(path: string): boolean {
  return /(?:^|\/)\.justomp(?:\/|$)/.test(path) || /(?:^|\/)\.justomp-projection-[^/]+\.tmp$/.test(path);
}
export function isInternalPath(path: string): boolean {
  return (
    isInternalStatePath(path) ||
    /(?:^|\/)(?:biome\.justomp\.jsonc|eslint\.justomp\.config\.mjs|prettier\.justomp\.json|golangci\.justomp\.yml)$/.test(
      path,
    )
  );
}
function ancestors(path: string): string[] {
  const parts = path.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}
export interface InspectionMatcher {
  includes(path: string): boolean;
  excludes(path: string): boolean;
  mayTraverse(path: string): boolean;
}
export function createMatcher(rules: InspectionRules): InspectionMatcher {
  validateRules(rules);
  const include = rules.include.map((p) => picomatch(p, { dot: true }));
  const descendants = rules.include.map((p) => compileDescendantMatcher(p, true));
  const exclude = rules.exclude.map((p) => picomatch(p, { dot: true }));

  const excluded = (p: string) =>
    isInternalPath(p) || (p !== "." && ancestors(p).some((a) => exclude.some((m) => m(a))));
  const included = (p: string) =>
    !excluded(p) &&
    rules.include.length > 0 &&
    (p === "."
      ? include.some((m) => m(".") || m("package.json"))
      : ancestors(p).some((a) => include.some((m) => m(a))));
  return {
    excludes: excluded,
    includes: included,
    mayTraverse: (p: string) =>
      !excluded(p) &&
      rules.include.length > 0 &&
      (p === "." || included(p) || descendants.some((matches) => matches(p))),
  };
}
export const MANIFEST_NAMES = new Set(["package.json", "pyproject.toml", "go.mod", "pnpm-workspace.yaml", "go.work"]);
export const LOCK_MANAGERS: Readonly<Record<string, string>> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun",
  "uv.lock": "uv",
  "poetry.lock": "poetry",
  "Pipfile.lock": "pipenv",
  "pdm.lock": "pdm",
  "go.sum": "go",
};
export function isDiscoveryInput(path: string): boolean {
  const name = path.split("/").at(-1) ?? "";
  return !isInternalPath(path) && (MANIFEST_NAMES.has(name) || Object.hasOwn(LOCK_MANAGERS, name));
}

/** Whether an included path can exist below an ancestor, without traversing siblings. */
export function patternMayContain(pattern: string, path: string, dot = true): boolean {
  return compileDescendantMatcher(pattern, dot)(path);
}
function compileDescendantMatcher(pattern: string, dot: boolean): (path: string) => boolean {
  const parts = pattern.replace(/^\.\//, "").split("/");
  const segments = parts.map((part) => picomatch(part, { dot }));
  return (path: string) => {
    const dirs = path === "." ? [] : path.split("/");
    return matchDescendants(parts, segments, dirs);
  };
}
function matchDescendants(parts: string[], segments: ((value: string) => boolean)[], dirs: string[]): boolean {
  const memo = new Map<string, boolean>();
  const match = (i: number, j: number): boolean => {
    if (j === dirs.length) {
      return true;
    }
    if (i === parts.length) {
      return true;
    }
    const key = `${i}:${j}`;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const part = parts[i] as string;
    const result =
      part === "**"
        ? match(i + 1, j) || match(i, j + 1)
        : (segments[i] as (s: string) => boolean)(dirs[j] as string) && match(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}
