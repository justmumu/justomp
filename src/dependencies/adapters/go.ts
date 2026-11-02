import { readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseGo } from "../../inspect/readers/go";
import { readOptional } from "../executable";
import { object, readInventory } from "../inventory";
import {
  type Adapter,
  type AdapterContext,
  DependencyError,
  type DependencyRequest,
  type Inventory,
  type NativeStep,
  selectDependency,
} from "../model";
import { localSource } from "../paths";

function graphObjects(text: string): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const state = { start: -1, depth: 0, quoted: false, escaped: false };
  for (let i = 0; i < text.length; i++) {
    const complete = graphCharacter(state, text[i], i);
    if (complete !== undefined) {
      result.push(object(JSON.parse(text.slice(complete, i + 1))));
    }
  }
  if (state.depth !== 0 || state.quoted) {
    throw new DependencyError("invalid-output", "Incomplete Go module graph output");
  }
  return result;
}
function moduleName(name: string) {
  if (!name.includes("/") || ["go", "toolchain"].includes(name)) {
    throw new DependencyError(
      "unsupported-package",
      "Go dependencies use module paths; toolchain management is outside this tool",
    );
  }
}
function release(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}
export const goAdapter: Adapter = {
  groups: ["runtime"],
  async inventory(context, transitive) {
    const inventory = await readInventory(context.root, context.project);
    // No network or sum completion on a list operation; missing cache is reported.
    const result = await context.run({
      label: "read selected Go module graph",
      args: ["list", "-m", "-json", "-mod=readonly", "all"],
      env: { GOPROXY: "off", GOSUMDB: "off" },
    });
    if (result.exit_code !== 0 || result.truncated) {
      if (transitive) {
        inventory.complete = false;
        inventory.diagnostics.push({
          code: "resolution-unavailable",
          message: "The selected Go graph requires unavailable cache/checksum metadata; run dependency_sync explicitly",
        });
      }
      return inventory;
    }
    const graph = graphObjects(result.stdout);
    for (const item of graph) {
      recordModule(context, inventory, item, transitive);
    }
    return inventory;
  },
  async plan(context, request, inventory) {
    const steps: NativeStep[] = [];
    const members = context.structure.projects.filter(
      (p) => p.ecosystem === "go" && p.managerRoot === context.project.managerRoot,
    );
    const metadata = [
      ...members.flatMap((p) => [p.manifest, join(p.path, "go.sum")]),
      join(context.project.managerRoot, "go.work"),
      join(context.project.managerRoot, "go.work.sum"),
    ];
    if (
      request.operation === "add" &&
      request.packages.some((pkg) => pkg.source.kind === "registry" || pkg.source.kind === "git")
    ) {
      await validateRegistryAdds(context, request, members);
    }
    switch (request.operation) {
      case "sync":
        planSync(request, steps);
        break;
      case "remove":
        planRemove(request, inventory, steps);
        break;
      case "update":
        planUpdate(request, inventory, steps);
        break;
      case "add":
        await planAdd(context, request, inventory, steps);
        break;
    }
    return {
      steps,
      metadata,
      affectedProjects: members.map((p) => p.project_id),
    };
  },
  async verify(context: AdapterContext, request: Exclude<DependencyRequest, { operation: "list" }>, _before, after) {
    if (request.operation === "add") {
      // Native workspace precedence is not represented by go.mod alone. Query
      // only the requested modules, without fetching or completing checksums.
      const result = await context.run({
        label: "verify effective Go add sources",
        args: ["list", "-m", "-json", "-mod=readonly", ...request.packages.map((pkg) => pkg.name)],
        env: { GOPROXY: "off", GOSUMDB: "off" },
      });
      if (result.exit_code !== 0 || result.truncated) {
        throw new DependencyError(
          "postcondition-failed",
          "Go could not verify the effective sources of the added modules",
        );
      }
      const graph = graphObjects(result.stdout);
      for (const pkg of request.packages) {
        await verifyAddedSource(context, pkg, graph);
      }
      return;
    }
    if (request.operation !== "update") {
      return;
    }
    verifyUpdatedVersions(request, after);
  },
};

