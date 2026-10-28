import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join, posix } from "node:path";
import { DEFAULT_RULES } from "../config/defaults";
import { createMatcher, LOCK_MANAGERS, MANIFEST_NAMES } from "./exclusions";
import type {
  GoReplace,
  InspectionRules,
  PackagingStructure,
  ParsedProject,
  WorkspaceDeclaration,
} from "./model";
import { readManifest } from "./readers/manifest";
import { resolveRelationships } from "./relationships";
export interface InspectOptions {
  root: string;
  rules?: InspectionRules;
  signal?: AbortSignal;
}
export async function inspectProject({
  root,
  rules = DEFAULT_RULES,
  signal,
}: InspectOptions): Promise<PackagingStructure> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const canonical = await realpath(root);
  const matcher = createMatcher(rules);
  const report: PackagingStructure = {
    schemaVersion: 2,
    scanId: randomUUID(),
    startedAt,
    completedAt: startedAt,
    root: canonical,
    projects: [],
    workspaces: [],
    localDependencies: [],
    diagnostics: [],
    excluded: [],
    complete: true,
    metrics: {
      durationMs: 0,
      directoryEntries: 0,
      directories: 0,
      manifestReads: 0,
      manifestBytes: 0,
      parseMs: 0,
      relationshipMs: 0,
      maxConcurrentIO: 1,
    },
  };
  const parsed: ParsedProject[] = [];
  const declarations: WorkspaceDeclaration[] = [];
  const workReplaces = new Map<string, GoReplace[]>();
  const locks = new Map<string, { file: string; manager: string }[]>();
  const directories = ["."];
  while (directories.length) {
    signal?.throwIfAborted();
    const relative = directories.pop() as string;
    if (!matcher.mayTraverse(relative)) continue;
    const absolute = join(canonical, relative);
    try {
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        report.excluded.push({ path: relative, reason: "symlink" });
        continue;
      }
      if (!stats.isDirectory())
        throw new Error("Directory changed type during inspection");
      const directory = await opendir(absolute);
      report.metrics.directories++;
      for await (const entry of directory) {
        signal?.throwIfAborted();
        report.metrics.directoryEntries++;
        const path = posix.join(relative, entry.name);
        if (matcher.excludes(path)) {
          report.excluded.push({ path, reason: "rule" });
          continue;
        }
        if (entry.isSymbolicLink()) {
          report.excluded.push({ path, reason: "symlink" });
          continue;
        }
        if (entry.isDirectory()) {
          if (matcher.mayTraverse(path)) directories.push(path);
          else report.excluded.push({ path, reason: "outside-scope" });
          continue;
        }
        if (!matcher.includes(path)) continue;
        if (Object.hasOwn(LOCK_MANAGERS, entry.name)) {
          const found = locks.get(relative) ?? [];
          found.push({
            file: path,
            manager: LOCK_MANAGERS[entry.name] as string,
          });
          locks.set(relative, found);
        }
        if (!MANIFEST_NAMES.has(entry.name)) continue;
        if (!entry.isFile()) {
          report.complete = false;
          report.diagnostics.push({
            code: "invalid-manifest",
            path,
            message: "Manifest must be a regular file",
          });
          continue;
        }
        try {
          const file = await open(
            join(canonical, path),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          let source: string;
          try {
            const stats = await file.stat();
            if (!stats.isFile())
              throw new Error("Manifest changed type during inspection");
            source = await file.readFile({ encoding: "utf8", signal });
          } finally {
            await file.close();
          }
          report.metrics.manifestReads++;
          report.metrics.manifestBytes += Buffer.byteLength(source);
          const start = performance.now();
          try {
            const result = readManifest(path, source);
            report.diagnostics.push(...result.diagnostics);
            if (result.project) parsed.push(result.project);
            if (result.workspace) declarations.push(result.workspace);
            if (result.replaces) workReplaces.set(path, result.replaces);
          } finally {
            report.metrics.parseMs += performance.now() - start;
          }
        } catch (error) {
          signal?.throwIfAborted();
          report.complete = false;
          report.diagnostics.push({
            code: "invalid-manifest",
            path,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      report.complete = false;
      report.diagnostics.push({
        code: "unreadable-directory",
        path: relative,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
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
  report.completedAt = new Date().toISOString();
  report.metrics.durationMs = performance.now() - started;
  signal?.throwIfAborted();
  return report;
}
