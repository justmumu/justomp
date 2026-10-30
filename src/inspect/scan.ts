import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join, posix } from "node:path";
import { INSPECTION_DEFAULTS } from "../config/inspection/defaults";
import type { InspectionRules } from "../config/inspection/model";
import { assembleInspection } from "./assemble";
import { createMatcher, LOCK_MANAGERS, MANIFEST_NAMES } from "./exclusions";
import type {
  GoReplace,
  PackagingStructure,
  ParsedProject,
  WorkspaceDeclaration,
} from "./model";
import { readManifest } from "./readers/manifest";
export interface InspectOptions {
  root: string;
  rules?: InspectionRules;
  signal?: AbortSignal;
}
export async function inspectProject({
  root,
  rules = INSPECTION_DEFAULTS,
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
  assembleInspection({
    parsed,
    declarations,
    locks,
    report,
    matcher,
    workReplaces,
  });
  report.completedAt = new Date().toISOString();
  report.metrics.durationMs = performance.now() - started;
  signal?.throwIfAborted();
  return report;
}
