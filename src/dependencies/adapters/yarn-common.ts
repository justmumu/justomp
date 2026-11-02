import { access, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { object, readInventory } from "../inventory";
import {
  type AdapterContext,
  type Dependency,
  DependencyError,
  type DependencyRequest,
  type Group,
  type Inventory,
  type NativePlan,
  type NativeStep,
  sameGroup,
  selectDependency,
} from "../model";
import { localSource, safePath } from "../paths";
import { declarationField, jsGroups as groups, normalizeJsVersion } from "./js-common";

export type Variant = "classic" | "modern" | "bun";
export { jsGroups as groups } from "./js-common";

function unsupported(message: string, code = "unsupported-group-operation"): never {
  throw new DependencyError(code, message);
}
export function groupFlags(group: Group): string[] {
  if (!groups.includes(group.kind as (typeof groups)[number])) {
    unsupported(`No native ${group.kind} group`, "unsupported-group");
  }
  return group.kind === "runtime" ? [] : [`--${group.kind}`];
}
function uniqueGroup(inventory: Inventory, name: string, group: Group) {
  if (inventory.dependencies.some((d) => d.direct && d.name === name && !sameGroup(d.group, group))) {
    unsupported(`Native operation cannot preserve the other declaration group of ${name}`);
  }
}
function step(context: AdapterContext, args: string[], label: string, cwd = context.cwd): NativeStep {
  return { args, cwd, label };
}
export function metadata(context: AdapterContext, variant: Variant): Pick<NativePlan, "metadata" | "affectedProjects"> {
  const projects = context.structure.projects.filter(
    (p) => p.ecosystem === "javascript" && p.managerRoot === context.project.managerRoot,
  );
  const owner = relative(context.root, context.owner);
  return {
    metadata: [
      ...projects.map((p) => p.manifest),
      ...(variant === "bun"
        ? ["bun.lock", "bun.lockb", "bunfig.toml", ".npmrc"]
        : ["yarn.lock", ".yarnrc", ".yarnrc.yml", ".pnp.cjs", ".pnp.loader.mjs"]
      ).map((name) => join(owner, name)),
    ],
    affectedProjects: projects.map((p) => p.project_id),
  };
}
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
export async function lockPath(context: AdapterContext, variant: Variant): Promise<string | undefined> {
  for (const name of variant === "bun" ? ["bun.lock", "bun.lockb"] : ["yarn.lock"]) {
    if (await exists(join(context.owner, name))) {
      return join(context.owner, name);
    }
  }
  return undefined;
}
async function sourceSpecifier(
  context: AdapterContext,
  item: Extract<DependencyRequest, { operation: "add" }>["packages"][number],
  variant: Variant,
): Promise<string> {
  if (item.source.kind === "registry") {
    return `${item.name}@${item.version ?? "latest"}`;
  }
  if (item.source.kind === "git") {
    return `${item.name}@${item.source.url}#${item.source.ref}`;
  }
  const path = await localSource(context, item.source);
  const sourceManifest = object(JSON.parse(await readFile(join(path, "package.json"), "utf8")));
  if (sourceManifest.name !== item.name) {
    unsupported(`Local source name does not match ${item.name}`, "source-name-mismatch");
  }
  if (item.source.kind === "workspace") {
    if (variant !== "classic") {
      return `${item.name}@workspace:*`;
    }
    // Classic lacks workspace:. A file reference cannot fall through to a registry
    // when a local workspace version fails to satisfy a registry range.
  }
  return `${item.name}@file:${variant === "classic" ? path : relative(context.cwd, path) || "."}`;
}
async function frozen(context: AdapterContext, variant: Variant, check = false): Promise<NativeStep[]> {
  const lock = await lockPath(context, variant);
  if (!lock) {
    unsupported("Sync requires an existing native lockfile", "lockfile-required");
  }
  if (variant === "classic") {
    await validateClassicLock(context, lock);
  }
  return [
    step(
      context,
      [
        "install",
        variant === "modern" ? "--immutable" : "--frozen-lockfile",
        ...(variant === "classic" ? ["--non-interactive"] : []),
        ...(variant === "bun" && check ? ["--dry-run"] : []),
      ],
      "Synchronize from existing lockfile",
      context.owner,
    ),
  ];
}
export async function plan(
  context: AdapterContext,
  request: Exclude<DependencyRequest, { operation: "list" }>,
  inventory: Inventory,
  variant: Variant,
): Promise<NativePlan> {
  const steps: NativeStep[] = [];
  const rootFlags =
    variant === "classic" && context.cwd === context.owner && context.project.workspace
      ? ["--ignore-workspace-root-check"]
      : [];
  switch (request.operation) {
    case "sync":
      await planSync(context, request, variant, steps);
      break;
    case "add":
      await planAdd(context, request, inventory, variant, steps, rootFlags);
      break;
    case "remove":
      planRemove(context, request, inventory, variant, steps, rootFlags);
      break;
    case "update":
      planUpdate(context, request, inventory, variant, steps, rootFlags);
      break;
  }
  if (variant === "classic" && request.operation === "update" && context.project.workspace) {
    // Classic upgrade updates the selected lock selector but may leave its workspace
    // using the previous hoisted package. Its integrity shortcut also skips a plain install.
    steps.push(
      step(
        context,
        ["install", "--frozen-lockfile", "--force", "--non-interactive"],
        "Materialize updated workspace resolutions",
        context.owner,
      ),
    );
  }
  return { steps, ...metadata(context, variant) };
}
export function verify(
  _context: AdapterContext,
  request: Exclude<DependencyRequest, { operation: "list" }>,
  before: Inventory,
  after: Inventory,
) {
  return new Promise<void>((resolve) => {
    verifyDeclarations(request, before, after);
    resolve();
  });
}

function unavailable(inventory: Inventory, message: string, transitive: boolean): Inventory {
  return {
    ...inventory,
    complete: !transitive,
    diagnostics: [...inventory.diagnostics, { code: "resolution-unavailable", message }],
  };
}
type GraphAdd = (name: string, version: string, direct?: boolean) => void;
function identity(value: string): [string, string] {
  const match = /^(@[^/]+\/[^@]+|[^@]+)@(.+)$/.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new Error("Invalid native graph identity");
  }
  return [match[1], match[2]];
}
function classicTree(text: string, context: AdapterContext, inventory: Inventory, add: GraphAdd, transitive: boolean) {
  const tree = text
    .trim()
    .split("\n")
    .map((line) => object(JSON.parse(line)))
    .find((row) => row.type === "tree");
  const roots = object(tree?.data).trees;
  if (!Array.isArray(roots)) {
    throw new Error("Missing native tree");
  }
  const index = (nodes: unknown[]): Map<string, Record<string, unknown>> =>
    new Map(
      nodes
        .map(object)
        .filter((node) => !node.shadow)
        .map((node) => {
          if (typeof node.name !== "string") {
            throw new Error("Invalid tree node");
          }
          return [identity(node.name)[0], node];
        }),
    );
  const rootIndex = index(roots);
  const seen = new Set<Record<string, unknown>>();
  const visitChildren = (children: Record<string, unknown>[], nested: Map<string, Record<string, unknown>>) => {
    for (const child of children) {
      const target = classicEdge(child, nested);
      visit(target, nested);
    }
  };
  const visit = (node: Record<string, unknown>, scope: Map<string, Record<string, unknown>>, direct = false) => {
    if (typeof node.name !== "string" || !Array.isArray(node.children)) {
      throw new Error("Invalid native tree");
    }
    add(...identity(node.name), direct);
    if (!transitive || seen.has(node)) {
      return;
    }
    seen.add(node);
    const children = node.children.map(object);
    const nested = new Map([...scope, ...index(children)]);
    visitChildren(children, nested);
  };
  const workspace = context.project.workspace && context.project.name ? rootIndex.get(context.project.name) : undefined;
  const workspaceChildren = workspace?.children;
  const selectedScope = Array.isArray(workspaceChildren)
    ? new Map([...rootIndex, ...index(workspaceChildren)])
    : rootIndex;
  for (const dependency of inventory.dependencies) {
    const target = selectedScope.get(dependency.name);
    if (target) {
      visit(target, selectedScope, true);
    } else if (dependency.group.kind !== "peer") {
      throw new Error("Missing direct resolution");
    }
  }
}
async function bunGraph(
  context: AdapterContext,
  lock: string,
  inventory: Inventory,
  add: GraphAdd,
  transitive: boolean,
) {
  if (lock.endsWith(".lockb")) {
    await bunBinaryGraph(context, lock, inventory, add, transitive);
    return;
  }
  const document = object(Bun.JSONC.parse(await readFile(lock, "utf8")));
  if (document.lockfileVersion !== 1 && document.lockfileVersion !== 2) {
    throw new Error("Unsupported Bun lock version");
  }
  const packages = object(document.packages),
    workspaces = object(document.workspaces);
  if (!document.packages || !document.workspaces) {
    throw new Error("Missing Bun graph tables");
  }
  const keys = Object.keys(packages);
  const locate = (name: string, parent: string) => {
    const ancestors = keys
      .filter((key) => parent === key || parent.startsWith(`${key}/`))
      .sort((a, b) => b.length - a.length);
    return [...ancestors.map((key) => `${key}/${name}`), name].find((key) => packages[key] !== undefined);
  };
  const seen = new Set<string>();
  const visitChildren = async (data: Record<string, unknown>, key: string, version: string) => {
    for (const field of [
      "dependencies",
      "optionalDependencies",
      ...(version.startsWith("workspace:") ? ["devDependencies"] : []),
    ]) {
      for (const child of Object.keys(object(data[field]))) {
        await visit(child, key);
      }
    }
  };
  const visit = async (name: string, parent: string, peer = false, direct = false): Promise<void> => {
    const key = locate(name, parent);
    if (!key) {
      if (peer) {
        return;
      }
      throw new Error("Missing Bun graph edge");
    }
    const { resolvedName, version, data } = bunRecord(packages[key], workspaces);
    const observedVersion = await bunFileVersion(context, version);
    add(resolvedName, typeof data.version === "string" ? data.version : observedVersion, direct);
    if (!transitive || seen.has(key)) {
      return;
    }
    seen.add(key);
    await visitChildren(data, key, version);
  };
  for (const dependency of inventory.dependencies) {
    await visit(dependency.name, context.project.name ?? "", dependency.group.kind === "peer", true);
  }
}

