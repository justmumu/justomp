import { posix } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";
import { projectId } from "../identity";
import {
  type Diagnostic,
  type Ecosystem,
  type Evidence,
  type LocalReference,
  type ParsedManifest,
  type ParsedProject,
  type Project,
} from "../model";
import { parseGo } from "./go";

type ObjectValue = Record<string, unknown>;
function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as ObjectValue;
}
function optionalObject(value: unknown, label: string): ObjectValue {
  return value === undefined ? {} : object(value, label);
}
function strings(value: unknown, label: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return value;
}
function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}
function evidence(file: string, field: string, value?: string): Evidence {
  return { file, field, ...(value === undefined ? {} : { value }) };
}
function project(path: string, file: string, ecosystem: Ecosystem, name?: string): Project {
  return {
    project_id: projectId(ecosystem, file),
    managerRoot: path,
    path,
    manifest: file,
    ecosystem,
    ...(name ? { name } : {}),
    managerCandidates: [],
    frameworks: [],
    status: "detected",
    evidence: [evidence(file, name ? "name" : "manifest", name)],
  };
}
function diagnostic(code: string, path: string, message: string, field?: string): Diagnostic {
  return {
    code,
    path,
    message,
    ...(field ? { evidence: evidence(path, field) } : {}),
  };
}
function js(file: string, path: string, source: string): ParsedManifest {
  const data = object(JSON.parse(source), "package.json");
  const p = project(path, file, "javascript", optionalString(data.name, "name"));
  const diagnostics: Diagnostic[] = [];
  const references: LocalReference[] = [];
  if (data.packageManager !== undefined) {
    const manager = optionalString(data.packageManager, "packageManager") as string;
    const match = /^(npm|pnpm|yarn|bun)@(.+)$/.exec(manager);
    if (match?.[1]) {
      p.managerCandidates.push(match[1]);
      p.managerVersion = match[2];
    } else {
      p.status = "ambiguous";
      diagnostics.push(
        diagnostic("unsupported-manager", file, `Unsupported packageManager ${manager}`, "packageManager"),
      );
    }
    p.evidence.push(evidence(file, "packageManager", manager));
  }
  const engines = optionalObject(data.engines, "engines");
  p.runtime = {};
  for (const [name, version] of Object.entries(engines)) {
    if (typeof version !== "string") {
      throw new Error(`engines.${name} must be a string`);
    }
    p.runtime[name] = version;
    p.evidence.push(evidence(file, `engines.${name}`, version));
  }
  for (const group of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, spec] of Object.entries(optionalObject(data[group], group))) {
      if (typeof spec !== "string") {
        throw new Error(`${group}.${name} must be a string`);
      }
      const ev = evidence(file, `${group}.${name}`, spec);
      if (["next", "react", "vue", "svelte", "typescript"].includes(name)) {
        p.frameworks.push(name);
        p.evidence.push(ev);
      }
      if (spec.startsWith("workspace:")) {
        const value = spec.slice(10);
        if (value.startsWith(".")) {
          references.push({
            name,
            target: value,
            kind: "workspace-path",
            evidence: ev,
          });
        } else if (["*", "^", "~"].includes(value) || /^[~^]?\d/.test(value)) {
          references.push({
            name,
            workspace: true,
            kind: "workspace",
            evidence: ev,
          });
        } else {
          diagnostics.push(
            diagnostic("unresolved", file, `Unsupported workspace alias ${name}: ${spec}`, `${group}.${name}`),
          );
        }
      } else if (spec.startsWith("file:") || spec.startsWith("link:")) {
        references.push({
          name,
          target: spec.slice(5),
          kind: spec.startsWith("file:") ? "file" : "link",
          evidence: ev,
        });
      } else if (spec.startsWith("catalog:")) {
        diagnostics.push(
          diagnostic("unresolved", file, `Catalog dependency ${name} is not resolved`, `${group}.${name}`),
        );
      }
    }
  }
  let workspace: ParsedManifest["workspace"];
  if (data.workspaces !== undefined) {
    const definition = Array.isArray(data.workspaces)
      ? data.workspaces
      : object(data.workspaces, "workspaces").packages;
    workspace = {
      kind: "unsupported",
      path,
      file,
      includes: strings(definition, "workspaces"),
      excludes: [],
      unsupported: true,
    };
  }
  return {
    project: { project: p, references },
    ...(workspace ? { workspace } : {}),
    diagnostics,
  };
}
function python(file: string, path: string, source: string): ParsedManifest {
  const data = parseToml(source) as ObjectValue;
  const tool = optionalObject(data.tool, "tool"),
    uv = optionalObject(tool.uv, "tool.uv");
  const requiredVersion = optionalString(uv["required-version"], "tool.uv.required-version");
  const diagnostics: Diagnostic[] = [];
  const references: LocalReference[] = [];
  const uvSources: Record<string, LocalReference | null> = {};
  for (const [name, value] of Object.entries(optionalObject(uv.sources, "tool.uv.sources"))) {
    const field = `tool.uv.sources.${name}`;
    uvSources[normalizePythonName(name)] = null;
    if (Array.isArray(value)) {
      diagnostics.push(diagnostic("unresolved", file, `Conditional uv sources for ${name} are not resolved`, field));
      continue;
    }
    const s = object(value, field);
    if (s.marker !== undefined || s.extra !== undefined || s.group !== undefined) {
      diagnostics.push(diagnostic("unresolved", file, `Conditional uv source ${name} is not resolved`, field));
      continue;
    }
    if (s.workspace === true) {
      uvSources[normalizePythonName(name)] = {
        name,
        workspace: true,
        kind: "uv-workspace",
        evidence: evidence(file, field),
      };
    } else if (s.path !== undefined) {
      uvSources[normalizePythonName(name)] = {
        name,
        target: optionalString(s.path, `${field}.path`),
        kind: "uv-path",
        evidence: evidence(file, field),
      };
    }
  }
  let metadata: ObjectValue | undefined = data.project === undefined ? undefined : object(data.project, "project");
  let poetry = false;
  if (!metadata && tool.poetry !== undefined) {
    metadata = object(tool.poetry, "tool.poetry");
    poetry = true;
    diagnostics.push(
      diagnostic(
        "unsupported-manager",
        file,
        "Poetry metadata detected; Poetry local relationships are unresolved",
        "tool.poetry",
      ),
    );
  }
  let parsed: ParsedProject | undefined;
  if (metadata) {
    const name = optionalString(metadata.name, poetry ? "tool.poetry.name" : "project.name");
    if (!name) {
      throw new Error("Python project metadata requires a name");
    }
    const p = project(path, file, "python", name);
    p.evidence[0] = evidence(file, poetry ? "tool.poetry.name" : "project.name", name);
    if (poetry) {
      p.managerCandidates.push("poetry");
    }
    if (Object.keys(uv).length) {
      p.managerCandidates.push("uv");
    }
    if (requiredVersion) {
      p.managerVersion = requiredVersion;
      p.evidence.push(evidence(file, "tool.uv.required-version", requiredVersion));
    }
    const runtime = optionalString(metadata["requires-python"], "project.requires-python");
    if (runtime) {
      p.runtime = { python: runtime };
      p.evidence.push(evidence(file, "project.requires-python", runtime));
    }
    const requirements = poetry ? [] : strings(metadata.dependencies, "project.dependencies");
    const optional = optionalObject(metadata["optional-dependencies"], "project.optional-dependencies");
    for (const [group, values] of Object.entries(optional)) {
      requirements.push(...strings(values, `project.optional-dependencies.${group}`));
    }
    const groups = optionalObject(data["dependency-groups"], "dependency-groups");
    for (const [group, items] of Object.entries(groups)) {
      if (!Array.isArray(items)) {
        throw new Error(`dependency-groups.${group} must be an array`);
      }
      for (const item of items) {
        if (typeof item === "string") {
          requirements.push(item);
        }
      }
    }
    const names = new Set(requirements.map((r) => normalizePythonName(/^([A-Za-z0-9_.-]+)/.exec(r)?.[1] ?? "")));
    for (const dependency of requirements) {
      const name = /^([A-Za-z0-9_.-]+)/.exec(dependency)?.[1];
      if (name && ["fastapi", "django", "flask"].includes(normalizePythonName(name))) {
        p.frameworks.push(name);
        p.evidence.push(evidence(file, "project.dependencies", dependency));
      }
      const direct = /^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?\s*@\s*(\.?\.?\/[^; ]+|file:[^; ]+)/.exec(dependency);
      if (direct?.[1] && direct[2]) {
        references.push({
          name: direct[1],
          target: direct[2].replace(/^file:/, ""),
          kind: "python-path",
          evidence: evidence(file, "project.dependencies", dependency),
        });
      }
    }

    parsed = { project: p, references, dependencyNames: [...names], uvSources };
  } else {
    diagnostics.push(
      diagnostic("tooling-only", file, "No Python project metadata; tooling/workspace declaration only"),
    );
  }
  let workspace: ParsedManifest["workspace"];
  if (uv.workspace !== undefined) {
    const w = object(uv.workspace, "tool.uv.workspace");
    workspace = {
      kind: "uv",
      path,
      file,
      includes: strings(w.members, "tool.uv.workspace.members"),
      excludes: strings(w.exclude, "tool.uv.workspace.exclude"),
      uvSources,
      ...(requiredVersion ? { managerVersion: requiredVersion } : {}),
    };
  }
  return {
    ...(parsed ? { project: parsed } : {}),
    ...(workspace ? { workspace } : {}),
    diagnostics,
  };
}
export function normalizePythonName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}
export function readManifest(file: string, source: string): ParsedManifest {
  const path = posix.dirname(file);
  const name = posix.basename(file);
  if (name === "package.json") {
    return js(file, path, source);
  }
  if (name === "pyproject.toml") {
    return python(file, path, source);
  }
  if (name === "pnpm-workspace.yaml") {
    const doc = parseDocument(source, { uniqueKeys: true });
    if (doc.errors.length) {
      throw new Error(doc.errors.map((e) => e.message).join("; "));
    }
    const data = object(doc.toJS(), "pnpm-workspace.yaml");
    const patterns = strings(data.packages, "packages");
    return {
      workspace: {
        kind: "pnpm",
        path,
        file,
        includes: patterns.filter((p) => !p.startsWith("!")),
        excludes: patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1)),
      },
      diagnostics: [],
    };
  }
  const parsed = parseGo(source, name === "go.mod" ? "mod" : "work");
  const diagnostics = parsed.unsupported.map((d) =>
    diagnostic("unsupported-go-directive", file, `Directive ${d} is retained as unresolved metadata`, d),
  );
  if (name === "go.work") {
    return {
      workspace: {
        kind: "go",
        path,
        file,
        includes: parsed.uses,
        excludes: [],
      },
      replaces: parsed.replaces,
      diagnostics,
    };
  }
  const p = project(path, file, "go", parsed.module);
  p.evidence[0] = evidence(file, "module", parsed.module);
  p.managerCandidates = ["go"];
  if (parsed.go) {
    p.runtime = { go: parsed.go };
    p.evidence.push(evidence(file, "go", parsed.go));
  }
  return {
    project: {
      project: p,
      references: [],
      requires: parsed.requires,
      replaces: parsed.replaces,
    },
    diagnostics,
  };
}
