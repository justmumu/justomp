import { posix } from "node:path";
import { INSPECTION_DEFAULTS } from "../../../src/config/inspection/defaults";
import type { InspectionRules } from "../../../src/config/inspection/model";
import { assembleInspection } from "../../../src/inspect/assemble";
import {
  createMatcher,
  LOCK_MANAGERS,
  MANIFEST_NAMES,
} from "../../../src/inspect/exclusions";
import type {
  GoReplace,
  PackagingStructure,
  ParsedProject,
  WorkspaceDeclaration,
} from "../../../src/inspect/model";
import { readManifest } from "../../../src/inspect/readers/manifest";

/** Supplied discovery evidence; no directories, watchers or native processes. */
export function inspectDocuments({
  root: files,
  rules = INSPECTION_DEFAULTS,
}: {
  root: Record<string, string>;
  rules?: InspectionRules;
}): PackagingStructure {
  const report: PackagingStructure = {
    schemaVersion: 2,
    scanId: "unit",
    root: "/repo",
    startedAt: "",
    completedAt: "",
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
      maxConcurrentIO: 0,
    },
  };
  const parsed: ParsedProject[] = [],
    declarations: WorkspaceDeclaration[] = [];
  const locks = new Map<string, { file: string; manager: string }[]>(),
    workReplaces = new Map<string, GoReplace[]>();
  const matcher = createMatcher(rules);
  for (const [path, text] of Object.entries(files)) {
    const pieces = path.split("/");
    const excluded = pieces
      .map((_, i) => pieces.slice(0, i + 1).join("/"))
      .find((p) => matcher.excludes(p));
    if (excluded) {
      if (!report.excluded.some((e) => e.path === excluded))
        report.excluded.push({ path: excluded, reason: "rule" });
      continue;
    }
    if (!matcher.includes(path)) continue;
    const name = posix.basename(path),
      directory = posix.dirname(path);
    const manager = LOCK_MANAGERS[name];
    if (manager)
      locks.set(directory, [
        ...(locks.get(directory) ?? []),
        { file: path, manager },
      ]);
    if (!MANIFEST_NAMES.has(name)) continue;
    const value = readManifest(path, text);
    report.diagnostics.push(...value.diagnostics);
    if (value.project) parsed.push(value.project);
    if (value.workspace) declarations.push(value.workspace);
    if (value.replaces) workReplaces.set(path, value.replaces);
  }
  assembleInspection({
    report,
    parsed,
    declarations,
    locks,
    workReplaces,
    matcher,
  });
  return report;
}
