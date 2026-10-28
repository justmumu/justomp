import { posix } from "node:path";
import picomatch from "picomatch";
import { type InspectionMatcher, patternMayContain } from "./exclusions";
import type {
  Evidence,
  GoReplace,
  LocalDependency,
  PackagingStructure,
  ParsedProject,
  Workspace,
  WorkspaceDeclaration,
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
export function resolveRelationships(input: RelationshipInput): void {
  const { declarations, parsed, report, matcher, workReplaces } = input;
  const projects = parsed.map((p) => p.project);
  const diagnostics = report.diagnostics;
  const patterns = new Map<string, (value: string) => boolean>();
  const nativeMatch = (pattern: string, value: string, dot: boolean) => {
    const key = JSON.stringify([pattern, dot]);
    let matcher = patterns.get(key);
    if (!matcher) {
      matcher = picomatch(posix.normalize(pattern), { dot });
      patterns.set(key, matcher);
    }
    return matcher(value);
  };
  const workspaceField: Record<Workspace["kind"], string> = {
    uv: "tool.uv.workspace",
    pnpm: "packages",
    go: "use",
    npm: "workspaces",
    yarn: "workspaces",
    bun: "workspaces",
    unsupported: "workspaces",
  };
  const note = (
    code: string,
    path: string,
    message: string,
    evidence?: Evidence,
  ) =>
    diagnostics.push({
      code,
      path,
      message,
      ...(evidence ? { evidence } : {}),
    });
  for (const declaration of declarations) {
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
    report.workspaces.push(w);
    if (declaration.excludes.some((p) => /[?[\]{}()!\\]/.test(p))) {
      note(
        "unresolved-pattern",
        declaration.file,
        "Unsupported native workspace exclusion pattern",
      );
      w.status = "unresolved";
      continue;
    }
    const matches = (pattern: string, value: string) =>
      nativeMatch(
        pattern,
        value,
        declaration.kind === "uv" || declaration.kind === "go",
      );
    const ecosystem =
      declaration.kind === "uv"
        ? "python"
        : declaration.kind === "go"
          ? "go"
          : "javascript";
    if (declaration.kind !== "go") {
      const root = projects.find(
        (p) => p.path === declaration.path && p.ecosystem === ecosystem,
      );
      if (root) w.members.push(root.project_id);
    }
    for (const pattern of declaration.includes) {
      if (declaration.kind !== "go" && /[?[\]{}()!\\]/.test(pattern)) {
        note(
          "unresolved-pattern",
          declaration.file,
          `Unsupported native workspace pattern: ${pattern}`,
        );
        w.status = "unresolved";
        continue;
      }

      const joined = normalizeTarget(declaration.path, pattern);
      const ev = {
        file: declaration.file,
        field: w.evidence[0]?.field ?? "members",
        value: pattern,
      };
      if (posix.isAbsolute(pattern) || outside(joined)) {
        note(
          "external-member",
          declaration.file,
          `Workspace member ${pattern} is outside selected root`,
          ev,
        );
        w.status = "unresolved";
        continue;
      }
      if (
        !pattern.includes("*") &&
        (matcher.excludes(joined) || !matcher.mayTraverse(joined))
      ) {
        note(
          "excluded-member",
          declaration.file,
          `Workspace member ${pattern} is excluded by inspection rules`,
          ev,
        );
        w.status = "unresolved";
        continue;
      }
      let matched = false;
      for (const p of projects) {
        if (p.ecosystem !== ecosystem) continue;
        const rel = relative(declaration.path, p.path);
        if (declaration.kind !== "go" && outside(rel)) continue;
        const includes =
          declaration.kind === "go"
            ? posix.normalize(pattern) === rel
            : matches(pattern, rel);
        if (!includes || declaration.excludes.some((e) => matches(e, rel)))
          continue;
        w.members.push(p.project_id);
        matched = true;
      }
      for (const excluded of report.excluded) {
        const rel = relative(declaration.path, excluded.path);
        if (
          !outside(rel) &&
          patternMayContain(
            posix.normalize(pattern),
            rel,
            declaration.kind === "uv" || declaration.kind === "go",
          ) &&
          !declaration.excludes.some((e) => matches(e, rel))
        ) {
          note(
            "excluded-member",
            declaration.file,
            `Workspace member ${excluded.path} was not traversed (${excluded.reason})`,
            ev,
          );
          w.status = "unresolved";
          matched = true;
        }
      }
      if (!matched) {
        note(
          "unresolved-member",
          declaration.file,
          `No discovered ${ecosystem} project matches ${pattern}`,
          ev,
        );
        w.status = "unresolved";
      }
    }
    w.members = [...new Set(w.members)].sort();
  }
  for (const project of projects) {
    const nearest = report.workspaces
      .filter((w) => w.members.includes(project.project_id))
      .sort(
        (a, b) =>
          (b.path === "." ? 0 : b.path.length) -
          (a.path === "." ? 0 : a.path.length),
      )[0];
    if (nearest) {
      project.workspace = nearest.id;
      project.managerRoot = nearest.path;
    }
  }
  const identity = (ecosystem: string, name: string) =>
    ecosystem === "python" ? normalizePythonName(name) : name;
  const names = new Map<string, string[]>();
  for (const p of projects)
    if (p.name) {
      const key = `${p.ecosystem}:${identity(p.ecosystem, p.name)}`;
      const found = names.get(key) ?? [];
      found.push(p.project_id);
      names.set(key, found);
    }
  for (const [name, ids] of names)
    if (ids.length > 1)
      note(
        "duplicate-name",
        projects.find((p) => p.project_id === ids[0])?.manifest ?? ".",
        `${name} identifies multiple projects: ${ids.join(", ")}`,
      );
  const edge = (
    from: ParsedProject,
    target: string | undefined,
    name: string,
    kind: string,
    evidence: Evidence,
    workspace: boolean,
    base = from.project.path,
  ) => {
    const p = from.project;
    let candidates = projects.filter((c) => c.ecosystem === p.ecosystem);
    if (target !== undefined) {
      const resolved = normalizeTarget(base, target);
      if (posix.isAbsolute(target) || outside(resolved)) {
        note(
          "external-reference",
          p.manifest,
          `Local target ${target} is outside selected root`,
          evidence,
        );
        return;
      }
      if (matcher.excludes(resolved) || !matcher.mayTraverse(resolved)) {
        note(
          "excluded-target",
          p.manifest,
          `Local target ${target} is excluded`,
          evidence,
        );
        return;
      }
      candidates = candidates.filter((c) => c.path === resolved);
    } else if (workspace) {
      const nearest = report.workspaces.find((w) => w.id === p.workspace);
      if (!nearest || nearest.kind === "unsupported") {
        note(
          "unresolved",
          p.manifest,
          `No resolved workspace for ${name}`,
          evidence,
        );
        return;
      }
      candidates = candidates.filter(
        (c) =>
          nearest.members.includes(c.project_id) &&
          c.name &&
          identity(p.ecosystem, c.name) === identity(p.ecosystem, name),
      );
    } else return;
    if (candidates.length !== 1) {
      note(
        candidates.length ? "ambiguous-target" : "unresolved-target",
        p.manifest,
        `${name} resolves to ${candidates.length} discovered projects`,
        evidence,
      );
      return;
    }
    const to = candidates[0];
    if (to)
      report.localDependencies.push({
        from: p.project_id,
        to: to.project_id,
        kind,
        evidence,
      });
  };
  for (const item of parsed) {
    if (item.project.ecosystem === "python") {
      const workspace = report.workspaces
        .filter(
          (w) => w.kind === "uv" && w.members.includes(item.project.project_id),
        )
        .sort(
          (a, b) =>
            (b.path === "." ? 0 : b.path.length) -
            (a.path === "." ? 0 : a.path.length),
        )[0];
      const root = workspace
        ? declarations.find((d) => d.file === workspace.declaration)
        : undefined;
      for (const name of item.dependencyNames ?? []) {
        const local = Object.hasOwn(item.uvSources ?? {}, name);
        const source = local ? item.uvSources?.[name] : root?.uvSources?.[name];
        if (source)
          edge(
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
    for (const ref of item.references)
      edge(
        item,
        ref.target,
        ref.name,
        ref.kind,
        ref.evidence,
        ref.workspace ?? false,
      );
    if (item.project.ecosystem !== "go") continue;
    const workspace = report.workspaces
      .filter(
        (w) => w.kind === "go" && w.members.includes(item.project.project_id),
      )
      .sort(
        (a, b) =>
          (b.path === "." ? 0 : b.path.length) -
          (a.path === "." ? 0 : a.path.length),
      )[0];
    const overrides = workspace
      ? (workReplaces.get(workspace.declaration) ?? [])
      : [];
    for (const required of item.requires ?? []) {
      const applies = (r: GoReplace) =>
        r.name === required.name &&
        (!r.version || r.version === required.version);
      const fromWork = overrides.filter(applies);
      const local = (item.replaces ?? []).filter(applies);
      const replacements = fromWork.length ? fromWork : local;
      if (replacements.length > 1) {
        note(
          "ambiguous-target",
          item.project.manifest,
          `Multiple Go replacements apply to ${required.name}`,
        );
        continue;
      }
      const replacement = replacements[0];
      if (!replacement || replacement.targetVersion) continue;
      if (
        !replacement.target.startsWith(".") &&
        !posix.isAbsolute(replacement.target)
      ) {
        note(
          "unresolved",
          item.project.manifest,
          `Go replacement without version is not a local path: ${replacement.target}`,
        );
        continue;
      }
      const file =
        fromWork.length && workspace
          ? workspace.declaration
          : item.project.manifest;
      const base =
        fromWork.length && workspace ? workspace.path : item.project.path;
      edge(
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
  }
  report.localDependencies.sort((a, b) =>
    `${a.from}:${a.to}:${a.evidence.field}`.localeCompare(
      `${b.from}:${b.to}:${b.evidence.field}`,
    ),
  );
  const unique = new Map<string, LocalDependency>();
  for (const edge of report.localDependencies)
    unique.set(JSON.stringify(edge), edge);
  report.localDependencies = [...unique.values()];
  report.workspaces.sort((a, b) => a.id.localeCompare(b.id));
}