export async function nativeInventory(
  context: AdapterContext,
  transitive: boolean,
  variant: Variant,
): Promise<Inventory> {
  const inventory = await readInventory(context.root, context.project);
  const lock = await lockPath(context, variant);
  if (!lock) {
    return unavailable(inventory, "Native lockfile is missing", transitive);
  }
  const resolutions = new Map<string, Set<string>>();
  const directResolutions = new Map<string, Set<string>>();
  const add: GraphAdd = (name, version, direct = false) => {
    if (!name || !version) {
      throw new Error("Missing graph identity");
    }
    for (const map of direct ? [resolutions, directResolutions] : [resolutions]) {
      const versions = map.get(name) ?? new Set<string>();
      versions.add(version);
      map.set(name, versions);
    }
  };
  try {
    if (variant === "bun") {
      await bunGraph(context, lock, inventory, add, transitive);
    } else {
      await yarnGraph(context, variant, inventory, add, transitive);
    }
    applyResolutions(context, lock, inventory, resolutions, directResolutions, transitive);
    return inventory;
  } catch {
    return unavailable(inventory, "Native graph output is unavailable or has an unsupported format", transitive);
  }
}

async function validateClassicLock(context: AdapterContext, lock: string) {
  const text = await readFile(lock, "utf8");
  const selectors = classicSelectors(text);
  for (const project of context.structure.projects.filter(
    (p) => p.ecosystem === "javascript" && p.managerRoot === context.project.managerRoot,
  )) {
    for (const dependency of (await readInventory(context.root, project)).dependencies) {
      await validateClassicDeclaration(context, project, dependency, selectors);
    }
  }
}

