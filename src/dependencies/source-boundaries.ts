import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as toml } from "smol-toml";
import { parseDocument } from "yaml";
import { type PackagingStructure, type Project } from "../inspect/model";
import { parseGo } from "../inspect/readers/go";
import { object } from "./inventory";
import { DependencyError } from "./model";
import { safePath } from "./paths";

// Inspection deliberately omits excluded/symlink targets and conditional sources.
// Native managers still consume those declarations, so check their original values
// before probing or executing a manager, independently of inspection's edges.
export async function validateExistingSources(
  root: string,
  project: Project,
  structure: PackagingStructure,
): Promise<void> {
  root = await realpath(root);
  const owner = resolve(root, project.managerRoot);
  const manifests = new Set(
    structure.projects
      .filter((member) => member.ecosystem === project.ecosystem && member.managerRoot === project.managerRoot)
      .map((member) => resolve(root, member.manifest)),
  );
  manifests.add(resolve(root, project.manifest));

  if (project.ecosystem === "javascript") {
    await javascriptSources(root, owner, project.manager, manifests);
  } else if (project.ecosystem === "python") {
    await pythonSources(root, owner, manifests);
  } else {
    await goSources(root, owner, manifests);
  }
}
async function check(root: string, base: string, path: string) {
  const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  await safePath(root, resolve(base, expanded));
}
async function read(root: string, file: string): Promise<string | undefined> {
  await safePath(root, file);
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
const filePath = (value: string) =>
  value.startsWith("file://") ? fileURLToPath(value) : decodeURIComponent(value.replace(/^file:/, ""));
async function specifier(root: string, base: string, value: string) {
  if (value.startsWith("file:")) {
    await check(root, base, filePath(value));
    return;
  }
  if (/^(link:|portal:)/.test(value)) {
    await check(root, base, value.slice(value.indexOf(":") + 1));
    return;
  }
  if (value.startsWith("workspace:")) {
    const path = value.slice("workspace:".length);
    if (path.startsWith(".") || isAbsolute(path)) {
      await check(root, base, path);
    }
    return;
  }
  if (/^(\.\.?\/|~\/)/.test(value) || isAbsolute(value)) {
    await check(root, base, value);
  }
}
async function values(root: string, base: string, value: unknown): Promise<void> {
  if (typeof value === "string") {
    await specifier(root, base, value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      await values(root, base, item);
    }
  } else {
    for (const item of Object.values(object(value))) {
      await values(root, base, item);
    }
  }
}
async function requirements(root: string, base: string, items: unknown): Promise<void> {
  if (!Array.isArray(items)) {
    return;
  }
  for (const item of items) {
    if (typeof item !== "string") {
      continue;
    }
    // PEP 508 direct references have a name/extras followed by @ and a URL.
    const direct = /^[A-Za-z0-9_.-]+(?:\[[^\]]*\])?\s*@\s*(\S+)/.exec(item);
    if (direct?.[1]) {
      await specifier(root, base, direct[1].trim());
    } else {
      await specifier(root, base, item.split(";")[0]?.trim() ?? "");
    }
  }
}
async function source(root: string, base: string, value: unknown): Promise<void> {
  if (Array.isArray(value)) {
    for (const candidate of value) {
      await source(root, base, candidate);
    }
    return;
  }
  const entry = object(value);
  if (typeof entry.path === "string") {
    await check(root, base, entry.path);
  }
  if (typeof entry.url === "string") {
    await specifier(root, base, entry.url);
  }
}

async function javascriptSources(root: string, owner: string, manager: string | undefined, manifests: Set<string>) {
  manifests.add(join(owner, "package.json"));
  for (const file of manifests) {
    const text = await read(root, file);
    if (text === undefined) {
      continue;
    }
    await javascriptManifestSources(root, owner, file, text);
  }
  if (manager === "pnpm") {
    await pnpmCatalogSources(root, owner);
  }
}

async function pythonSources(root: string, owner: string, manifests: Set<string>) {
  manifests.add(join(owner, "pyproject.toml"));
  for (const file of manifests) {
    const text = await read(root, file);
    if (text === undefined) {
      continue;
    }
    await pythonManifestSources(root, file, text);
  }
}
async function goSources(root: string, owner: string, manifests: Set<string>) {
  const work = join(owner, "go.work");
  const text = await read(root, work);
  if (text !== undefined) {
    const document = parseGo(text, "work");
    for (const path of document.uses) {
      await check(root, owner, path);
      manifests.add(resolve(owner, path, "go.mod"));
    }
    await replacementSources(root, owner, document);
  }
  for (const file of manifests) {
    const text = await read(root, file);
    if (text === undefined) {
      continue;
    }
    await replacementSources(root, dirname(file), parseGo(text, "mod"));
  }
}

async function javascriptManifestSources(root: string, owner: string, file: string, text: string) {
  const data = object(JSON.parse(text));
  const base = dirname(file);
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    await values(root, base, data[field]);
  }
  // Native overrides and catalogs are owned by the workspace root.
  if (base === owner) {
    for (const field of ["overrides", "resolutions", "catalog", "catalogs"]) {
      await values(root, base, data[field]);
    }
    await values(root, base, object(data.pnpm).overrides);
    const workspaces = object(data.workspaces);
    await values(root, base, workspaces.catalog);
    await values(root, base, workspaces.catalogs);
  }
}

async function pythonManifestSources(root: string, file: string, text: string) {
  const data = object(toml(text));
  const base = dirname(file);
  const metadata = object(data.project);
  const uv = object(object(data.tool).uv);
  // Root sources retain the root as their base when inherited by members.
  for (const entry of Object.values(object(uv.sources))) {
    await source(root, base, entry);
  }
  await requirements(root, base, metadata.dependencies);
  for (const items of Object.values(object(metadata["optional-dependencies"]))) {
    await requirements(root, base, items);
  }
  for (const items of Object.values(object(data["dependency-groups"]))) {
    await requirements(root, base, items);
  }
  for (const field of [
    "dev-dependencies",
    "override-dependencies",
    "constraint-dependencies",
    "build-constraint-dependencies",
  ]) {
    await requirements(root, base, uv[field]);
  }
  await requirements(root, base, object(data["build-system"]).requires);
}

async function pnpmCatalogSources(root: string, owner: string) {
  const text = await read(root, join(owner, "pnpm-workspace.yaml"));
  if (text !== undefined) {
    const document = parseDocument(text);
    if (document.errors.length) {
      throw new DependencyError("invalid-config", "Invalid pnpm-workspace.yaml");
    }
    const data = object(document.toJS());
    for (const field of ["overrides", "catalog", "catalogs"]) {
      await values(root, owner, data[field]);
    }
  }
}

async function replacementSources(root: string, base: string, document: ReturnType<typeof parseGo>) {
  for (const replacement of document.replaces) {
    if (!replacement.targetVersion) {
      await check(root, base, replacement.target);
    }
  }
}
