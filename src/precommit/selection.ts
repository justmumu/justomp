import { join, relative } from "node:path";
import { resolveManagerScope } from "../dependencies/executable";
import { LOCK_MANAGERS, MANIFEST_NAMES } from "../inspect/exclusions";
import type { PackagingStructure, Project } from "../inspect/model";

export function configConsumers(
  projects: Project[],
  before: string | null,
  after: string,
): string[] {
  const all = () => projects.map((project) => project.project_id);
  try {
    if (before === null) return all();
    const previous = JSON.parse(before),
      current = JSON.parse(after);
    if (
      !previous ||
      !current ||
      typeof previous !== "object" ||
      typeof current !== "object" ||
      Array.isArray(previous) ||
      Array.isArray(current)
    )
      return all();
    const ecosystems = new Set<string>();
    for (const key of new Set([
      ...Object.keys(previous),
      ...Object.keys(current),
    ])) {
      if (JSON.stringify(previous[key]) === JSON.stringify(current[key]))
        continue;
      if (key === "commit") continue;
      if (!["lint", "typecheck", "test", "integration_test"].includes(key))
        return all();
      const a = previous[key],
        b = current[key];
      if (
        !a ||
        !b ||
        typeof a !== "object" ||
        typeof b !== "object" ||
        Array.isArray(a) ||
        Array.isArray(b)
      )
        return all();
      for (const ecosystem of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (JSON.stringify(a[ecosystem]) === JSON.stringify(b[ecosystem]))
          continue;
        if (!["python", "javascript", "go"].includes(ecosystem)) return all();
        ecosystems.add(ecosystem);
      }
    }
    return projects
      .filter((project) => ecosystems.has(project.ecosystem))
      .map((project) => project.project_id);
  } catch {
    return all();
  }
}

export function selectProjects(
  projects: Project[],
  paths: string[],
  shared: ReadonlyMap<string, string[]>,
): Project[] {
  const selected = new Set<string>();
  for (const path of paths) {
    const consumers = shared.get(path);
    if (consumers) {
      for (const id of consumers) selected.add(id);
      continue;
    }
    const name = path.split("/").at(-1) ?? "";
    if (
      path === ".justomp/config.json" ||
      (MANIFEST_NAMES.has(name) &&
        !projects.some((p) => p.manifest === path)) ||
      Object.hasOwn(LOCK_MANAGERS, name) ||
      ["go.work.sum", ".npmrc", ".yarnrc.yml"].includes(name)
    ) {
      for (const project of projects) selected.add(project.project_id);
      continue;
    }
    const owners = projects.filter(
      (p) => p.path === "." || path.startsWith(`${p.path}/`),
    );
    const depth = Math.max(
      ...owners.map((p) => (p.path === "." ? 0 : p.path.length)),
    );
    for (const project of owners)
      if ((project.path === "." ? 0 : project.path.length) === depth)
        selected.add(project.project_id);
  }
  return projects.filter((p) => selected.has(p.project_id));
}
export async function sharedInputs(
  structure: PackagingStructure,
): Promise<Map<string, string[]>> {
  const inputs = new Map<string, string[]>();
  const add = (path: string, ids: string[]) =>
    inputs.set(path, [...new Set([...(inputs.get(path) ?? []), ...ids])]);
  for (const workspace of structure.workspaces)
    add(workspace.declaration, workspace.members);
  const groups = new Map<string, string[]>();
  const groupKey = (project: Project) =>
    JSON.stringify([project.manager, project.managerRoot]);
  for (const project of structure.projects) {
    const key = groupKey(project);
    const members = groups.get(key) ?? [];
    members.push(project.project_id);
    groups.set(key, members);
  }
  for (const project of structure.projects) {
    const consumers = groups.get(groupKey(project)) ?? [];
    const locks = Object.entries(LOCK_MANAGERS)
      .filter(([, manager]) => manager === project.manager)
      .map(([name]) => name);
    let directory =
      project.manager === "go" ? project.path : project.managerRoot;
    if (project.manager === "pnpm") {
      const scope = await resolveManagerScope(
        structure.root,
        project,
        structure.projects,
      );
      if (scope.pnpm)
        directory = relative(structure.root, scope.pnpm.lockDirectory) || ".";
    }
    for (const lock of locks)
      add(
        join(directory, lock),
        project.manager === "go" ? [project.project_id] : consumers,
      );
    if (project.managerRoot !== project.path) {
      for (const name of [
        "package.json",
        "pyproject.toml",
        "pnpm-workspace.yaml",
        "go.work",
        "go.work.sum",
        ".npmrc",
        ".yarnrc.yml",
      ])
        add(join(project.managerRoot, name), consumers);
    }
  }
  return inputs;
}
