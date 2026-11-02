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
  type NativeStep,
  selectDependency,
} from "../model";
import { localSource } from "../paths";

function graphObjects(text: string): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  let start = -1,
    depth = 0,
    quoted = false,
    escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        quoted = false;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
    } else if (c === "{") {
      if (depth++ === 0) {
        start = i;
      }
    } else if (c === "}" && --depth === 0) {
      result.push(object(JSON.parse(text.slice(start, i + 1))));
      start = -1;
    } else if (depth === 0 && c && !/\s/.test(c)) {
      throw new DependencyError("invalid-output", "Invalid Go module graph output");
    }
  }
  if (depth !== 0 || quoted) {
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
      if (typeof item.Path !== "string" || item.Main === true) {
        continue;
      }
      if (item.Error) {
        inventory.complete = false;
        continue;
      }
      const version = typeof item.Version === "string" ? item.Version : undefined;
      const declarations = inventory.dependencies.filter((d) => d.name === item.Path);
      if (declarations.length) {
        for (const d of declarations) {
          if (version) {
            d.resolutions = [{ version, evidence: "go list -m -mod=readonly" }];
          }
        }
      } else if (transitive && version) {
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
    if (request.operation === "sync") {
      steps.push({
        label: request.check ? "check selected Go module metadata" : "materialize selected Go modules",
        args: request.check ? ["mod", "tidy", "-diff"] : ["mod", "download"],
      });
    } else if (request.operation === "remove") {
      for (const pkg of request.packages) {
        moduleName(pkg.name);
        selectDependency(inventory, pkg.name, request.group);
        steps.push({
          label: `remove ${pkg.name}`,
          args: ["get", `${pkg.name}@none`],
        });
      }
    } else if (request.operation === "update") {
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
    } else {
      for (const pkg of request.packages) {
        moduleName(pkg.name);
        if (pkg.source.kind === "path" || pkg.source.kind === "workspace") {
          const path = await localSource(context, pkg.source);
          const target = parseGo(await readFile(join(path, "go.mod"), "utf8"), "mod");
          if (target.module !== pkg.name) {
            throw new DependencyError(
              "source-name-mismatch",
              "Local Go module identity does not match the requested module",
            );
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
      }
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
      return;
    }
    if (request.operation !== "update") {
      return;
    }
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
  },
};
