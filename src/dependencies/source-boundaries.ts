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

  const check = async (base: string, path: string) => {
    const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
    await safePath(root, resolve(base, expanded));
  };
  const read = async (file: string): Promise<string | undefined> => {
    await safePath(root, file);
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  };
  const filePath = (value: string) =>
    value.startsWith("file://") ? fileURLToPath(value) : decodeURIComponent(value.replace(/^file:/, ""));
  const specifier = async (base: string, value: string) => {
    if (value.startsWith("file:")) {
      await check(base, filePath(value));
    } else if (/^(link:|portal:)/.test(value)) {
      await check(base, value.slice(value.indexOf(":") + 1));
    } else if (value.startsWith("workspace:")) {
      const path = value.slice("workspace:".length);
      if (path.startsWith(".") || isAbsolute(path)) {
        await check(base, path);
      }
    } else if (/^(\.\.?\/|~\/)/.test(value) || isAbsolute(value)) {
      await check(base, value);
    }
  };
  const values = async (base: string, value: unknown): Promise<void> => {
    if (typeof value === "string") {
      await specifier(base, value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        await values(base, item);
      }
    } else {
      for (const item of Object.values(object(value))) {
        await values(base, item);
      }
    }
  };
  if (project.ecosystem === "javascript") {
    manifests.add(join(owner, "package.json"));
    for (const file of manifests) {
      const text = await read(file);
      if (text === undefined) {
        continue;
      }
      const data = object(JSON.parse(text));
      const base = dirname(file);
      for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        await values(base, data[field]);
      }
      // Native overrides and catalogs are owned by the workspace root.
      if (base === owner) {
        for (const field of ["overrides", "resolutions", "catalog", "catalogs"]) {
          await values(base, data[field]);
        }
        await values(base, object(data.pnpm).overrides);
        const workspaces = object(data.workspaces);
        await values(base, workspaces.catalog);
        await values(base, workspaces.catalogs);
      }
    }
    if (project.manager === "pnpm") {
      const text = await read(join(owner, "pnpm-workspace.yaml"));
      if (text !== undefined) {
        const document = parseDocument(text);
        if (document.errors.length) {
          throw new DependencyError("invalid-config", "Invalid pnpm-workspace.yaml");
        }
        const data = object(document.toJS());
        for (const field of ["overrides", "catalog", "catalogs"]) {
          await values(owner, data[field]);
        }
      }
    }
  } else if (project.ecosystem === "python") {
    manifests.add(join(owner, "pyproject.toml"));
    const requirements = async (base: string, items: unknown): Promise<void> => {
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
          await specifier(base, direct[1].trim());
        } else {
          await specifier(base, item.split(";")[0]?.trim() ?? "");
        }
      }
    };
    const source = async (base: string, value: unknown): Promise<void> => {
      if (Array.isArray(value)) {
        for (const candidate of value) {
          await source(base, candidate);
        }
        return;
      }
      const entry = object(value);
      if (typeof entry.path === "string") {
        await check(base, entry.path);
      }
      if (typeof entry.url === "string") {
        await specifier(base, entry.url);
      }
    };
    for (const file of manifests) {
      const text = await read(file);
      if (text === undefined) {
        continue;
      }
      const data = object(toml(text));
      const base = dirname(file);
      const metadata = object(data.project);
      const uv = object(object(data.tool).uv);
      // Root sources retain the root as their base when inherited by members.
      for (const entry of Object.values(object(uv.sources))) {
        await source(base, entry);
      }
      await requirements(base, metadata.dependencies);
      for (const items of Object.values(object(metadata["optional-dependencies"]))) {
        await requirements(base, items);
      }
      for (const items of Object.values(object(data["dependency-groups"]))) {
        await requirements(base, items);
      }
      for (const field of [
        "dev-dependencies",
        "override-dependencies",
        "constraint-dependencies",
        "build-constraint-dependencies",
      ]) {
        await requirements(base, uv[field]);
      }
      await requirements(base, object(data["build-system"]).requires);
    }
  } else {
    const work = join(owner, "go.work");
    const text = await read(work);
    if (text !== undefined) {
      const document = parseGo(text, "work");
      for (const path of document.uses) {
        await check(owner, path);
        manifests.add(resolve(owner, path, "go.mod"));
      }
      for (const replacement of document.replaces) {
        if (!replacement.targetVersion) {
          await check(owner, replacement.target);
        }
      }
    }
    for (const file of manifests) {
      const text = await read(file);
      if (text === undefined) {
        continue;
      }
      for (const replacement of parseGo(text, "mod").replaces) {
        if (!replacement.targetVersion) {
          await check(dirname(file), replacement.target);
        }
      }
    }
  }
}
