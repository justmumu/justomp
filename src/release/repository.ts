import { lstat, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { type InspectionRules } from "../config/inspection/model";
import { type LoadedConfig, loadConfig } from "../config/load";
import { resolveManagerScope } from "../dependencies/executable";
import { within } from "../dependencies/paths";
import { createMatcher } from "../inspect/exclusions";
import { type PackagingStructure, type Project } from "../inspect/model";
import { type FileSnapshot, readProjectionFile, readSourceFile } from "../lint/files";
import { getPackagingStructure } from "../packaging/get-structure";
import { packagingInvocation } from "../packaging/invocation";
import { type GitContext, gitContext, gitlinks } from "../precommit/git";
import { assertWorkspaceBoundary } from "../precommit/workspace";
import { ReleaseError, type ReleaseParticipant } from "./model";
import { classifyParticipant, type ReleaseManifest, releaseObject } from "./participants";

export type ManagerScope = Awaited<ReturnType<typeof resolveManagerScope>>;
export interface ReleaseRepository {
  git: GitContext;
  config: LoadedConfig;
  structure: PackagingStructure;
  excluded: string[];
  manifests: ReleaseManifest[];
  participants: ReleaseParticipant[];
  scopes: Map<string, ManagerScope>;
  version: FileSnapshot;
  changelog: FileSnapshot;
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
async function childDirectories(root: string, directory: string): Promise<string[]> {
  return (await readdir(join(root, directory), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== ".git")
    .map((entry) => join(directory, entry.name));
}
async function nestedRepositories(
  root: string,
  rules: InspectionRules,
  excluded: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const matcher = createMatcher(rules);
  const pending = ["."];
  const nested: string[] = [];
  while (pending.length) {
    signal?.throwIfAborted();
    const directory = pending.pop() as string;
    if (excludedPath(directory, excluded) || !matcher.mayTraverse(directory)) {
      continue;
    }
    if (directory !== "." && (await exists(join(root, directory, ".git")))) {
      nested.push(directory);
      continue;
    }
    pending.push(...(await childDirectories(root, directory)));
  }
  return nested;
}
async function regularPathComponent(current: string, absolute: string, path: string): Promise<boolean> {
  try {
    const stats = await lstat(current);
    if (stats.isSymbolicLink() || (current === absolute ? !stats.isFile() : !stats.isDirectory())) {
      throw new ReleaseError("unsafe-release-path", `Release path is not a regular file path: ${path}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
/** Missing output files are permitted; existing path components must not be symlinks. */
export async function assertReleasePath(root: string, path: string): Promise<void> {
  const absolute = resolve(root, path);
  if (!within(root, absolute)) {
    throw new ReleaseError("unsafe-release-path", `Release path escapes the repository: ${path}`);
  }
  let current = root;
  for (const part of relative(root, absolute).split("/")) {
    current = join(current, part);
    if (!(await regularPathComponent(current, absolute, path))) {
      return;
    }
    if (current !== absolute && (await exists(join(current, ".git")))) {
      throw new ReleaseError("unsafe-release-path", `Release path belongs to a nested repository: ${path}`);
    }
  }
}
async function readReleaseManifest(root: string, project: Project): Promise<ReleaseManifest> {
  const snapshot = await readSourceFile(root, join(root, project.manifest));
  const data =
    project.ecosystem === "javascript"
      ? releaseObject(JSON.parse(snapshot.text))
      : project.ecosystem === "python"
        ? releaseObject(parseToml(snapshot.text))
        : {};
  const participant = classifyParticipant(project, data);
  return { project, participant, snapshot, data };
}
function excludedPath(path: string, excluded: string[]): boolean {
  const candidate = path.normalize("NFC").toLowerCase();
  return excluded.some((directory) => {
    const boundary = directory.normalize("NFC").toLowerCase();
    return candidate === boundary || candidate.startsWith(`${boundary}/`);
  });
}
async function validateOutputPaths(root: string, config: LoadedConfig, excluded: string[]): Promise<void> {
  for (const path of [config.release.version_file, config.release.changelog_file]) {
    if (excludedPath(path, excluded)) {
      throw new ReleaseError("unsafe-release-path", `Release path belongs to an excluded repository: ${path}`);
    }
    await assertReleasePath(root, path);
  }
}
export async function inspectReleaseRepository(cwd: string, signal?: AbortSignal): Promise<ReleaseRepository> {
  const git = await gitContext(cwd, signal);
  if (!git) {
    throw new ReleaseError("not-a-repository", "Release tools require a Git working tree");
  }
  const config = await loadConfig(git.root, signal ? { signal } : {});
  const links = await gitlinks(git);
  const excluded = [...links, ...(await nestedRepositories(git.root, config.rules, links, signal))].sort();
  const { structure } = await packagingInvocation.run({ root: git.root, excluded }, () =>
    getPackagingStructure(git.root, { refresh: true, publish: false, ...(signal ? { signal } : {}) }),
  );
  if (!structure.complete || structure.workspaces.some((workspace) => workspace.status !== "resolved")) {
    throw new ReleaseError("unresolved-scope", "Resolve incomplete project/workspace discovery before releasing");
  }
  await assertWorkspaceBoundary(git.root, structure, excluded);
  const manifests: ReleaseManifest[] = [];
  const scopes = new Map<string, ManagerScope>();
  for (const project of structure.projects) {
    signal?.throwIfAborted();
    manifests.push(await readReleaseManifest(git.root, project));
    if (project.ecosystem !== "go" && project.manager) {
      scopes.set(project.project_id, await resolveManagerScope(git.root, project, structure.projects));
    }
  }
  await validateOutputPaths(git.root, config, excluded);
  return {
    git,
    config,
    structure,
    excluded,
    manifests,
    scopes,
    participants: manifests.map((manifest) => manifest.participant),
    version: await readProjectionFile(git.root, join(git.root, config.release.version_file)),
    changelog: await readProjectionFile(git.root, join(git.root, config.release.changelog_file)),
  };
}
