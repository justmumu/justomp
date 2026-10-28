import type { Evidence, PackagingStructure, Project } from "../inspect/model";
import type { DependencyRequest, Group, Source } from "./schemas";

export type { DependencyRequest, Group, Source } from "./schemas";
export class DependencyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DependencyError";
  }
}
export interface Dependency {
  name: string;
  group: Group;
  source: { kind: Source["kind"] | "unknown"; specifier?: string };
  declared_specifier: string;
  direct: boolean;
  evidence: Evidence;
  extras?: string[];
  marker?: string;
  ambiguous?: boolean;
  resolutions?: { version: string; evidence?: string }[];
}
export interface Inventory {
  dependencies: Dependency[];
  complete: boolean;
  diagnostics: { code: string; message: string }[];
}
export interface NativeStep {
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  label: string;
}
export interface ProcessResult {
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  cancelled: boolean;
}
export interface AdapterContext {
  root: string;
  project: Project;
  structure: PackagingStructure;
  cwd: string;
  owner: string;
  manager: string;
  version: string;
  signal?: AbortSignal;
  run(step: NativeStep): Promise<ProcessResult>;
}
export interface NativePlan {
  steps: NativeStep[];
  metadata: string[];
  affectedProjects: string[];
}
export interface Adapter {
  groups: readonly Group["kind"][];
  plan(
    context: AdapterContext,
    request: Exclude<DependencyRequest, { operation: "list" }>,
    inventory: Inventory,
  ): Promise<NativePlan>;
  inventory(context: AdapterContext, transitive: boolean): Promise<Inventory>;
  verify?(
    context: AdapterContext,
    request: Exclude<DependencyRequest, { operation: "list" }>,
    before: Inventory,
    after: Inventory,
  ): Promise<void>;
}
export function sameGroup(a: Group, b: Group): boolean {
  return (
    a.kind === b.kind &&
    ("name" in a ? "name" in b && a.name === b.name : !("name" in b))
  );
}
export function selectDependency(
  inventory: Inventory,
  name: string,
  group?: Group,
): Dependency {
  const matches = inventory.dependencies.filter(
    (d) =>
      (d.direct || d.evidence.field === "require") &&
      d.name === name &&
      (!group || sameGroup(d.group, group)),
  );
  if (matches.length !== 1 || matches[0]?.ambiguous)
    throw new DependencyError(
      matches.length ? "ambiguous-dependency" : "dependency-not-found",
      `Select one declaration of ${name} using its group; conditional sources may require manual native management`,
    );
  return matches[0] as Dependency;
}
export function redact(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/g, "$1[redacted]@")
    .replace(
      /((?:token|password|_authToken|authorization)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    );
}
