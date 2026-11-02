import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as toml } from "smol-toml";
import { type Project } from "../inspect/model";
import { parseGo } from "../inspect/readers/go";
import { normalizePythonName } from "../inspect/readers/manifest";
import { type Dependency, DependencyError, type Group, type Inventory } from "./model";
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
export function sourceOf(specifier: string): Dependency["source"] {
  const kind = /^workspace:/.test(specifier)
    ? "workspace"
    : /^(file:|link:|portal:|\.\.?\/)/.test(specifier)
      ? "path"
      : /^(git[+:]|https?:.*\.git|ssh:|github:|gitlab:|bitbucket:)/.test(specifier)
        ? "git"
        : /^(catalog:|patch:|https?:|npm:)/.test(specifier)
          ? "unknown"
          : "registry";
  return { kind, specifier };
}
export async function readInventory(root: string, project: Project): Promise<Inventory> {
  const text = await readFile(join(root, project.manifest), "utf8");
  const data = manifestData(project, text);
  const ownerText =
    project.ecosystem === "python" && project.managerRoot !== project.path
      ? await readFile(join(root, project.managerRoot, "pyproject.toml"), "utf8")
      : undefined;
  return inventoryFromDocument(project, text, data, ownerText);
}
export function parseInventory(project: Project, text: string, ownerText?: string): Inventory {
  return inventoryFromDocument(project, text, manifestData(project, text), ownerText);
}
function manifestData(project: Project, text: string): Record<string, unknown> {
  if (project.ecosystem === "javascript") {
    return object(JSON.parse(text));
  }
  if (project.ecosystem === "python") {
    return object(toml(text));
  }
  return {};
}
function inventoryFromDocument(
  project: Project,
  text: string,
  data: Record<string, unknown>,
  ownerText?: string,
): Inventory {
  const dependencies: Dependency[] = [];
  const add = (name: string, group: Group, spec: string, field: string, extra: Partial<Dependency> = {}) =>
    dependencies.push({
      name,
      group,
      declared_specifier: spec,
      source: sourceOf(spec),
      direct: true,
      evidence: { file: project.manifest, field },
      ...extra,
    });
  if (project.ecosystem === "javascript") {
    for (const [field, kind] of [
      ["dependencies", "runtime"],
      ["devDependencies", "dev"],
      ["optionalDependencies", "optional"],
      ["peerDependencies", "peer"],
    ] as const) {
      for (const [name, spec] of Object.entries(object(data[field]))) {
        if (typeof spec !== "string") {
          throw new DependencyError("invalid-manifest", `${field}.${name} must be text`);
        }
        add(name, { kind }, spec, `${field}.${name}`);
      }
    }
  } else if (project.ecosystem === "python") {
    const metadata = object(data.project),
      uv = object(object(data.tool).uv);
    let inherited: Record<string, unknown> = {};
    if (ownerText !== undefined) {
      const owner = object(toml(ownerText));
      inherited = object(object(object(owner.tool).uv).sources);
    }
    const sources = { ...inherited, ...object(uv.sources) };
    const groups = object(data["dependency-groups"]);
    const visit = (items: unknown, group: Group, field: string, stack: string[] = []) => {
      if (!Array.isArray(items)) {
        return;
      }
      for (const item of items) {
        if (typeof item !== "string") {
          const included = object(item)["include-group"];
          if (typeof included === "string") {
            if (stack.includes(included)) {
              throw new DependencyError("invalid-manifest", "Cyclic Python dependency group");
            }
            // Included entries belong to their original declaration, not a writable copy.
            continue;
          }
          continue;
        }
        const match = /^([A-Za-z0-9_.-]+)(?:\[([^\]]+)\])?\s*(.*)$/.exec(item);
        if (!match?.[1]) {
          throw new DependencyError("invalid-manifest", "Invalid Python requirement");
        }
        const name = normalizePythonName(match[1]);
        const rest = match[3] ?? "",
          split = rest.indexOf(";");
        const spec = (split < 0 ? rest : rest.slice(0, split)).trim();
        const marker = split < 0 ? undefined : rest.slice(split + 1).trim();
        const nativeSource = sources[Object.keys(sources).find((k) => normalizePythonName(k) === name) ?? name];
        const s = object(nativeSource);
        let source = spec.startsWith("@") ? sourceOf(spec.slice(1).trim()) : sourceOf(spec);
        if (s.workspace === true) {
          source = { kind: "workspace" };
        } else if (typeof s.path === "string") {
          source = { kind: "path", specifier: s.path };
        } else if (typeof s.git === "string") {
          source = { kind: "git", specifier: s.git };
        } else if (s.url || Array.isArray(nativeSource)) {
          source = { kind: "unknown" };
        }
        add(name, group, spec, field, {
          source,
          ...(marker ? { marker } : {}),
          ...(match[2] ? { extras: match[2].split(",").map((v) => v.trim()) } : {}),
          ...(Array.isArray(nativeSource) || s.marker || s.extra || s.group ? { ambiguous: true } : {}),
        });
      }
    };
    visit(metadata.dependencies, { kind: "runtime" }, "project.dependencies");
    for (const [name, values] of Object.entries(groups)) {
      visit(values, name === "dev" ? { kind: "dev" } : { kind: "named", name }, `dependency-groups.${name}`, [name]);
    }
    for (const [name, values] of Object.entries(object(metadata["optional-dependencies"]))) {
      visit(values, { kind: "extra", name }, `project.optional-dependencies.${name}`);
    }
  } else {
    const doc = parseGo(text, "mod");
    const indirect = new Set<string>();
    for (const line of text.split("\n")) {
      const m = /^\s*(?:require\s+)?([^\s()]+)\s+v[^\s]+\s*\/\/\s*indirect\b/.exec(line);
      if (m?.[1]) {
        indirect.add(m[1]);
      }
    }
    for (const requirement of doc.requires) {
      const replacements = doc.replaces.filter(
        (r) => r.name === requirement.name && (!r.version || r.version === requirement.version),
      );
      const replacement = replacements[0];
      add(requirement.name, { kind: "runtime" }, requirement.version, "require", {
        direct: !indirect.has(requirement.name),
        source: replacement
          ? {
              kind: replacement.targetVersion ? "unknown" : "path",
              specifier: replacement.target,
            }
          : { kind: "registry" },
        ...(replacements.length > 1 ? { ambiguous: true } : {}),
      });
    }
  }
  return { dependencies, complete: true, diagnostics: [] };
}