function classicSelectors(text: string) {
  const selectors = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line || /^\s|^#/.test(line) || !line.endsWith(":")) {
      continue;
    }
    for (const selector of line.slice(0, -1).split(/,\s+(?=(?:"|@|[a-zA-Z]))/)) {
      selectors.add(selector.replace(/^"|"$/g, ""));
    }
  }
  return selectors;
}

async function validateClassicDeclaration(
  context: AdapterContext,
  project: AdapterContext["project"],
  dependency: Dependency,
  selectors: Set<string>,
) {
  if (dependency.group.kind === "peer") {
    return;
  }
  const local = context.structure.projects.find(
    (p) => p.workspace && p.workspace === project.workspace && p.name === dependency.name,
  );
  const localVersion = local
    ? object(JSON.parse(await readFile(join(context.root, local.manifest), "utf8"))).version
    : undefined;
  const linkedWorkspace =
    typeof localVersion === "string" &&
    dependency.source.kind === "registry" &&
    Bun.semver.satisfies(localVersion, dependency.declared_specifier);
  const normalized = dependency.declared_specifier.startsWith("file:")
    ? `file:${relative(context.owner, resolve(context.root, project.path, dependency.declared_specifier.slice(5)))}`
    : dependency.declared_specifier;
  if (
    !linkedWorkspace &&
    !selectors.has(`${dependency.name}@${dependency.declared_specifier}`) &&
    !selectors.has(`${dependency.name}@${normalized}`)
  ) {
    unsupported(`Lockfile has no resolution for ${dependency.name}@${dependency.declared_specifier}`, "stale-lockfile");
  }
}

async function planSync(
  context: AdapterContext,
  request: Extract<DependencyRequest, { operation: "sync" }>,
  variant: Variant,
  steps: NativeStep[],
) {
  steps.push(...(await frozen(context, variant, request.check)));
}

async function planAdd(
  context: AdapterContext,
  request: Extract<DependencyRequest, { operation: "add" }>,
  inventory: Inventory,
  variant: Variant,
  steps: NativeStep[],
  rootFlags: string[],
) {
  const flags = groupFlags(request.group);
  if (
    variant === "classic" &&
    request.group.kind !== "runtime" &&
    request.packages.some(
      (item) =>
        item.source.kind === "workspace" ||
        context.structure.projects.some(
          (project) =>
            project.workspace && project.workspace === context.project.workspace && project.name === item.name,
        ),
    )
  ) {
    unsupported(
      "Classic Yarn saves workspace additions in runtime dependencies; this source/group combination has no scoped native operation",
    );
  }
  for (const item of request.packages) {
    uniqueGroup(inventory, item.name, request.group);
  }
  const specs = await Promise.all(request.packages.map((item) => sourceSpecifier(context, item, variant)));
  if (variant === "bun" && request.packages.some((item) => item.source.kind === "git")) {
    planBunGitAdd(context, request, specs, flags, steps);
  } else {
    steps.push(step(context, ["add", ...specs, ...flags, ...rootFlags], "Add selected declarations"));
  }
}

function planRemove(
  context: AdapterContext,
  request: Extract<DependencyRequest, { operation: "remove" }>,
  inventory: Inventory,
  variant: Variant,
  steps: NativeStep[],
  rootFlags: string[],
) {
  groupFlags(request.group);
  for (const item of request.packages) {
    selectDependency(inventory, item.name, request.group);
    if (variant !== "bun") {
      uniqueGroup(inventory, item.name, request.group);
    }
  }
  if (variant === "bun" && request.packages.some((item) => item.name.includes("."))) {
    for (const item of request.packages) {
      uniqueGroup(inventory, item.name, request.group);
    }
    steps.push(
      step(context, ["remove", ...request.packages.map((item) => item.name)], "Remove unambiguous declarations"),
    );
  } else if (variant === "bun") {
    const field = declarationField(request.group);
    steps.push(
      step(
        context,
        ["pm", "pkg", "delete", ...request.packages.map((p) => `${field}.${p.name}`)],
        "Remove selected declaration group",
      ),
    );
    steps.push(step(context, ["install"], "Reconcile lockfile and environment", context.owner));
  } else {
    steps.push(
      step(context, ["remove", ...request.packages.map((p) => p.name), ...rootFlags], "Remove selected declarations"),
    );
  }
}

function planUpdate(
  context: AdapterContext,
  request: Extract<DependencyRequest, { operation: "update" }>,
  inventory: Inventory,
  variant: Variant,
  steps: NativeStep[],
  rootFlags: string[],
) {
  const selected = request.packages.map((item) => ({
    item,
    dependency: selectDependency(inventory, item.name, item.group),
  }));
  for (const target of selected) {
    validateUpdateTarget(context, request, inventory, variant, target);
  }
  const resolutionOnly =
    variant === "modern" && request.mode !== "latest" ? selected.filter(({ item }) => !item.version) : [];
  for (const { item, dependency } of selected.filter((target) => !resolutionOnly.includes(target))) {
    planUpdateTarget(context, request, variant, steps, rootFlags, { item, dependency });
  }
  if (resolutionOnly.length) {
    steps.push(
      step(
        context,
        ["up", "-R", ...resolutionOnly.map(({ item }) => item.name)],
        "Re-resolve selected names across the shared lockfile",
        context.owner,
      ),
    );
  }
}

function planBunGitAdd(
  context: AdapterContext,
  request: Extract<DependencyRequest, { operation: "add" }>,
  specs: string[],
  flags: string[],
  steps: NativeStep[],
) {
  for (const item of request.packages) {
    if (item.source.kind === "git" && item.name.includes(".")) {
      unsupported("Bun pkg cannot address dotted Git dependency names without changing another field");
    }
  }
  const regular = specs.filter((_spec, index) => request.packages[index]?.source.kind !== "git");
  if (regular.length) {
    steps.push(step(context, ["add", ...regular, ...flags], "Add selected declarations"));
  }
  const field = declarationField(request.group);
  steps.push(
    step(
      context,
      [
        "pm",
        "pkg",
        "set",
        ...request.packages
          .filter((item) => item.source.kind === "git")
          .map((item) => `${field}.${item.name}=${specs[request.packages.indexOf(item)]?.slice(item.name.length + 1)}`),
      ],
      "Set native Git source declarations",
    ),
  );
  steps.push(step(context, ["install"], "Reconcile Git sources, lockfile and environment", context.owner));
}

type UpdateTarget = {
  item: Extract<DependencyRequest, { operation: "update" }>["packages"][number];
  dependency: Dependency;
};
function validateUpdateTarget(
  context: AdapterContext,
  request: Extract<DependencyRequest, { operation: "update" }>,
  inventory: Inventory,
  variant: Variant,
  { item, dependency }: UpdateTarget,
) {
  if (
    variant === "classic" &&
    dependency.group.kind !== "runtime" &&
    context.structure.projects.some(
      (project) => project.workspace && project.workspace === context.project.workspace && project.name === item.name,
    )
  ) {
    unsupported("Classic Yarn cannot preserve the selected nonruntime workspace declaration group during update");
  }
  if (dependency.source.kind !== "registry" && (item.version || request.mode === "latest")) {
    unsupported(
      `Registry versions cannot replace the ${dependency.source.kind} source of ${item.name}`,
      "unsupported-source-operation",
    );
  }
  if (dependency.source.kind === "unknown") {
    unsupported(`Cannot safely update ${item.name}'s native source`, "unsupported-source-operation");
  }
  if (variant !== "modern" || item.version || request.mode === "latest") {
    uniqueGroup(inventory, item.name, dependency.group);
  }
}

function planUpdateTarget(
  context: AdapterContext,
  request: Extract<DependencyRequest, { operation: "update" }>,
  variant: Variant,
  steps: NativeStep[],
  rootFlags: string[],
  { item, dependency }: UpdateTarget,
) {
  const flags = groupFlags(dependency.group);
  if (item.version) {
    steps.push(
      step(
        context,
        ["add", `${item.name}@${normalizeJsVersion(item.version)}`, "--exact", ...flags, ...rootFlags],
        "Pin selected declaration to exact version",
      ),
    );
  } else if (variant === "modern" || (variant === "classic" && request.mode === "latest")) {
    steps.push(
      step(context, ["add", `${item.name}@latest`, ...flags, ...rootFlags], "Update selected workspace declaration"),
    );
  } else if (variant === "classic") {
    steps.push(
      step(
        context,
        ["upgrade", `${item.name}@${dependency.declared_specifier}`, ...flags, ...rootFlags],
        "Upgrade selected declaration",
      ),
    );
  } else {
    steps.push(
      step(
        context,
        [
          "update",
          item.name,
          ...(request.mode === "latest" ? ["--latest"] : []),
          ...(dependency.group.kind === "dev" ? ["--dev"] : []),
        ],
        "Update selected declaration",
      ),
    );
  }
}

function verifyDeclarations(
  request: Exclude<DependencyRequest, { operation: "list" }>,
  before: Inventory,
  after: Inventory,
) {
  for (const previous of before.dependencies.filter((d) => d.direct)) {
    const targeted = targetsDeclaration(request, previous);
    if (targeted) {
      continue;
    }
    const current = after.dependencies.find(
      (d) => d.direct && d.name === previous.name && sameGroup(d.group, previous.group),
    );
    if (!current || current.declared_specifier !== previous.declared_specifier) {
      throw new DependencyError("postcondition-failed", `Untargeted declaration ${previous.name} changed`);
    }
  }
  if (request.operation === "update") {
    for (const item of request.packages) {
      verifyExactVersion(item, before, after);
    }
  }
}

function targetsDeclaration(request: Exclude<DependencyRequest, { operation: "list" }>, previous: Dependency) {
  const targeted =
    request.operation === "sync"
      ? false
      : request.operation === "update"
        ? request.packages.some((p) => p.name === previous.name && (!p.group || sameGroup(p.group, previous.group)))
        : request.packages.some((p) => p.name === previous.name && sameGroup(request.group, previous.group));
  return targeted;
}

function verifyExactVersion(
  item: Extract<DependencyRequest, { operation: "update" }>["packages"][number],
  before: Inventory,
  after: Inventory,
) {
  if (!item.version) {
    return;
  }
  const expected = normalizeJsVersion(item.version);
  const previous = selectDependency(before, item.name, item.group);
  const current = selectDependency(after, item.name, previous.group);
  if (
    normalizeJsVersion(current.declared_specifier) !== expected ||
    !current.resolutions?.length ||
    !current.resolutions.every((resolution) => normalizeJsVersion(resolution.version) === expected)
  ) {
    throw new DependencyError(
      "postcondition-failed",
      `${item.name} was not saved and resolved as the requested exact version`,
    );
  }
}

async function bunBinaryGraph(
  context: AdapterContext,
  lock: string,
  inventory: Inventory,
  add: GraphAdd,
  transitive: boolean,
) {
  const result = await context.run(step(context, [lock], "Read native binary lock graph"));
  if (result.exit_code !== 0 || result.truncated || result.cancelled || !result.stdout.includes("# yarn lockfile v1")) {
    throw new Error("Invalid binary lock graph");
  }
  const records = binaryLockRecords(result.stdout);
  const seen = new Set<object>();
  const visit = (name: string, spec: string, peer = false, direct = false) => {
    const record = binaryRecord(context, records, name, spec);
    if (!record?.version) {
      if (peer) {
        return;
      }
      throw new Error("Missing binary lock edge");
    }
    add(name, record.version, direct);
    if (!transitive || seen.has(record)) {
      return;
    }
    seen.add(record);
    for (const [child, range] of Object.entries(record.dependencies)) {
      visit(child, range);
    }
  };
  for (const dependency of inventory.dependencies) {
    visit(dependency.name, dependency.declared_specifier, dependency.group.kind === "peer", true);
  }
}

function binaryLockRecords(text: string) {
  const records = new Map<string, { version?: string; dependencies: Record<string, string> }>();
  let current: { version?: string; dependencies: Record<string, string> } | undefined;
  let dependencies = false;

  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (!line.startsWith(" ") && line.endsWith(":")) {
      current = addBinaryRecord(records, line);
      dependencies = false;
    } else if (current) {
      dependencies = binaryLockProperties(current, line, dependencies);
    }
  }
  return records;
}

