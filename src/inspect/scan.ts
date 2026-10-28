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
    schemaVersion: 1,
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
  report.projects.sort((a, b) => a.id.localeCompare(b.id));
  report.excluded.sort((a, b) => a.path.localeCompare(b.path));
  const relationStart = performance.now();
  resolveRelationships({ parsed, declarations, report, matcher, workReplaces });
  report.metrics.relationshipMs = performance.now() - relationStart;
  for (const p of report.projects) {
    for (const w of report.workspaces) {
      if (w.kind !== "unsupported" && w.members.includes(p.id)) {
        p.managerCandidates.push(w.kind);
        p.evidence.push({
          file: w.declaration,
          field: "workspace-membership",
          value: w.id,
        });
      }
    }
    p.managerCandidates = [...new Set(p.managerCandidates)].sort();
    if (p.managerCandidates.length === 1) p.manager = p.managerCandidates[0];
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