interface GraphState {
  start: number;
  depth: number;
  quoted: boolean;
  escaped: boolean;
}
function graphCharacter(state: GraphState, c: string | undefined, index: number): number | undefined {
  if (state.quoted) {
    quotedCharacter(state, c);
    return undefined;
  }
  if (c === '"') {
    state.quoted = true;
  } else if (c === "{") {
    if (state.depth++ === 0) {
      state.start = index;
    }
  } else if (c === "}" && --state.depth === 0) {
    const start = state.start;
    state.start = -1;
    return start;
  } else if (state.depth === 0 && c && !/\s/.test(c)) {
    throw new DependencyError("invalid-output", "Invalid Go module graph output");
  }
  return undefined;
}
function quotedCharacter(state: GraphState, c: string | undefined) {
  if (state.escaped) {
    state.escaped = false;
  } else if (c === "\\") {
    state.escaped = true;
  } else if (c === '"') {
    state.quoted = false;
  }
}

function recordModule(
  context: AdapterContext,
  inventory: Inventory,
  item: Record<string, unknown>,
  transitive: boolean,
) {
  if (typeof item.Path !== "string" || item.Main === true) {
    return;
  }
  if (item.Error) {
    inventory.complete = false;
    return;
  }
  const version = typeof item.Version === "string" ? item.Version : undefined;
  const declarations = inventory.dependencies.filter((d) => d.name === item.Path);
  if (!version) {
    return;
  }
  if (declarations.length) {
    for (const d of declarations) {
      d.resolutions = [{ version, evidence: "go list -m -mod=readonly" }];
    }
    return;
  }
  if (!transitive) {
    return;
  }
  inventory.dependencies.push({
    name: item.Path,
    group: { kind: "runtime" },
    source: { kind: object(item.Replace).Dir ? "path" : "registry" },
    declared_specifier: "",
    direct: false,
    evidence: {
      file: context.project.manifest,
      field: "selected-module-graph",
    },
    resolutions: [{ version, evidence: "go list -m -mod=readonly" }],
  });
}

async function validateRegistryAdds(
  context: AdapterContext,
  request: Extract<DependencyRequest, { operation: "add" }>,
  members: AdapterContext["structure"]["projects"],
) {
  // Replacements survive removal and may not have a require entry. Read
  // every active main module as well as the workspace's overriding rules.
  const work = await readOptional(join(context.owner, "go.work"));
  const documents = await Promise.all(
    (work ? members : [context.project]).map(async (member) =>
      parseGo(await readFile(join(context.root, member.manifest), "utf8"), "mod"),
    ),
  );
  if (work) {
    documents.push(parseGo(work, "work"));
  }
  for (const pkg of request.packages) {
    if (pkg.source.kind !== "registry" && pkg.source.kind !== "git") {
      continue;
    }
    // Even a version-specific replacement can become effective through
    // native minimum-version selection. Do not silently erase shared rules.
    if (documents.some((doc) => doc.module === pkg.name || doc.replaces.some((item) => item.name === pkg.name))) {
      throw new DependencyError(
        "unsupported-source-operation",
        `Go registry/revision add for ${pkg.name} may be overridden by an existing module replacement or workspace member; manage that override explicitly first`,
      );
    }
  }
}

function planSync(request: Extract<DependencyRequest, { operation: "sync" }>, steps: NativeStep[]) {
  steps.push({
    label: request.check ? "check selected Go module metadata" : "materialize selected Go modules",
    args: request.check ? ["mod", "tidy", "-diff"] : ["mod", "download"],
  });
}

function planRemove(
  request: Extract<DependencyRequest, { operation: "remove" }>,
  inventory: Inventory,
  steps: NativeStep[],
) {
  for (const pkg of request.packages) {
    moduleName(pkg.name);
    selectDependency(inventory, pkg.name, request.group);
    steps.push({
      label: `remove ${pkg.name}`,
      args: ["get", `${pkg.name}@none`],
    });
  }
}