function binaryLockProperties(
  current: { version?: string; dependencies: Record<string, string> },
  line: string,
  dependencies: boolean,
): boolean {
  const version = /^ {2}version (.+)$/.exec(line);
  if (version?.[1]) {
    current.version = scalar(version[1]);
  }
  if (/^ {2}(?:optionalDependencies|dependencies):$/.test(line)) {
    dependencies = true;
  } else if (/^ {2}\S/.test(line)) {
    dependencies = false;
  }
  if (dependencies) {
    const edge = /^ {4}("(?:\\.|[^"\\])*"|\S+) (.+)$/.exec(line);
    if (edge?.[1] && edge[2]) {
      current.dependencies[scalar(edge[1])] = scalar(edge[2]);
    }
  }
  return dependencies;
}

function scalar(text: string): string {
  if (!text.startsWith('"')) {
    return text;
  }
  const value: unknown = JSON.parse(text);
  if (typeof value !== "string") {
    throw new Error("Invalid binary lock scalar");
  }
  return value;
}

function binaryRecord(
  context: AdapterContext,
  records: ReturnType<typeof binaryLockRecords>,
  name: string,
  spec: string,
) {
  const workspace = spec.startsWith("workspace:")
    ? context.structure.projects.find((p) => p.workspace === context.project.workspace && p.name === name)
    : undefined;
  const record = records.get(
    `${name}@${workspace ? relative(context.owner, join(context.root, workspace.path)) : spec}`,
  );
  return record;
}

