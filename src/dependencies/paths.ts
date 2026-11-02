import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { type AdapterContext, DependencyError, type Source } from "./model";
export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}
export async function safePath(root: string, path: string): Promise<string> {
  const absolute = resolve(root, path);
  if (!within(root, absolute)) {
    throw new DependencyError("outside-root", "Dependency paths must stay inside the inspection root");
  }
  let existing = absolute;
  for (;;) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      existing = dirname(existing);
    }
  }
  if (!within(root, await realpath(existing))) {
    throw new DependencyError("outside-root", "A dependency path resolves outside the inspection root");
  }
  return absolute;
}
// Resolve symlink aliases even when the final environment has not been created.
export async function canonicalWritePath(root: string, path: string): Promise<string> {
  let existing = await safePath(root, path);
  const suffix: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(existing), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      suffix.unshift(basename(existing));
      existing = dirname(existing);
    }
  }
}
export async function localSource(
  context: AdapterContext,
  source: Extract<Source, { kind: "path" | "workspace" }>,
): Promise<string> {
  let path: string;
  if (source.kind === "path") {
    path = source.path;
  } else {
    const target = context.structure.projects.find((p) => p.project_id === source.target_project_id);
    if (!target || target.ecosystem !== context.project.ecosystem) {
      throw new DependencyError(
        "source-not-found",
        "Workspace source must identify an inspected project in the same ecosystem",
      );
    }
    if (!context.project.workspace || target.workspace !== context.project.workspace) {
      throw new DependencyError(
        "unsupported-source-operation",
        "Source is not a member of the selected native workspace",
      );
    }
    path = target.path;
  }
  const absolute = await safePath(context.root, path);
  await realpath(absolute);
  return absolute;
}
