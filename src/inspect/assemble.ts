import { type Project, type Workspace, type WorkspaceDeclaration } from "./model";
import { type RelationshipInput, resolveRelationships } from "./relationships";

type AssemblyInput = RelationshipInput & { locks: Map<string, { file: string; manager: string }[]> };
type DirectEvidence = {
  candidates: string[];
  evidence: Project["evidence"];
  version: string | undefined;
  status: Project["status"];
};
function addLocks(p: Project, path: string, locks: AssemblyInput["locks"]): void {
  const managers = {
    javascript: ["npm", "pnpm", "yarn", "bun"],
    python: ["uv", "poetry", "pdm", "pipenv"],
    go: ["go"],
  };
  for (const lock of locks.get(path) ?? []) {
    if (managers[p.ecosystem].includes(lock.manager)) {
      p.managerCandidates.push(lock.manager);
      p.evidence.push({ file: lock.file, field: "presence", value: lock.manager });
    }
  }
}
function resolveDeclaration(declaration: WorkspaceDeclaration, input: AssemblyInput): boolean {
  if (declaration.kind !== "unsupported") {
    return true;
  }
  const owner = input.report.projects.find((p) => p.manifest === declaration.file);
  const managers = [...new Set(owner?.managerCandidates ?? [])];
  const manager = managers.length === 1 ? managers[0] : undefined;
  if (manager === "pnpm" && input.declarations.some((d) => d.path === declaration.path && d.kind === "pnpm")) {
    return false;
  }
  if (owner?.status !== "ambiguous" && (manager === "npm" || manager === "yarn" || manager === "bun")) {
    declaration.kind = manager;
    declaration.unsupported = false;
  } else {
    input.report.diagnostics.push({
      code: "unsupported-workspace",
      path: declaration.file,
      message: "package.json workspace manager is unknown or conflicting",
    });
  }
  return true;
}
function withoutVersion(p: Project): Project {
  const { managerVersion: _version, ...rest } = p;
  return rest;
}
function inheritEvidence(project: Project, inherited: DirectEvidence, input: AssemblyInput): Project {
  let p = project;
  p.managerCandidates.push(...inherited.candidates);
  p.evidence.push(
    ...inherited.evidence.filter(
      (e) => e.field === "packageManager" || e.field === "presence" || e.field === "tool.uv.required-version",
    ),
  );
  if (inherited.status === "ambiguous") {
    p.status = "ambiguous";
  }
  if (p.managerVersion && inherited.version && p.managerVersion !== inherited.version) {
    p.status = "ambiguous";
    input.report.diagnostics.push({
      code: "manager-version-conflict",
      path: p.manifest,
      message: `Conflicting package manager versions: ${p.managerVersion}, ${inherited.version}`,
    });
    p = withoutVersion(p);
  } else if (inherited.version) {
    p.managerVersion = inherited.version;
  }
  return p;
}
function virtualEvidence(p: Project, w: Workspace, declarations: WorkspaceDeclaration[], input: AssemblyInput): void {
  const version = declarations.find((d) => d.file === w.declaration)?.managerVersion;
  if (version) {
    p.evidence.push({ file: w.declaration, field: "tool.uv.required-version", value: version });
    p.managerVersion = version;
  }
  addLocks(p, w.path, input.locks);
}
function workspaceEvidence(
  project: Project,
  direct: Map<string, DirectEvidence>,
  declarations: WorkspaceDeclaration[],
  input: AssemblyInput,
): Project {
  let p = project;
  const w = input.report.workspaces.find((w) => w.id === p.workspace);
  if (!w) {
    return p;
  }
  if (w.kind !== "unsupported") {
    p.managerCandidates.push(w.kind);
  } else {
    p.status = "ambiguous";
  }
  p.evidence.push({ file: w.declaration, field: "workspace-membership", value: w.id });
  const owner = input.report.projects.find((owner) => owner.path === w.path && owner.ecosystem === p.ecosystem);
  const inherited = owner && direct.get(owner.project_id);
  const isOwner = owner === p;
  // uv reads configuration from the workspace root, ignoring member settings.
  if (w.kind === "uv" && !isOwner) {
    p = withoutVersion(p);
  }
  if (inherited && !isOwner) {
    p = inheritEvidence(p, inherited, input);
  }
  // Virtual workspace roots can own version and lock evidence without being projects.
  if (!owner) {
    virtualEvidence(p, w, declarations, input);
  }
  return p;
}
function selectManager(p: Project, input: AssemblyInput): void {
  p.managerCandidates = [...new Set(p.managerCandidates)].sort();
  if (p.managerCandidates.length === 1 && p.status !== "ambiguous") {
    p.manager = p.managerCandidates[0] as string;
  } else if (p.managerCandidates.length > 1) {
    p.status = "ambiguous";
    input.report.diagnostics.push({
      code: "manager-conflict",
      path: p.manifest,
      message: `Conflicting package managers: ${p.managerCandidates.join(", ")}`,
    });
  }
}
/** Resolve manager ownership and relationships from already-read discovery evidence. */
export function assembleInspection(input: AssemblyInput): void {
  const { parsed, report, matcher, workReplaces } = input;
  for (const { project: p } of parsed) {
    addLocks(p, p.path, input.locks);
    p.frameworks = [...new Set(p.frameworks)].sort();
    report.projects.push(p);
  }
  // Shared package.json syntax obtains its manager from metadata and lock evidence.
  const workspaceDeclarations = input.declarations.filter((declaration) => resolveDeclaration(declaration, input));
  report.projects.sort((a, b) => a.project_id.localeCompare(b.project_id));
  report.excluded.sort((a, b) => a.path.localeCompare(b.path));
  const relationStart = performance.now();
  resolveRelationships({ parsed, declarations: workspaceDeclarations, report, matcher, workReplaces });
  report.metrics.relationshipMs = performance.now() - relationStart;
  // Snapshot direct evidence before inheritance so iteration order cannot make
  // one workspace's metadata leak into a nested workspace.
  const direct = new Map(
    report.projects.map((p) => [
      p.project_id,
      {
        candidates: [...p.managerCandidates],
        evidence: [...p.evidence],
        version: p.managerVersion,
        status: p.status,
      },
    ]),
  );
  report.projects = report.projects.map((project) => {
    const p = workspaceEvidence(project, direct, workspaceDeclarations, input);
    selectManager(p, input);
    return p;
  });
  report.diagnostics.sort((a, b) =>
    `${a.path}:${a.code}:${a.message}`.localeCompare(`${b.path}:${b.code}:${b.message}`),
  );
}
