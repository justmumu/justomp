import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { canonicalWritePath, safePath, within } from "../dependencies/paths";
import { isInternalStatePath } from "../inspect/exclusions";
import type { Project } from "../inspect/model";
import { LintError } from "../lint/model";
import type { LintTarget } from "../lint/targets";
import { packagingInvocation } from "./invocation";

export function childProjectRoots(
  project: Project,
  projects: readonly Project[],
): string[] {
  const cwd = resolve("/", project.path);
  return [
    ...new Set(
      [
        ...projects.map((child) => child.path),
        ...(packagingInvocation.getStore()?.excluded ?? []),
      ]
        .map((path) => resolve("/", path))
        .filter((path) => path !== cwd && within(cwd, path))
        .map((path) => relative(cwd, path).replaceAll("\\", "/")),
    ),
  ].sort();
}
export function literalGlobPath(path: string): string {
  return path.replace(/[\\*?[\]{}()!+@]/g, "\\$&");
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
export interface OwnedFiles {
  files: string[];
  childRoots: string[];
  dependencyRoots: string[];
}
/** Shared ownership walk. Callers supply only their file/directory policy. */
export async function collectOwnedFiles(
  target: LintTarget,
  options: {
    excludeDirectory(path: string, name: string): boolean;
    includeFile(path: string): boolean | Promise<boolean>;
    boundaryRoot?: string;
  },
): Promise<OwnedFiles> {
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
      options.boundaryRoot ?? target.root,
      resolve(target.scope.cwd, directory),
    );
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (
        entry.isSymbolicLink() ||
        entry.name === ".pnp.cjs" ||
        entry.name === ".pnp.loader.mjs" ||
        isInternalStatePath(path) ||
        childRoots.some(
          (child) => path === child || path.startsWith(`${child}/`),
        )
      )
        continue;
      if (entry.isDirectory()) {
        if (!options.excludeDirectory(path, entry.name)) await visit(path);
      } else if (entry.isFile() && (await options.includeFile(path)))
        files.push(path);
    }
  };
  await visit("");
  return { files: files.sort(), childRoots, dependencyRoots: dependencies };
}
