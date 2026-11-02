import { randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join, posix } from "node:path";
import { INSPECTION_DEFAULTS } from "../config/inspection/defaults";
import { type InspectionRules } from "../config/inspection/model";
import { assembleInspection } from "./assemble";
import { createMatcher, type InspectionMatcher, LOCK_MANAGERS, MANIFEST_NAMES } from "./exclusions";
import { type GoReplace, type PackagingStructure, type ParsedProject, type WorkspaceDeclaration } from "./model";
import { readManifest } from "./readers/manifest";
export interface InspectOptions {
  root: string;
  rules?: InspectionRules;
  signal?: AbortSignal;
  excludedRoots?: readonly string[];
}
export async function inspectProject({
  root,
  rules = INSPECTION_DEFAULTS,
  signal,
  excludedRoots = [],
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
  const scan = new InspectionScan(canonical, matcher, report, signal, excludedRoots);
  await scan.scan();
  assembleInspection({
    parsed: scan.parsed,
    declarations: scan.declarations,
    locks: scan.locks,
    report,
    matcher,
    workReplaces: scan.workReplaces,
  });
  report.completedAt = new Date().toISOString();
  report.metrics.durationMs = performance.now() - started;
  signal?.throwIfAborted();
  return report;
}

class InspectionScan {
  readonly parsed: ParsedProject[] = [];
  readonly declarations: WorkspaceDeclaration[] = [];
  readonly workReplaces = new Map<string, GoReplace[]>();
  readonly locks = new Map<string, { file: string; manager: string }[]>();
  private readonly directories = ["."];
  constructor(
    private readonly canonical: string,
    private readonly matcher: InspectionMatcher,
    private readonly report: PackagingStructure,
    private readonly signal: AbortSignal | undefined,
    private readonly excludedRoots: readonly string[],
  ) {}
  private async readSource(path: string): Promise<string> {
    const file = await open(
      join(this.canonical, path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let source: string;
    try {
      const stats = await file.stat();
      if (!stats.isFile()) {
        throw new Error("Manifest changed type during inspection");
      }
      source = await file.readFile({ encoding: "utf8", signal: this.signal });
    } finally {
      await file.close();
    }
    return source;
  }
  private parseSource(path: string, source: string): void {
    this.report.metrics.manifestReads++;
    this.report.metrics.manifestBytes += Buffer.byteLength(source);
    const start = performance.now();
    try {
      const result = readManifest(path, source);
      this.report.diagnostics.push(...result.diagnostics);
      if (result.project) {
        this.parsed.push(result.project);
      }
      if (result.workspace) {
        this.declarations.push(result.workspace);
      }
      if (result.replaces) {
        this.workReplaces.set(path, result.replaces);
      }
    } finally {
      this.report.metrics.parseMs += performance.now() - start;
    }
  }
  private async manifest(path: string): Promise<void> {
    try {
      const source = await this.readSource(path);
      this.parseSource(path, source);
    } catch (error: unknown) {
      this.signal?.throwIfAborted();
      this.report.complete = false;
      this.report.diagnostics.push({
        code: "invalid-manifest",
        path,
        message: inspectionErrorMessage(error),
      });
    }
  }
  private async entry(relative: string, entry: Dirent): Promise<void> {
    this.signal?.throwIfAborted();
    this.report.metrics.directoryEntries++;
    const path = posix.join(relative, entry.name);
    if (this.matcher.excludes(path)) {
      this.report.excluded.push({ path, reason: "rule" });
      return;
    }
    if (entry.isSymbolicLink()) {
      this.report.excluded.push({ path, reason: "symlink" });
      return;
    }
    if (entry.isDirectory()) {
      this.enqueueDirectory(path);
      return;
    }
    if (!this.matcher.includes(path)) {
      return;
    }
    if (Object.hasOwn(LOCK_MANAGERS, entry.name)) {
      const found = this.locks.get(relative) ?? [];
      found.push({
        file: path,
        manager: LOCK_MANAGERS[entry.name] as string,
      });
      this.locks.set(relative, found);
    }
    if (!MANIFEST_NAMES.has(entry.name)) {
      return;
    }
    if (!entry.isFile()) {
      this.report.complete = false;
      this.report.diagnostics.push({
        code: "invalid-manifest",
        path,
        message: "Manifest must be a regular file",
      });
      return;
    }
    await this.manifest(path);
  }
  private enqueueDirectory(path: string): void {
    if (this.matcher.mayTraverse(path)) {
      this.directories.push(path);
    } else {
      this.report.excluded.push({ path, reason: "outside-scope" });
    }
  }
  private async directory(relative: string): Promise<void> {
    const absolute = join(this.canonical, relative);
    try {
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        this.report.excluded.push({ path: relative, reason: "symlink" });
        return;
      }
      if (!stats.isDirectory()) {
        throw new Error("Directory changed type during inspection");
      }
      const directory = await opendir(absolute);
      this.report.metrics.directories++;
      for await (const entry of directory) {
        await this.entry(relative, entry);
      }
    } catch (error: unknown) {
      this.signal?.throwIfAborted();
      this.report.complete = false;
      this.report.diagnostics.push({
        code: "unreadable-directory",
        path: relative,
        message: inspectionErrorMessage(error),
      });
    }
  }
  async scan(): Promise<void> {
    while (this.directories.length) {
      this.signal?.throwIfAborted();
      const relative = this.directories.pop() as string;
      if (this.excludedRoots.some((path) => path === relative || relative.startsWith(`${path}/`))) {
        continue;
      }
      if (!this.matcher.mayTraverse(relative)) {
        continue;
      }
      await this.directory(relative);
    }
  }
}

function inspectionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
