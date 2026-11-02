import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { object } from "../inventory";
import {
  type AdapterContext,
  type Dependency,
  DependencyError,
  type Group,
  type Inventory,
  type NativePlan,
  type NativeStep,
  type Source,
  sameGroup,
  selectDependency,
} from "../model";
import { localSource } from "../paths";
export const jsGroups = ["runtime", "dev", "optional", "peer"] as const;
export function declarationField(group: Group): string {
  const fields: Record<string, string> = {
    runtime: "dependencies",
    dev: "devDependencies",
    optional: "optionalDependencies",
    peer: "peerDependencies",
  };
  const field = fields[group.kind];
  if (!field) {
    throw new DependencyError("unsupported-group", `JavaScript has no ${group.kind} declaration group`);
  }
  return field;
}
export function groupFlag(group: Group): string {
  declarationField(group);
  return `--save-${group.kind === "runtime" ? "prod" : group.kind}`;
}
export function rejectOtherGroups(inventory: Inventory, name: string, group: Group) {
  if (inventory.dependencies.some((d) => d.direct && d.name === name && !sameGroup(d.group, group))) {
    throw new DependencyError(
      "unsupported-group-operation",
      `${name} is also declared in another group; native add/update would change that declaration`,
    );
  }
}
export function jsPlan(ctx: AdapterContext, lock: string, steps: NativeStep[]): NativePlan {
  const members = ctx.structure.projects.filter(
    (p) => p.ecosystem === "javascript" && p.managerRoot === ctx.project.managerRoot,
  );
  return {
    steps,
    metadata: [
      ...new Set([
        ...members.map((p) => p.manifest),
        join(ctx.project.managerRoot, lock),
        join(ctx.project.managerRoot, ".npmrc"),
        join(ctx.project.path, ".npmrc"),
        ...(ctx.manager === "pnpm"
          ? [join(ctx.project.managerRoot, "pnpm-workspace.yaml")]
          : [join(ctx.project.managerRoot, "npm-shrinkwrap.json")]),
      ]),
    ],
    affectedProjects: members.map((p) => p.project_id),
  };
}
export async function jsSource(ctx: AdapterContext, name: string, source: Source, version?: string): Promise<string> {
  if (source.kind === "registry") {
    return `${name}@${version ?? "latest"}`;
  }
  if (source.kind === "git") {
    return `${name}@${source.url}#${source.ref}`;
  }
  const absolute = await localSource(ctx, source);
  const manifest = object(JSON.parse(await readFile(join(absolute, "package.json"), "utf8")));
  if (manifest.name !== name) {
    throw new DependencyError("source-name-mismatch", `Local source does not declare ${name}`);
  }
  if (source.kind === "workspace" && ctx.manager === "pnpm") {
    return `${name}@workspace:*`;
  }
  return `${name}@file:${relative(ctx.cwd, absolute).split("\\").join("/") || "."}`;
}
export function unavailable(inventory: Inventory, transitive: boolean, message: string): Inventory {
  return {
    ...inventory,
    complete: !transitive,
    diagnostics: [...inventory.diagnostics, { code: "resolution-unavailable", message }],
  };
}
export function addResolution(dependency: Dependency, version: unknown, evidence: string) {
  if (typeof version !== "string" || !version) {
    return;
  }
  dependency.resolutions ??= [];
  if (!dependency.resolutions.some((r) => r.version === version)) {
    dependency.resolutions.push({ version, evidence });
  }
}
export function normalizeJsVersion(version: string): string {
  return version.replace(/^v/, "");
}
export const verifyJs: NonNullable<import("../model").Adapter["verify"]> = (_ctx, request, before, after) =>
  new Promise<void>((resolve) => {
    verifyDeclarations(request, before, after);
    resolve();
  });
function verifyDeclarations(
  request: Exclude<import("../model").DependencyRequest, { operation: "list" }>,
  before: Inventory,
  after: Inventory,
) {
  const targeted = (d: Dependency) => {
    if (request.operation === "sync") {
      return false;
    }
    if (request.operation === "update") {
      return request.packages.some(
        (p) => p.name === d.name && sameGroup(d.group, selectDependency(before, p.name, p.group).group),
      );
    }
    return request.packages.some((p) => p.name === d.name && sameGroup(d.group, request.group));
  };
  const remaining = (inventory: Inventory) =>
    inventory.dependencies
      .filter((d) => d.direct && !targeted(d))
      .map((d) => `${d.name}:${d.group.kind}:${d.declared_specifier}`)
      .sort();
  if (JSON.stringify(remaining(before)) !== JSON.stringify(remaining(after))) {
    throw new DependencyError("postcondition-failed", "Native command changed an unselected declaration");
  }
  if (request.operation === "update") {
    for (const p of request.packages) {
      verifyUpdatedDeclaration(p, before, after);
    }
  }
}

function verifyUpdatedDeclaration(
  p: Extract<import("../model").DependencyRequest, { operation: "update" }>["packages"][number],
  before: Inventory,
  after: Inventory,
) {
  const previous = selectDependency(before, p.name, p.group),
    current = selectDependency(after, p.name, previous.group);
  const expected = p.version ? normalizeJsVersion(p.version) : undefined;
  if (
    expected &&
    (normalizeJsVersion(current.declared_specifier) !== expected ||
      !current.resolutions?.length ||
      !current.resolutions.every((r) => normalizeJsVersion(r.version) === expected))
  ) {
    throw new DependencyError(
      "postcondition-failed",
      `${p.name} was not saved and resolved as the requested exact version`,
    );
  }
  if (previous.source.kind !== "registry" && current.declared_specifier !== previous.declared_specifier) {
    throw new DependencyError("postcondition-failed", `${p.name} changed its source selector`);
  }
}
