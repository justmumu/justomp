import { posix } from "node:path";
import picomatch from "picomatch";
import { type InspectionMatcher, patternMayContain } from "./exclusions";
import {
  type Evidence,
  type GoReplace,
  type LocalDependency,
  type PackagingStructure,
  type ParsedProject,
  type Project,
  type Workspace,
  type WorkspaceDeclaration,
} from "./model";
import { normalizePythonName } from "./readers/manifest";
export interface RelationshipInput {
  declarations: WorkspaceDeclaration[];
  parsed: ParsedProject[];
  report: PackagingStructure;
  matcher: InspectionMatcher;
  workReplaces: Map<string, GoReplace[]>;
}
function relative(base: string, path: string): string {
  return posix.relative(base, path) || ".";
}
function outside(path: string): boolean {
  return posix.isAbsolute(path) || path === ".." || path.startsWith("../");
}
function normalizeTarget(base: string, path: string): string {
  return posix.join(base, path);
}
const workspaceField: Record<Workspace["kind"], string> = {
  uv: "tool.uv.workspace",
  pnpm: "packages",
  go: "use",
  npm: "workspaces",
  yarn: "workspaces",
  bun: "workspaces",
  unsupported: "workspaces",
};
function identity(ecosystem: string, name: string): string {
  return ecosystem === "python" ? normalizePythonName(name) : name;
}
class RelationshipResolver {
  private readonly projects: Project[];
  private readonly patterns = new Map<string, (value: string) => boolean>();
  constructor(private readonly input: RelationshipInput) {
    this.projects = input.parsed.map((p) => p.project);
  }
  private nativeMatch(pattern: string, value: string, dot: boolean): boolean {
    const key = JSON.stringify([pattern, dot]);
    let matcher = this.patterns.get(key);
    if (!matcher) {
      matcher = picomatch(posix.normalize(pattern), { dot });
      this.patterns.set(key, matcher);
    }
    return matcher(value);
  }
  private note(code: string, path: string, message: string, evidence?: Evidence): void {
    this.input.report.diagnostics.push({
      code,
      path,
      message,
      ...(evidence ? { evidence } : {}),
    });
  }
  private workspace(declaration: WorkspaceDeclaration): void {
    const w: Workspace = {
      id: `${declaration.path}:${declaration.kind}`,
      kind: declaration.kind,
      path: declaration.path,
      declaration: declaration.file,
      members: [],
      evidence: [
        {
          file: declaration.file,
          field: workspaceField[declaration.kind],
        },
      ],
      status: declaration.unsupported ? "unresolved" : "resolved",
    };
    this.input.report.workspaces.push(w);
    if (declaration.excludes.some((p) => /[?[\]{}()!\\]/.test(p))) {
      this.note("unresolved-pattern", declaration.file, "Unsupported native workspace exclusion pattern");
      w.status = "unresolved";
      return;
    }
    const matches = (pattern: string, value: string) =>
      this.nativeMatch(pattern, value, declaration.kind === "uv" || declaration.kind === "go");
    const ecosystem = declaration.kind === "uv" ? "python" : declaration.kind === "go" ? "go" : "javascript";
    if (declaration.kind !== "go") {
      const root = this.projects.find((p) => p.path === declaration.path && p.ecosystem === ecosystem);
      if (root) {
        w.members.push(root.project_id);
      }
    }
    for (const pattern of declaration.includes) {
      this.resolvePattern(declaration, w, pattern, ecosystem, matches);
    }
    w.members = [...new Set(w.members)].sort();
  }
  private resolvePattern(
    declaration: WorkspaceDeclaration,
    w: Workspace,
    pattern: string,
    ecosystem: string,
    matches: (pattern: string, value: string) => boolean,
  ): void {
    if (declaration.kind !== "go" && /[?[\]{}()!\\]/.test(pattern)) {
      this.note("unresolved-pattern", declaration.file, `Unsupported native workspace pattern: ${pattern}`);
      w.status = "unresolved";
      return;
    }

    const joined = normalizeTarget(declaration.path, pattern);
    const ev = {
      file: declaration.file,
      field: w.evidence[0]?.field ?? "members",
      value: pattern,
    };
    if (posix.isAbsolute(pattern) || outside(joined)) {
      this.note("external-member", declaration.file, `Workspace member ${pattern} is outside selected root`, ev);
      w.status = "unresolved";
      return;
    }
    if (!pattern.includes("*") && (this.input.matcher.excludes(joined) || !this.input.matcher.mayTraverse(joined))) {
      this.note("excluded-member", declaration.file, `Workspace member ${pattern} is excluded by inspection rules`, ev);
      w.status = "unresolved";
      return;
    }
    const matched = this.matchPattern(declaration, w, pattern, ecosystem, matches, ev);
    if (!matched) {
      this.note("unresolved-member", declaration.file, `No discovered ${ecosystem} project matches ${pattern}`, ev);
      w.status = "unresolved";
    }
  }
  private matchPattern(
    declaration: WorkspaceDeclaration,
    w: Workspace,
    pattern: string,
    ecosystem: string,
    matches: (pattern: string, value: string) => boolean,
    ev: Evidence,
  ): boolean {
    let matched = false;
    for (const p of this.projects) {
      if (p.ecosystem !== ecosystem) {
        continue;
      }
      if (!matchesMember(declaration, p, pattern, matches)) {
        continue;
      }
      w.members.push(p.project_id);
      matched = true;
    }
    return this.matchExcluded(declaration, w, pattern, matches, ev) || matched;
  }
  private matchExcluded(
    declaration: WorkspaceDeclaration,
    w: Workspace,
    pattern: string,
    matches: (pattern: string, value: string) => boolean,
    ev: Evidence,
  ): boolean {
    let matched = false;
    for (const excluded of this.input.report.excluded) {
      const rel = relative(declaration.path, excluded.path);
      if (
        !outside(rel) &&
        patternMayContain(posix.normalize(pattern), rel, declaration.kind === "uv" || declaration.kind === "go") &&
        !declaration.excludes.some((e) => matches(e, rel))
      ) {
        this.note(
          "excluded-member",
          declaration.file,
          `Workspace member ${excluded.path} was not traversed (${excluded.reason})`,
          ev,
        );
        w.status = "unresolved";
        matched = true;
      }
    }
    return matched;
  }
  private assignWorkspaces(): void {
    for (const project of this.projects) {
      const nearest = this.input.report.workspaces
        .filter((w) => w.members.includes(project.project_id))
        .sort((a, b) => (b.path === "." ? 0 : b.path.length) - (a.path === "." ? 0 : a.path.length))[0];
      if (nearest) {
        project.workspace = nearest.id;
        project.managerRoot = nearest.path;
      }
    }
  }
  private duplicateNames(): void {
    const names = new Map<string, string[]>();
    for (const p of this.projects) {
      if (p.name) {
        const key = `${p.ecosystem}:${identity(p.ecosystem, p.name)}`;
        const found = names.get(key) ?? [];
        found.push(p.project_id);
        names.set(key, found);
      }
    }
    for (const [name, ids] of names) {
      if (ids.length > 1) {
        this.note(
          "duplicate-name",
          this.projects.find((p) => p.project_id === ids[0])?.manifest ?? ".",
          `${name} identifies multiple projects: ${ids.join(", ")}`,
        );
      }
    }
  }
  private pathCandidates(
    p: Project,
    target: string,
    evidence: Evidence,
    base: string,
    candidates: Project[],
  ): Project[] | undefined {
    const resolved = normalizeTarget(base, target);
    if (posix.isAbsolute(target) || outside(resolved)) {
      this.note("external-reference", p.manifest, `Local target ${target} is outside selected root`, evidence);
      return;
    }
    if (this.input.matcher.excludes(resolved) || !this.input.matcher.mayTraverse(resolved)) {
      this.note("excluded-target", p.manifest, `Local target ${target} is excluded`, evidence);
      return;
    }
    return candidates.filter((c) => c.path === resolved);
  }
  private edgeCandidates(
    p: Project,
    target: string | undefined,
    name: string,
    evidence: Evidence,
    workspace: boolean,
    base: string,
  ): Project[] | undefined {
    let candidates = this.projects.filter((c) => c.ecosystem === p.ecosystem);
    if (target !== undefined) {
      return this.pathCandidates(p, target, evidence, base, candidates);
    } else if (workspace) {
      const nearest = this.input.report.workspaces.find((w) => w.id === p.workspace);
      if (!nearest || nearest.kind === "unsupported") {
        this.note("unresolved", p.manifest, `No resolved workspace for ${name}`, evidence);
        return;
      }
      candidates = candidates.filter(
        (c) =>
          nearest.members.includes(c.project_id) &&
          c.name &&
          identity(p.ecosystem, c.name) === identity(p.ecosystem, name),
      );
    } else {
      return;
    }
    return candidates;
  }
  private edge(
    from: ParsedProject,
    target: string | undefined,
    name: string,
    kind: string,
    evidence: Evidence,
    workspace: boolean,
    base = from.project.path,
  ): void {
    const p = from.project;
    const candidates = this.edgeCandidates(p, target, name, evidence, workspace, base);
    if (!candidates) {
      return;
    }
    if (candidates.length !== 1) {
      this.note(
        candidates.length ? "ambiguous-target" : "unresolved-target",
        p.manifest,
        `${name} resolves to ${candidates.length} discovered projects`,
        evidence,
      );
      return;
    }
    const to = candidates[0];
    if (to) {
      this.input.report.localDependencies.push({
        from: p.project_id,
        to: to.project_id,
        kind,
        evidence,
      });
    }
  }
  private python(item: ParsedProject): void {
    const workspace = this.input.report.workspaces
      .filter((w) => w.kind === "uv" && w.members.includes(item.project.project_id))
      .sort((a, b) => (b.path === "." ? 0 : b.path.length) - (a.path === "." ? 0 : a.path.length))[0];
    const root = workspace ? this.input.declarations.find((d) => d.file === workspace.declaration) : undefined;
    for (const name of item.dependencyNames ?? []) {
      this.pythonSource(item, root, name);
    }
  }
  private pythonSource(item: ParsedProject, root: WorkspaceDeclaration | undefined, name: string): void {
    const local = Object.hasOwn(item.uvSources ?? {}, name);
    const source = local ? item.uvSources?.[name] : root?.uvSources?.[name];
    if (source) {
      this.edge(
        item,
        source.target,
        name,
        source.kind,
        source.evidence,
        source.workspace ?? false,
        local ? item.project.path : (root?.path ?? item.project.path),
      );
    }
  }
  private go(item: ParsedProject): void {
    if (item.project.ecosystem !== "go") {
      return;
    }
    const workspace = this.input.report.workspaces
      .filter((w) => w.kind === "go" && w.members.includes(item.project.project_id))
      .sort((a, b) => (b.path === "." ? 0 : b.path.length) - (a.path === "." ? 0 : a.path.length))[0];
    const overrides = workspace ? (this.input.workReplaces.get(workspace.declaration) ?? []) : [];
    for (const required of item.requires ?? []) {
      this.goReplacement(item, required, overrides, workspace);
    }
  }
  private goReplacement(
    item: ParsedProject,
    required: { name: string; version: string },
    overrides: GoReplace[],
    workspace: Workspace | undefined,
  ): void {
    const applies = (r: GoReplace) => r.name === required.name && (!r.version || r.version === required.version);
    const fromWork = overrides.filter(applies);
    const local = (item.replaces ?? []).filter(applies);
    const replacements = fromWork.length ? fromWork : local;
    if (replacements.length > 1) {
      this.note("ambiguous-target", item.project.manifest, `Multiple Go replacements apply to ${required.name}`);
      return;
    }
    const replacement = replacements[0];
    if (!replacement || replacement.targetVersion) {
      return;
    }
    if (!replacement.target.startsWith(".") && !posix.isAbsolute(replacement.target)) {
      this.note(
        "unresolved",
        item.project.manifest,
        `Go replacement without version is not a local path: ${replacement.target}`,
      );
      return;
    }
    const owner = fromWork.length ? workspace : undefined;
    const file = owner?.declaration ?? item.project.manifest;
    const base = owner?.path ?? item.project.path;
    this.edge(
      item,
      replacement.target,
      required.name,
      "go-replace",
      {
        file,
        field: "replace",
        value: `${required.name} => ${replacement.target}`,
      },
      false,
      base,
    );
  }
  private finish(): void {
    this.input.report.localDependencies.sort((a, b) =>
      `${a.from}:${a.to}:${a.evidence.field}`.localeCompare(`${b.from}:${b.to}:${b.evidence.field}`),
    );
    const unique = new Map<string, LocalDependency>();
    for (const edge of this.input.report.localDependencies) {
      unique.set(JSON.stringify(edge), edge);
    }
    this.input.report.localDependencies = [...unique.values()];
    this.input.report.workspaces.sort((a, b) => a.id.localeCompare(b.id));
  }
  resolve(): void {
    for (const declaration of this.input.declarations) {
      this.workspace(declaration);
    }
    this.assignWorkspaces();
    this.duplicateNames();
    for (const item of this.input.parsed) {
      if (item.project.ecosystem === "python") {
        this.python(item);
      }
      for (const ref of item.references) {
        this.edge(item, ref.target, ref.name, ref.kind, ref.evidence, ref.workspace ?? false);
      }
      this.go(item);
    }
    this.finish();
  }
}
export function resolveRelationships(input: RelationshipInput): void {
  new RelationshipResolver(input).resolve();
}

function matchesMember(
  declaration: WorkspaceDeclaration,
  p: Project,
  pattern: string,
  matches: (pattern: string, value: string) => boolean,
): boolean {
  const rel = relative(declaration.path, p.path);
  if (declaration.kind !== "go" && outside(rel)) {
    return false;
  }
  const includes = declaration.kind === "go" ? posix.normalize(pattern) === rel : matches(pattern, rel);
  if (!includes || declaration.excludes.some((e) => matches(e, rel))) {
    return false;
  }
  return true;
}