function planUpdate(
  request: Extract<DependencyRequest, { operation: "update" }>,
  inventory: Inventory,
  steps: NativeStep[],
) {
  for (const pkg of request.packages) {
    moduleName(pkg.name);
    const dependency = selectDependency(inventory, pkg.name, pkg.group);
    if (dependency.source.kind !== "registry") {
      throw new DependencyError(
        "unsupported-source-operation",
        "Go local/replaced module declarations cannot be updated as registry releases",
      );
    }
    steps.push({
      label: `update ${pkg.name}`,
      args: [
        "get",
        `${pkg.name}@${pkg.version ? release(pkg.version) : request.mode === "latest" ? "latest" : "upgrade"}`,
      ],
    });
  }
}

async function planAdd(
  context: AdapterContext,
  request: Extract<DependencyRequest, { operation: "add" }>,
  inventory: Inventory,
  steps: NativeStep[],
) {
  for (const pkg of request.packages) {
    await planAddPackage(context, inventory, steps, pkg);
  }
}

async function planAddPackage(
  context: AdapterContext,
  inventory: Inventory,
  steps: NativeStep[],
  pkg: Extract<DependencyRequest, { operation: "add" }>["packages"][number],
) {
  moduleName(pkg.name);
  if (pkg.source.kind === "path" || pkg.source.kind === "workspace") {
    const path = await localSource(context, pkg.source);
    const target = parseGo(await readFile(join(path, "go.mod"), "utf8"), "mod");
    if (target.module !== pkg.name) {
      throw new DependencyError("source-name-mismatch", "Local Go module identity does not match the requested module");
    }
    const rel = relative(context.cwd, path).split("\\").join("/");
    const nativePath = rel.startsWith(".") ? rel : `./${rel}`;
    const major = /\/v([2-9]\d*)$/.exec(pkg.name)?.[1] ?? "0";
    const existing = inventory.dependencies.find((d) => d.name === pkg.name);
    const version = existing?.declared_specifier ?? `v${major}.0.0`;
    steps.push(
      {
        label: `replace ${pkg.name} locally`,
        args: ["mod", "edit", `-replace=${pkg.name}=${nativePath}`],
      },
      {
        label: `require ${pkg.name}`,
        args: ["get", `${pkg.name}@${version}`],
      },
    );
  } else {
    planRemoteAdd(steps, pkg);
  }
}

async function verifyAddedSource(
  context: AdapterContext,
  pkg: Extract<DependencyRequest, { operation: "add" }>["packages"][number],
  graph: Record<string, unknown>[],
) {
  const module = graph.find((item) => item.Path === pkg.name);
  let matches = !!module && !module.Error;
  if (pkg.source.kind === "path" || pkg.source.kind === "workspace") {
    const effective = module?.Replace ? object(module.Replace) : module;
    const directory = effective?.Dir;
    matches =
      matches &&
      typeof directory === "string" &&
      (await realpath(directory)) === (await realpath(await localSource(context, pkg.source)));
  } else {
    matches = matches && !module?.Replace && module?.Main !== true;
  }
  if (!matches) {
    throw new DependencyError(
      "postcondition-failed",
      `Go selected graph did not use the requested source for ${pkg.name}`,
    );
  }
}

function verifyUpdatedVersions(request: Extract<DependencyRequest, { operation: "update" }>, after: Inventory) {
  for (const pkg of request.packages) {
    if (pkg.version) {
      const declaration = selectDependency(after, pkg.name, pkg.group);
      const expected = release(pkg.version);
      if (!declaration.resolutions?.some((r) => r.version === expected)) {
        throw new DependencyError(
          "postcondition-failed",
          `Go selected graph did not resolve ${pkg.name} to the requested version`,
        );
      }
    }
  }
}

function planRemoteAdd(steps: NativeStep[], pkg: Extract<DependencyRequest, { operation: "add" }>["packages"][number]) {
  let query = pkg.version ? release(pkg.version) : "latest";
  if (pkg.source.kind === "git") {
    if (pkg.source.url !== pkg.name || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(pkg.source.ref)) {
      throw new DependencyError(
        "unsupported-source-operation",
        "Go Git sources require url equal to the Go module path and a native revision query; arbitrary repository URLs are not module identities",
      );
    }
    query = pkg.source.ref;
  }
  steps.push({
    label: `require ${pkg.name}`,
    args: ["get", `${pkg.name}@${query}`],
  });
}
