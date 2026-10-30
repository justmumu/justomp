import { type RelationshipInput, resolveRelationships } from "./relationships";
/** Resolve manager ownership and relationships from already-read discovery evidence. */
export function assembleInspection(
  input: RelationshipInput & {
    locks: Map<string, { file: string; manager: string }[]>;
  },
): void {
  const { parsed, declarations, locks, report, matcher, workReplaces } = input;
  for (const item of parsed) {
    const p = item.project;
    for (const lock of locks.get(p.path) ?? []) {
      const matches =
        p.ecosystem === "javascript"
          ? ["npm", "pnpm", "yarn", "bun"].includes(lock.manager)
          : p.ecosystem === "python"
            ? ["uv", "poetry", "pdm", "pipenv"].includes(lock.manager)
            : lock.manager === "go";
      if (matches) {
        p.managerCandidates.push(lock.manager);
        p.evidence.push({
          file: lock.file,
          field: "presence",
          value: lock.manager,
        });
      }
    }
    p.frameworks = [...new Set(p.frameworks)].sort();
    report.projects.push(p);
  }
  // package.json workspaces are shared syntax; their manager comes from metadata
  // and lock evidence, never from the presence of that field alone.
  const workspaceDeclarations = declarations.filter((declaration) => {
    if (declaration.kind !== "unsupported") return true;
    const owner = report.projects.find((p) => p.manifest === declaration.file);
    const managers = [...new Set(owner?.managerCandidates ?? [])];
    const manager = managers.length === 1 ? managers[0] : undefined;
    if (
      manager === "pnpm" &&
      declarations.some((d) => d.path === declaration.path && d.kind === "pnpm")
    )
      return false;
    if (
      owner?.status !== "ambiguous" &&
      (manager === "npm" || manager === "yarn" || manager === "bun")
    ) {
      declaration.kind = manager;
      declaration.unsupported = false;
    } else {
      report.diagnostics.push({
        code: "unsupported-workspace",
        path: declaration.file,
        message: "package.json workspace manager is unknown or conflicting",
      });
    }
    return true;
  });
  report.projects.sort((a, b) => a.project_id.localeCompare(b.project_id));
  report.excluded.sort((a, b) => a.path.localeCompare(b.path));
  const relationStart = performance.now();
  resolveRelationships({
    parsed,
    declarations: workspaceDeclarations,
    report,
    matcher,
    workReplaces,
  });
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
  for (const p of report.projects) {
    const w = report.workspaces.find((w) => w.id === p.workspace);
    if (w) {
      if (w.kind !== "unsupported") p.managerCandidates.push(w.kind);
      else p.status = "ambiguous";
      p.evidence.push({
        file: w.declaration,
        field: "workspace-membership",
        value: w.id,
      });
      const owner = report.projects.find(
        (owner) => owner.path === w.path && owner.ecosystem === p.ecosystem,
      );
      const inherited = owner && direct.get(owner.project_id);
      // uv reads configuration from the workspace root, ignoring member settings.
      if (w.kind === "uv" && owner !== p) delete p.managerVersion;
      if (inherited && owner !== p) {
        p.managerCandidates.push(...inherited.candidates);
        p.evidence.push(
          ...inherited.evidence.filter(
            (e) =>
              e.field === "packageManager" ||
              e.field === "presence" ||
              e.field === "tool.uv.required-version",
          ),
        );
        if (inherited.status === "ambiguous") p.status = "ambiguous";
        if (
          p.managerVersion &&
          inherited.version &&
          p.managerVersion !== inherited.version
        ) {
          p.status = "ambiguous";
          report.diagnostics.push({
            code: "manager-version-conflict",
            path: p.manifest,
            message: `Conflicting package manager versions: ${p.managerVersion}, ${inherited.version}`,
          });
          delete p.managerVersion;
        } else if (inherited.version) p.managerVersion = inherited.version;
      }
      // Virtual workspace roots can own version and lock evidence without being projects.
      if (!owner) {
        const declaration = workspaceDeclarations.find(
          (d) => d.file === w.declaration,
        );
        const version = declaration?.managerVersion;
        if (version) {
          p.evidence.push({
            file: w.declaration,
            field: "tool.uv.required-version",
            value: version,
          });
          p.managerVersion = version;
        }
        for (const lock of locks.get(w.path) ?? []) {
          const matches =
            p.ecosystem === "python"
              ? ["uv", "poetry", "pdm", "pipenv"].includes(lock.manager)
              : p.ecosystem === "javascript"
                ? ["npm", "pnpm", "yarn", "bun"].includes(lock.manager)
                : lock.manager === "go";
          if (!matches) continue;
          p.managerCandidates.push(lock.manager);
          p.evidence.push({
            file: lock.file,
            field: "presence",
            value: lock.manager,
          });
        }
      }
    }
    p.managerCandidates = [...new Set(p.managerCandidates)].sort();
    if (p.managerCandidates.length === 1 && p.status !== "ambiguous")
      p.manager = p.managerCandidates[0];
    else if (p.managerCandidates.length > 1) {
      p.status = "ambiguous";
      report.diagnostics.push({
        code: "manager-conflict",
        path: p.manifest,
        message: `Conflicting package managers: ${p.managerCandidates.join(", ")}`,
      });
    }
  }

  report.diagnostics.sort((a, b) =>
    `${a.path}:${a.code}:${a.message}`.localeCompare(
      `${b.path}:${b.code}:${b.message}`,
    ),
  );
}
