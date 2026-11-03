import { satisfies, validRange } from "semver";
import { normalizePythonName } from "../inspect/readers/manifest";
import { ReleaseError } from "./model";
import { type ReleaseManifest, releaseObject } from "./participants";

export interface NativeReferenceEvidence {
  from: string;
  name: string;
  field: string[];
  source: "local" | "external" | "ambiguous";
  target_project_id?: string;
  version?: string;
  constraint?: string;
}
export interface ReferenceDeclaration {
  name: string;
  field: string[];
  value: string;
  constraint: string;
  prefix: string;
  suffix: string;
  peer: boolean;
}
export interface ReferenceEdit {
  manifest: string;
  field: string[];
  before: string;
  after: string;
  target_project_id: string;
}
function pythonDeclaration(value: string, field: string[]): ReferenceDeclaration {
  const match = /^(\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*)([^;]*?)(\s*(?:;.*)?)$/.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new ReleaseError("unsupported-reference", `Cannot parse Python release dependency at ${field.join(".")}`);
  }
  return {
    name: normalizePythonName(match[2]),
    field,
    value,
    constraint: (match[3] ?? "").trim(),
    prefix: match[1],
    suffix: match[4] ?? "",
    peer: false,
  };
}
function pythonDeclarations(data: Record<string, unknown>): ReferenceDeclaration[] {
  const declarations: ReferenceDeclaration[] = [];
  const add = (value: unknown, field: string[]) => {
    if (!Array.isArray(value)) {
      return;
    }
    value.forEach((item, index) => {
      if (typeof item === "string") {
        declarations.push(pythonDeclaration(item, [...field, String(index)]));
      }
    });
  };
  const project = releaseObject(data.project);
  add(project.dependencies, ["project", "dependencies"]);
  for (const [group, value] of Object.entries(releaseObject(project["optional-dependencies"]))) {
    add(value, ["project", "optional-dependencies", group]);
  }
  for (const [group, value] of Object.entries(releaseObject(data["dependency-groups"]))) {
    add(value, ["dependency-groups", group]);
  }
  add(releaseObject(releaseObject(data.tool).uv)["dev-dependencies"], ["tool", "uv", "dev-dependencies"]);
  return declarations;
}
export function referenceDeclarations(manifest: ReleaseManifest): ReferenceDeclaration[] {
  if (manifest.project.ecosystem === "python") {
    return pythonDeclarations(manifest.data);
  }
  if (manifest.project.ecosystem === "go") {
    return [];
  }
  const declarations: ReferenceDeclaration[] = [];
  for (const group of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, value] of Object.entries(releaseObject(manifest.data[group]))) {
      if (typeof value !== "string") {
        throw new ReleaseError("invalid-reference", `${manifest.project.manifest}: ${group}.${name} must be a string`);
      }
      declarations.push({
        name,
        field: [group, name],
        value,
        constraint: value,
        prefix: "",
        suffix: "",
        peer: group === "peerDependencies",
      });
    }
  }
  return declarations;
}
function compatiblePython(constraint: string, target: string): boolean {
  if (!constraint) {
    return true;
  }
  const compatible = /^~=([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(constraint);
  if (compatible) {
    return satisfies(target, `>=${constraint.slice(2)} <${compatible[1]}.${Number(compatible[2]) + 1}.0`);
  }
  const clauses = constraint.split(",").map((part) => part.trim());
  if (!clauses.every((clause) => /^(?:==|>=|<=|>|<)\s*\d+\.\d+\.\d+$/.test(clause))) {
    return false;
  }
  return satisfies(target, clauses.map((clause) => clause.replace(/^==/, "=")).join(" "));
}
function rewritePythonConstraint(spec: string, target: string): string | null {
  if (spec.startsWith("@") || compatiblePython(spec, target)) {
    return spec;
  }
  const exact = /^(==|~=)\s*\d+\.\d+\.\d+$/.exec(spec);
  return exact?.[1] ? `${exact[1]}${target}` : null;
}
function acceptsJavascriptTarget(raw: string, evidence: NativeReferenceEvidence, target: string): boolean {
  const alias = raw.startsWith("npm:") ? raw.slice(raw.lastIndexOf("@") + 1) : raw;
  const constraint = evidence.constraint ?? alias;
  return Boolean(validRange(constraint) && satisfies(target, constraint));
}
function rewriteJavascriptConstraint(
  declaration: ReferenceDeclaration,
  evidence: NativeReferenceEvidence,
  target: string,
): string | null {
  const spec = declaration.constraint;
  if (/^(?:file:|link:)/.test(spec) || /^workspace:(?:\*|\^|~)$/.test(spec)) {
    return spec;
  }
  const workspace = spec.startsWith("workspace:") ? "workspace:" : "";
  const raw = workspace ? spec.slice(workspace.length) : spec;
  if (workspace && /^(?:\.\.?\/|\/)/.test(raw)) {
    return spec;
  }
  if (acceptsJavascriptTarget(raw, evidence, target)) {
    return spec;
  }
  const simple = /^(\^|~)?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.exec(raw);
  return !declaration.peer && simple ? `${workspace}${simple[1] ?? ""}${target}` : null;
}
function rewrittenConstraint(
  declaration: ReferenceDeclaration,
  evidence: NativeReferenceEvidence,
  target: string,
  python: boolean,
): string {
  const rewritten = python
    ? rewritePythonConstraint(declaration.constraint, target)
    : rewriteJavascriptConstraint(declaration, evidence, target);
  if (rewritten !== null) {
    return rewritten;
  }
  throw new ReleaseError(
    "unsupported-local-constraint",
    `Local dependency ${declaration.name} has incompatible or unproven compatibility at ${declaration.field.join(".")}: ${declaration.constraint}`,
  );
}
function requiresEvidence(
  manifest: ReleaseManifest,
  declaration: ReferenceDeclaration,
  manifests: readonly ReleaseManifest[],
): boolean {
  if (/^(?:workspace:|file:|link:)/.test(declaration.constraint)) {
    return true;
  }
  if (manifest.project.ecosystem === "python") {
    const sources = releaseObject(releaseObject(releaseObject(manifest.data.tool).uv).sources);
    if (Object.keys(sources).some((name) => normalizePythonName(name) === declaration.name)) {
      return true;
    }
  }
  return Boolean(
    manifest.project.workspace &&
    manifests.some(
      (other) => other.project.workspace === manifest.project.workspace && other.project.name === declaration.name,
    ),
  );
}
function evidenceKey(from: string, name: string, field: string[]): string {
  return JSON.stringify([from, name, field]);
}
function indexEvidence(evidence: readonly NativeReferenceEvidence[]): Map<string, NativeReferenceEvidence[]> {
  const index = new Map<string, NativeReferenceEvidence[]>();
  for (const item of evidence) {
    const key = evidenceKey(item.from, item.name, item.field);
    const matches = index.get(key) ?? [];
    matches.push(item);
    index.set(key, matches);
  }
  return index;
}
function localMember(
  manifest: ReleaseManifest,
  declaration: ReferenceDeclaration,
  resolution: NativeReferenceEvidence,
  manifests: readonly ReleaseManifest[],
): ReleaseManifest {
  const member = manifests.find((candidate) => candidate.project.project_id === resolution.target_project_id);
  if (!member || member.participant.version === null || member.project.ecosystem !== manifest.project.ecosystem) {
    throw new ReleaseError(
      "ambiguous-local-reference",
      `Local target for ${declaration.name} is not a versioned release participant`,
    );
  }
  if (resolution.version !== undefined && resolution.version !== member.participant.version) {
    throw new ReleaseError(
      "stale-local-resolution",
      `Local resolution for ${declaration.name} does not match ${member.project.manifest}`,
    );
  }
  return member;
}
function planReference(
  manifest: ReleaseManifest,
  declaration: ReferenceDeclaration,
  matches: readonly NativeReferenceEvidence[],
  manifests: readonly ReleaseManifest[],
  target: string,
): ReferenceEdit[] {
  const resolution = matches[0];
  if (!resolution && !requiresEvidence(manifest, declaration, manifests)) {
    return [];
  }
  if (!resolution || matches.length !== 1 || resolution.source === "ambiguous") {
    throw new ReleaseError(
      "ambiguous-local-reference",
      `${manifest.project.manifest}: ownership of ${declaration.name} is not proven`,
    );
  }
  if (resolution.source === "external") {
    return [];
  }
  const member = localMember(manifest, declaration, resolution, manifests);
  const constraint = rewrittenConstraint(declaration, resolution, target, manifest.project.ecosystem === "python");
  return constraint === declaration.constraint
    ? []
    : [
        {
          manifest: manifest.project.manifest,
          field: declaration.field,
          before: declaration.value,
          after: `${declaration.prefix}${constraint}${declaration.suffix}`,
          target_project_id: member.project.project_id,
        },
      ];
}
export function planLocalReferences(
  manifests: readonly ReleaseManifest[],
  evidence: readonly NativeReferenceEvidence[],
  target: string,
): ReferenceEdit[] {
  const index = indexEvidence(evidence);
  return manifests.flatMap((manifest) =>
    referenceDeclarations(manifest).flatMap((declaration) =>
      planReference(
        manifest,
        declaration,
        index.get(evidenceKey(manifest.project.project_id, declaration.name, declaration.field)) ?? [],
        manifests,
        target,
      ),
    ),
  );
}
