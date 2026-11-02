import { join, relative } from "node:path";
import { resolveManagerScope } from "../dependencies/executable";
import { LOCK_MANAGERS, MANIFEST_NAMES } from "../inspect/exclusions";
import { type PackagingStructure, type Project } from "../inspect/model";

export function configConsumers(projects: Project[], before: string | null, after: string): string[] {
  const all = () => projects.map((project) => project.project_id);
  try {
    if (before === null) {
      return all();
    }
    const previous = JSON.parse(before),
      current = JSON.parse(after);
    if (!record(previous) || !record(current)) {
      return all();
    }
    const ecosystems = changedEcosystems(previous, current);
    if (ecosystems === null) {
      return all();
    }
    return projects.filter((project) => ecosystems.has(project.ecosystem)).map((project) => project.project_id);
  } catch {
    return all();
  }
}

export function selectProjects(projects: Project[], paths: string[], shared: ReadonlyMap<string, string[]>): Project[] {
  const selected = new Set<string>();
  for (const path of paths) {
    for (const id of pathConsumers(path, projects, shared)) {
      selected.add(id);
    }
  }
  return projects.filter((p) => selected.has(p.project_id));
}
export async function sharedInputs(structure: PackagingStructure): Promise<Map<string, string[]>> {
  const inputs = new Map<string, string[]>();
  const add = (path: string, ids: string[]) => inputs.set(path, [...new Set([...(inputs.get(path) ?? []), ...ids])]);
  for (const workspace of structure.workspaces) {
    add(workspace.declaration, workspace.members);
  }
  const groups = new Map<string, string[]>();
  const groupKey = (project: Project) => JSON.stringify([project.manager, project.managerRoot]);
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
    const directory = await lockDirectory(structure, project);
    for (const lock of locks) {
      add(join(directory, lock), project.manager === "go" ? [project.project_id] : consumers);
    }
    addOwnerMetadata(project, consumers, add);
  }
  return inputs;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function changedEcosystems(previous: Record<string, unknown>, current: Record<string, unknown>): Set<string> | null {
  const ecosystems = new Set<string>();
  for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    if (JSON.stringify(previous[key]) === JSON.stringify(current[key]) || key === "commit") {
      continue;
    }
    if (!["lint", "typecheck", "test", "integration_test"].includes(key)) {
      return null;
    }
    const changed = sectionEcosystems(previous[key], current[key]);
    if (changed === null) {
      return null;
    }
    for (const ecosystem of changed) {
      ecosystems.add(ecosystem);
    }
  }
  return ecosystems;
}
function sectionEcosystems(a: unknown, b: unknown): string[] | null {
  if (!record(a) || !record(b)) {
    return null;
  }
  const changed: string[] = [];
  for (const ecosystem of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[ecosystem]) === JSON.stringify(b[ecosystem])) {
      continue;
    }
    if (!["python", "javascript", "go"].includes(ecosystem)) {
      return null;
    }
    changed.push(ecosystem);
  }
  return changed;
}
function affectsAllProjects(path: string, projects: Project[]): boolean {
  const name = path.split("/").at(-1) ?? "";
  return (
    path === ".justomp/config.json" ||
    (MANIFEST_NAMES.has(name) && !projects.some((p) => p.manifest === path)) ||
    Object.hasOwn(LOCK_MANAGERS, name) ||
    ["go.work.sum", ".npmrc", ".yarnrc.yml"].includes(name)
  );
}
async function lockDirectory(structure: PackagingStructure, project: Project): Promise<string> {
  let directory = project.manager === "go" ? project.path : project.managerRoot;
  if (project.manager === "pnpm") {
    const scope = await resolveManagerScope(structure.root, project, structure.projects);
    if (scope.pnpm) {
      directory = relative(structure.root, scope.pnpm.lockDirectory) || ".";
    }
  }
  return directory;
}

function pathConsumers(path: string, projects: Project[], shared: ReadonlyMap<string, string[]>): string[] {
  const consumers = shared.get(path);
  if (consumers) {
    return consumers;
  }
  if (affectsAllProjects(path, projects)) {
    return projects.map((p) => p.project_id);
  }
  const owners = projects.filter((p) => p.path === "." || path.startsWith(`${p.path}/`));
  const depth = Math.max(...owners.map(projectDepth));
  return owners.filter((p) => projectDepth(p) === depth).map((p) => p.project_id);
}
function projectDepth(project: Project): number {
  return project.path === "." ? 0 : project.path.length;
}

function addOwnerMetadata(project: Project, consumers: string[], add: (path: string, ids: string[]) => unknown): void {
  if (project.managerRoot !== project.path) {
    for (const name of [
      "package.json",
      "pyproject.toml",
      "pnpm-workspace.yaml",
      "go.work",
      "go.work.sum",
      ".npmrc",
      ".yarnrc.yml",
    ]) {
      add(join(project.managerRoot, name), consumers);
    }
  }
}