async function bunFileVersion(context: AdapterContext, version: string): Promise<string> {
  let observedVersion = version;
  if (version.startsWith("file:")) {
    const directory = await safePath(context.root, join(context.owner, version.slice(5)));
    const manifest = object(JSON.parse(await readFile(join(directory, "package.json"), "utf8")));
    if (typeof manifest.version === "string") {
      observedVersion = manifest.version;
    }
  }
  return observedVersion;
}

async function yarnGraph(
  context: AdapterContext,
  variant: Exclude<Variant, "bun">,
  inventory: Inventory,
  add: GraphAdd,
  transitive: boolean,
) {
  // Modern info without -R reports only the active workspace's direct
  // resolutions. Keep these separate from same-named transitive versions.
  for (const recursive of variant === "modern" && transitive ? [false, true] : [false]) {
    const result = await context.run(step(context, yarnGraphArgs(variant, recursive), "Read native dependency graph"));
    if (result.exit_code !== 0 || result.truncated || result.cancelled) {
      throw new Error("Incomplete native graph");
    }
    if (variant === "classic") {
      classicTree(result.stdout, context, inventory, add, transitive);
    } else {
      modernGraphRecords(result.stdout, add, !recursive);
    }
  }
}

function modernGraphRecords(text: string, add: GraphAdd, direct: boolean) {
  for (const line of text.trim().split("\n").filter(Boolean)) {
    const row = object(JSON.parse(line)),
      children = object(row.children);
    if (typeof row.value !== "string" || typeof children.Version !== "string") {
      throw new Error("Invalid Yarn info record");
    }
    add(identity(row.value)[0], children.Version, direct);
  }
}

