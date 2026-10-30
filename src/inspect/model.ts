export type Ecosystem = "javascript" | "python" | "go";
export interface Evidence {
  file: string;
  field: string;
  value?: string;
}
export interface Diagnostic {
  code: string;
  path: string;
  message: string;
  evidence?: Evidence;
}
export interface Project {
  project_id: string;
  path: string;
  ecosystem: Ecosystem;
  manifest: string;
  name?: string;
  runtime?: Record<string, string>;
  manager?: string;
  managerVersion?: string;
  managerRoot: string;
  workspace?: string;
  managerCandidates: string[];
  frameworks: string[];
  status: "detected" | "ambiguous";
  evidence: Evidence[];
}
export interface Workspace {
  id: string;
  kind: "uv" | "pnpm" | "npm" | "yarn" | "bun" | "go" | "unsupported";
  path: string;
  declaration: string;
  members: string[];
  evidence: Evidence[];
  status: "resolved" | "unresolved";
}
export interface LocalDependency {
  from: string;
  to: string;
  kind: string;
  evidence: Evidence;
}
export interface Excluded {
  path: string;
  reason: "rule" | "symlink" | "outside-scope";
}
export interface PackagingStructure {
  schemaVersion: 2;
  scanId: string;
  startedAt: string;
  completedAt: string;
  root: string;
  projects: Project[];
  workspaces: Workspace[];
  localDependencies: LocalDependency[];
  diagnostics: Diagnostic[];
  excluded: Excluded[];
  complete: boolean;
  metrics: {
    durationMs: number;
    directoryEntries: number;
    directories: number;
    manifestReads: number;
    manifestBytes: number;
    parseMs: number;
    relationshipMs: number;
    maxConcurrentIO: number;
  };
}
export interface LocalReference {
  name: string;
  target?: string;
  workspace?: boolean;
  kind: string;
  evidence: Evidence;
}
export interface WorkspaceDeclaration {
  kind: Workspace["kind"];
  path: string;
  file: string;
  includes: string[];
  excludes: string[];
  unsupported?: boolean;
  managerVersion?: string;
  uvSources?: Record<string, LocalReference | null>;
}
export interface ParsedProject {
  project: Project;
  references: LocalReference[];
  requires?: { name: string; version: string }[];
  replaces?: GoReplace[];
  dependencyNames?: string[];
  uvSources?: Record<string, LocalReference | null>;
}
export interface GoReplace {
  name: string;
  version?: string;
  target: string;
  targetVersion?: string;
}
export interface ParsedManifest {
  project?: ParsedProject;
  workspace?: WorkspaceDeclaration;
  diagnostics: Diagnostic[];
  replaces?: GoReplace[];
}
