import { join, posix, relative, resolve } from "node:path";
import { satisfies } from "semver";
import { parse as toml } from "smol-toml";
import { parse as yaml } from "yaml";
import { binaryLockRecords } from "../dependencies/adapters/yarn-common";
import { resolveExecutable } from "../dependencies/executable";
import { object } from "../dependencies/inventory";
import { runProcess } from "../dependencies/runner";
import { normalizePythonName } from "../inspect/readers/manifest";
import { readProjectionFile } from "../lint/files";
import { ReleaseError } from "./model";
import { type ReleaseManifest } from "./participants";
import { type NativeReferenceEvidence, type ReferenceDeclaration, referenceDeclarations } from "./references";
import { type ManagerScope, type ReleaseRepository } from "./repository";

export interface NativeLockSnapshot {
  root: string;
  owner: string;
  directory: string;
  manager: string;
  format: "npm" | "pnpm" | "bun" | "binary-bun" | "classic" | "modern" | "uv" | "missing";
  document: Record<string, unknown>;
  records?: ReturnType<typeof binaryLockRecords>;
  path?: string;
}
interface Resolution {
  path?: string;
  version?: string;
  external?: boolean;
  constraint?: string;
}
function localTarget(path: string, version: unknown, lock: NativeLockSnapshot): Resolution {
  return { path: resolve(lock.owner, path), ...(typeof version === "string" ? { version } : {}) };
}
function npmNodeResolution(
  node: Record<string, unknown>,
  packages: Record<string, unknown>,
  lock: NativeLockSnapshot,
): Resolution {
  if (node.link === true && typeof node.resolved === "string") {
    return localTarget(node.resolved, object(packages[node.resolved]).version, lock);
  }
  if (typeof node.resolved === "string" && node.resolved.startsWith("file:")) {
    return localTarget(node.resolved.slice(5), node.version, lock);
  }
  return { external: true };
}
function npmResolution(
  manifest: ReleaseManifest,
  declaration: ReferenceDeclaration,
  lock: NativeLockSnapshot,
): Resolution {
  const packages = object(lock.document.packages);
  let location = relative(lock.owner, resolve(lock.root, manifest.project.path));
  for (;;) {
    const node = object(packages[posix.join(location, "node_modules", declaration.name)]);
    if (Object.keys(node).length) {
      return npmNodeResolution(node, packages, lock);
    }
    if (!location || location === ".") {
      return {};
    }
    const parent = posix.dirname(location);
    location = parent === "." ? "" : parent;
  }
}
function pnpmResolution(
  manifest: ReleaseManifest,
  declaration: ReferenceDeclaration,
  lock: NativeLockSnapshot,
): Resolution {
  const key = relative(lock.directory, resolve(lock.root, manifest.project.path)) || ".";
  const importer = object(object(lock.document.importers)[key]);
  const group = declaration.field[0] ?? "dependencies";
  const record = object(object(importer[group])[declaration.name]);
  if (record.specifier !== declaration.value) {
    return {};
  }
  if (typeof record.version !== "string") {
    return {};
  }
  if (record.version.startsWith("link:")) {
    return { path: resolve(lock.directory, key, record.version.slice(5)) };
  }
  const file = /^(?:[^()]+\()?file:([^()]+)\)?/.exec(record.version);
  if (file?.[1]) {
    return { path: resolve(lock.directory, file[1]) };
  }
  if (/^(?:workspace:|file:|link:)/.test(declaration.constraint)) {
    return {};
  }
  return { external: true };
}
function bunResolution(
  manifest: ReleaseManifest,
  declaration: ReferenceDeclaration,
  lock: NativeLockSnapshot,
): Resolution {
  const packages = object(lock.document.packages),
    workspaces = object(lock.document.workspaces);
  const parent = manifest.project.name ?? "";
  const keys = [
    ...Object.keys(packages)
      .filter((key) => parent === key || parent.startsWith(`${key}/`))
      .sort((a, b) => b.length - a.length)
      .map((key) => `${key}/${declaration.name}`),
    declaration.name,
  ];
  const row = keys.map((key) => packages[key]).find((item) => Array.isArray(item));
  if (!Array.isArray(row) || typeof row[0] !== "string") {
    return {};
  }
  const match = /^(@[^/]+\/[^@]+|[^@]+)@(.+)$/.exec(row[0]);
  const spec = match?.[2] ?? "";
  if (spec.startsWith("workspace:")) {
    const path = spec.slice(10);
    return localTarget(path, object(workspaces[path]).version, lock);
  }
  if (spec.startsWith("file:")) {
    return localTarget(spec.slice(5), object(row[1]).version ?? object(row[2]).version, lock);
  }
  return { external: true };
}
function boundLocator(spec: string): string | null {
  return new URLSearchParams(spec.split("::")[1] ?? "").get("locator");
}
function workspaceLocator(manifest: ReleaseManifest, lock: NativeLockSnapshot): string {
  return `${manifest.project.name}@workspace:${relative(lock.owner, resolve(lock.root, manifest.project.path)) || "."}`;
}
function modernSelectorMatches(selector: string, selectors: string[], locator: string): boolean {
  const base = selector.split("::")[0] ?? "";
  if (!selectors.includes(base)) {
    return false;
  }
  const binding = boundLocator(selector);
  return binding === null || binding === locator;
}
function modernFileResolution(
  manifest: ReleaseManifest,
  record: Record<string, unknown>,
  spec: string,
  lock: NativeLockSnapshot,
): Resolution {
  const binding = boundLocator(spec);
  if (binding !== workspaceLocator(manifest, lock)) {
    return {};
  }
  const parent = Object.values(lock.document)
    .map(object)
    .find((entry) => entry.resolution === binding);
  if (!parent) {
    return {};
  }
  const path = spec.split("::")[0]?.split("#")[0];
  if (!path) {
    return {};
  }
  return {
    path: resolve(lock.root, manifest.project.path, path),
    ...(typeof record.version === "string" ? { version: record.version } : {}),
  };
}
function modernResolution(
  manifest: ReleaseManifest,
  declaration: ReferenceDeclaration,
  lock: NativeLockSnapshot,
): Resolution {
  const selectors = [`${declaration.name}@${declaration.value}`, `${declaration.name}@npm:${declaration.value}`];
  const locator = workspaceLocator(manifest, lock);
  const matches = Object.entries(lock.document).filter(([key]) =>
    key.split(/,\s*/).some((selector) => modernSelectorMatches(selector, selectors, locator)),
  );
  if (matches.length !== 1) {
    return {};
  }
  const record = object(matches[0]?.[1]),
    resolution = record.resolution;
  if (typeof resolution !== "string") {
    return {};
  }
  const marker = resolution.indexOf("@workspace:");
  if (marker >= 0) {
    return localTarget(resolution.slice(marker + 11), undefined, lock);
  }
  const file = resolution.indexOf("@file:");
  if (file >= 0) {
    return modernFileResolution(manifest, record, resolution.slice(file + 6), lock);
  }
  return { external: true };
}
function classicRecord(manifest: ReleaseManifest, declaration: ReferenceDeclaration, lock: NativeLockSnapshot) {
  if (!declaration.value.startsWith("file:")) {
    return lock.records?.get(`${declaration.name}@${declaration.value}`);
  }
  const path = declaration.value.slice(5);
  const target = resolve(lock.root, manifest.project.path, path);
  const normalized = `${declaration.name}@file:${relative(lock.owner, target)}`;
  return (
    lock.records?.get(normalized) ??
    (posix.isAbsolute(path) ? lock.records?.get(`${declaration.name}@${declaration.value}`) : undefined)
  );
}
function classicResolution(
  manifest: ReleaseManifest,
  declaration: ReferenceDeclaration,
  manifests: readonly ReleaseManifest[],
  lock: NativeLockSnapshot,
): Resolution {
  const record = classicRecord(manifest, declaration, lock);
  if (/^(?:file:|link:)/.test(declaration.value) && record) {
    return {
      path: resolve(lock.root, manifest.project.path, declaration.value.slice(5)),
      ...(record.version ? { version: record.version } : {}),
    };
  }
  if (record) {
    return { external: true };
  }
  const member = manifests.find(
    (candidate) =>
      manifest.project.workspace &&
      candidate.project.workspace === manifest.project.workspace &&
      candidate.project.name === declaration.name &&
      candidate.participant.version &&
      satisfies(candidate.participant.version, declaration.value),
  );
  return member
    ? localTarget(relative(lock.owner, resolve(lock.root, member.project.path)), member.participant.version, lock)
    : {};
}
function binaryBunResolution(
  manifest: ReleaseManifest,
  declaration: ReferenceDeclaration,
  manifests: readonly ReleaseManifest[],
  lock: NativeLockSnapshot,
): Resolution {
  const workspace = manifests.find(
    (candidate) =>
      manifest.project.workspace &&
      candidate.project.workspace === manifest.project.workspace &&
      candidate.project.name === declaration.name,
  );
  const path = workspace ? relative(lock.owner, resolve(lock.root, workspace.project.path)) : null;
  if (path !== null) {
    const record = lock.records?.get(`${declaration.name}@${path}`);
    if (record) {
      return localTarget(path, record.version, lock);
    }
  }
  const record = lock.records?.get(`${declaration.name}@${declaration.value}`);
  if (!record) {
    return {};
  }
  return /^(?:file:|link:)/.test(declaration.value)
    ? {
        path: resolve(lock.root, manifest.project.path, declaration.value.slice(5)),
        ...(record.version ? { version: record.version } : {}),
      }
    : { external: true };
}
function pythonResolution(declaration: ReferenceDeclaration, lock: NativeLockSnapshot): Resolution {
  const packages = Array.isArray(lock.document.package) ? lock.document.package.map(object) : [];
  const matches = packages.filter(
    (pkg) => typeof pkg.name === "string" && normalizePythonName(pkg.name) === declaration.name,
  );
  if (matches.length !== 1) {
    return {};
  }
  const record = matches[0] ?? {},
    source = object(record.source);
  for (const key of ["editable", "virtual", "directory"]) {
    if (typeof source[key] === "string") {
      return localTarget(source[key], record.version, lock);
    }
  }
  return { external: true };
}
function resolution(
  manifest: ReleaseManifest,
  declaration: ReferenceDeclaration,
  manifests: readonly ReleaseManifest[],
  lock: NativeLockSnapshot,
): Resolution {
  switch (lock.format) {
    case "npm":
      return npmResolution(manifest, declaration, lock);
    case "pnpm":
      return pnpmResolution(manifest, declaration, lock);
    case "bun":
      return bunResolution(manifest, declaration, lock);
    case "modern":
      return modernResolution(manifest, declaration, lock);
    case "classic":
      return classicResolution(manifest, declaration, manifests, lock);
    case "binary-bun":
      return binaryBunResolution(manifest, declaration, manifests, lock);
    case "uv":
      return pythonResolution(declaration, lock);
    default:
      return {};
  }
}
function referenceName(manifest: ReleaseManifest): string {
  const name = manifest.project.name ?? "";
  return manifest.project.ecosystem === "python" ? normalizePythonName(name) : name;
}
export function resolveReferenceEvidence(
  manifest: ReleaseManifest,
  declaration: ReferenceDeclaration,
  manifests: readonly ReleaseManifest[],
  lock: NativeLockSnapshot,
): NativeReferenceEvidence {
  const base = { from: manifest.project.project_id, name: declaration.name, field: declaration.field };
  const found = resolution(manifest, declaration, manifests, lock);
  if (found.external) {
    return { ...base, source: "external" };
  }
  if (found.path) {
    const target = manifests.find(
      (candidate) =>
        resolve(lock.root, candidate.project.path) === found.path &&
        candidate.project.ecosystem === manifest.project.ecosystem,
    );
    if (target && referenceName(target) === declaration.name) {
      return {
        ...base,
        source: "local",
        target_project_id: target.project.project_id,
        ...(found.version ? { version: found.version } : {}),
      };
    }
    return { ...base, source: "ambiguous" };
  }
  const maybeLocal =
    /^(?:workspace:|file:|link:)/.test(declaration.constraint) ||
    manifests.some((candidate) => candidate.project.name === declaration.name);
  return { ...base, source: maybeLocal ? "ambiguous" : "external" };
}
async function readBinaryLock(root: string, scope: ManagerScope, path: string, signal?: AbortSignal) {
  const project = {
    ...scope,
    project_id: "",
    path: relative(root, scope.cwd),
    manifest: "",
    ecosystem: "javascript" as const,
    managerRoot: relative(root, scope.owner),
    managerCandidates: ["bun"],
    frameworks: [],
    status: "detected" as const,
    evidence: [],
  };
  const executable = await resolveExecutable(root, project, signal, scope);
  const result = await runProcess(executable.command, [path], {
    cwd: scope.owner,
    env: scope.env,
    signal,
    limit: 16 * 1024 * 1024,
  });
  if (result.exit_code !== 0 || result.cancelled || result.truncated) {
    throw new ReleaseError("incomplete-lock", "Could not read binary Bun release lock");
  }
  return binaryLockRecords(result.stdout);
}
function lockFiles(manager: string): string[] {
  const names: Record<string, string[]> = {
    npm: ["npm-shrinkwrap.json", "package-lock.json"],
    pnpm: ["pnpm-lock.yaml"],
    bun: ["bun.lock", "bun.lockb"],
    uv: ["uv.lock"],
  };
  return names[manager] ?? ["yarn.lock"];
}
function parseLock(manager: string, text: string): Pick<NativeLockSnapshot, "format" | "document" | "records"> {
  switch (manager) {
    case "npm":
      return { format: "npm", document: object(JSON.parse(text)) };
    case "pnpm":
      return { format: "pnpm", document: object(yaml(text)) };
    case "bun":
      return { format: "bun", document: object(Bun.JSONC.parse(text)) };
    case "uv":
      return { format: "uv", document: object(toml(text)) };
  }
  return /^__metadata:/m.test(text)
    ? { format: "modern", document: object(yaml(text)) }
    : { format: "classic", document: {}, records: binaryLockRecords(text) };
}
export async function readNativeLock(
  root: string,
  scope: ManagerScope,
  signal?: AbortSignal,
): Promise<NativeLockSnapshot> {
  const directory = scope.pnpm?.lockDirectory ?? scope.owner;
  const base = { root, owner: scope.owner, directory, manager: scope.manager, document: {} };
  const files = lockFiles(scope.manager);
  for (const filename of files) {
    signal?.throwIfAborted();
    const path = join(directory, filename),
      snapshot = await readProjectionFile(root, path);
    if (snapshot.text === null) {
      continue;
    }
    if (filename === "bun.lockb") {
      return { ...base, path, format: "binary-bun", records: await readBinaryLock(root, scope, path, signal) };
    }
    return { ...base, path, ...parseLock(scope.manager, snapshot.text) };
  }
  return { ...base, format: "missing" };
}
export async function gatherNativeReferenceEvidence(
  repo: ReleaseRepository,
  signal?: AbortSignal,
): Promise<NativeReferenceEvidence[]> {
  const locks = new Map<string, NativeLockSnapshot>();
  const evidence: NativeReferenceEvidence[] = [];
  for (const manifest of repo.manifests) {
    const scope = repo.scopes.get(manifest.project.project_id);
    if (!scope) {
      continue;
    }
    const key = `${scope.manager}:${scope.owner}:${scope.pnpm?.lockDirectory ?? ""}`;
    let lock = locks.get(key);
    if (!lock) {
      lock = await readNativeLock(repo.git.root, scope, signal);
      locks.set(key, lock);
    }
    for (const declaration of referenceDeclarations(manifest)) {
      evidence.push(resolveReferenceEvidence(manifest, declaration, repo.manifests, lock));
    }
  }
  return evidence;
}