function applyResolutions(
  context: AdapterContext,
  lock: string,
  inventory: Inventory,
  resolutions: Map<string, Set<string>>,
  directResolutions: Map<string, Set<string>>,
  transitive: boolean,
) {
  for (const dependency of inventory.dependencies) {
    const versions = directResolutions.get(dependency.name);
    if (versions) {
      dependency.resolutions = [...versions].map((version) => ({
        version,
        evidence: relative(context.root, lock),
      }));
    } else if (dependency.group.kind !== "peer") {
      throw new Error(`Missing resolution for ${dependency.name}`);
    }
  }
  if (transitive) {
    addTransitiveResolutions(context, lock, inventory, resolutions, directResolutions);
  }
}

function classicEdge(child: Record<string, unknown>, nested: Map<string, Record<string, unknown>>) {
  if (typeof child.name !== "string") {
    throw new Error("Invalid native edge");
  }
  const target = child.shadow ? nested.get(identity(child.name)[0]) : child;
  if (!target) {
    throw new Error("Unresolved native edge");
  }
  return target;
}

function bunRecord(row: unknown, workspaces: Record<string, unknown>) {
  if (!Array.isArray(row) || typeof row[0] !== "string") {
    throw new Error("Invalid Bun package record");
  }
  const [resolvedName, version] = identity(row[0]);
  const data = version.startsWith("workspace:")
    ? object(workspaces[version.slice(10)])
    : object(typeof row[1] === "object" ? row[1] : row[2]);
  return { resolvedName, version, data };
}

function binarySelectors(line: string): string[] {
  return (line.slice(0, -1).match(/"(?:\\.|[^"\\])*"|[^,]+/g) ?? []).map((selector) => scalar(selector.trim()));
}

function yarnGraphArgs(variant: Exclude<Variant, "bun">, recursive: boolean): string[] {
  return variant === "modern"
    ? ["info", ...(recursive ? ["--recursive"] : []), "--json"]
    : ["list", "--json", "--depth=99999", "--non-interactive"];
}

function addTransitiveResolutions(
  context: AdapterContext,
  lock: string,
  inventory: Inventory,
  resolutions: Map<string, Set<string>>,
  directResolutions: Map<string, Set<string>>,
) {
  for (const [name, versions] of resolutions) {
    const indirectVersions = [...versions].filter((version) => !directResolutions.get(name)?.has(version));
    if (!indirectVersions.length) {
      continue;
    }
    inventory.dependencies.push({
      name,
      group: { kind: "runtime" },
      source: { kind: "unknown" },
      declared_specifier: "",
      direct: false,
      evidence: {
        file: relative(context.root, lock),
        field: "native graph",
      },
      resolutions: indirectVersions.map((version) => ({
        version,
        evidence: relative(context.root, lock),
      })),
    });
  }
}

function addBinaryRecord(
  records: Map<string, { version?: string; dependencies: Record<string, string> }>,
  line: string,
) {
  const record = { dependencies: {} };
  for (const selector of binarySelectors(line)) {
    records.set(selector, record);
  }
  return record;
}
