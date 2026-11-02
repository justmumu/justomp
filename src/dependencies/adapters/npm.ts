import { readFile } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readOptional } from "../executable";
import { object, readInventory, sourceOf } from "../inventory";
import {
  type Adapter,
  type AdapterContext,
  type Dependency,
  DependencyError,
  type Inventory,
  type NativeStep,
  selectDependency,
} from "../model";
import {
  addResolution,
  declarationField,
  groupFlag,
  jsGroups,
  jsPlan,
  jsSource,
  rejectOtherGroups,
  unavailable,
  verifyJs,
} from "./js-common";

function scope(ctx: AdapterContext): string[] {
  return ctx.cwd === ctx.owner ? [] : ["--workspace", relative(ctx.owner, ctx.cwd)];
}
function step(ctx: AdapterContext, label: string, args: string[]): NativeStep {
  return { label, args: [...args, ...scope(ctx)], cwd: ctx.owner };
}
async function inventory(ctx: AdapterContext, transitive: boolean): Promise<Inventory> {
  const result = await readInventory(ctx.root, ctx.project);
  const shrinkwrap = await readOptional(join(ctx.owner, "npm-shrinkwrap.json"));
  const lockPath = shrinkwrap !== undefined ? "npm-shrinkwrap.json" : "package-lock.json";
  const text = shrinkwrap ?? (await readOptional(join(ctx.owner, lockPath)));
  if (!text) {
    return unavailable(result, transitive, "npm lock is missing; direct declarations remain available");
  }
  try {
    const lock = object(JSON.parse(text));
    if (lock.lockfileVersion !== 3 && lock.lockfileVersion !== 2) {
      throw new Error("Unsupported npm lock schema");
    }
    const packages = object(lock.packages),
      key = relative(ctx.owner, ctx.cwd).split("\\").join("/"),
      declaration = object(packages[key]);
    const manifest = object(JSON.parse(await readFile(join(ctx.cwd, "package.json"), "utf8")));
    for (const kind of jsGroups) {
      const field = declarationField({ kind });
      if (!isDeepStrictEqual(object(manifest[field]), object(declaration[field]))) {
        throw new Error("npm lock declarations are stale");
      }
    }
    const seen = new Set<string>();
    const resolveNode = (name: string, from: string): string | undefined => {
      let location = from;
      for (;;) {
        const candidate = posix.join(location, "node_modules", name);
        if (packages[candidate]) {
          return candidate;
        }
        if (!location) {
          break;
        }
        const parent = posix.dirname(location);
        location = parent === "." ? "" : parent;
      }
      return undefined;
    };
    const visit = (name: string, nodeKey: string, direct?: Dependency) => {
      let node = object(packages[nodeKey]);
      if (node.link === true && typeof node.resolved === "string") {
        nodeKey = node.resolved;
        node = object(packages[nodeKey]);
      }
      if (!Object.keys(node).length) {
        throw new Error(`Missing lock node for ${name}`);
      }
      const entry: Dependency = direct ?? {
        name,
        group: { kind: "runtime" },
        source: sourceOf(typeof node.resolved === "string" ? node.resolved : ""),
        declared_specifier: "",
        direct: false,
        evidence: {
          file: join(ctx.project.managerRoot, lockPath),
          field: `packages.${nodeKey}`,
        },
      };
      addResolution(entry, node.version, join(ctx.project.managerRoot, lockPath));
      if (seen.has(nodeKey)) {
        return;
      }
      seen.add(nodeKey);
      if (!direct && transitive) {
        result.dependencies.push(entry);
      }
      for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        for (const child of Object.keys(object(node[field]))) {
          const childKey = resolveNode(child, nodeKey);
          if (!childKey) {
            if (field === "dependencies") {
              throw new Error(`Missing lock resolution for ${child}`);
            }
            continue;
          }
          visit(child, childKey);
        }
      }
    };
    for (const dependency of [...result.dependencies]) {
      const node = resolveNode(dependency.name, key);
      if (!node) {
        throw new Error(`No locked resolution for ${dependency.name}`);
      }
      visit(dependency.name, node, dependency);
    }
    return result;
  } catch (error) {
    return unavailable(result, transitive, error instanceof Error ? error.message : "Invalid npm lock graph");
  }
}
export const npmAdapter: Adapter = {
  groups: jsGroups,
  inventory,
  verify: verifyJs,
  async plan(ctx, request, before) {
    const steps: NativeStep[] = [];
    if (request.operation === "sync") {
      if (
        !(await readOptional(join(ctx.owner, "package-lock.json"))) &&
        !(await readOptional(join(ctx.owner, "npm-shrinkwrap.json")))
      ) {
        throw new DependencyError("lock-required", "npm sync requires an existing lock");
      }
      steps.push({
        label: request.check ? "Check npm lock consistency" : "Install locked npm environment",
        args: request.check ? ["ci", "--dry-run", "--ignore-scripts", "--no-audit", "--no-fund"] : ["ci"],
        cwd: ctx.owner,
      });
    } else if (request.operation === "remove") {
      declarationField(request.group);
      for (const p of request.packages) {
        selectDependency(before, p.name, request.group);
      }
      steps.push(
        step(ctx, "Remove selected npm declarations", [
          "pkg",
          "delete",
          ...request.packages.map((p) => `${declarationField(request.group)}[${p.name}]`),
        ]),
      );
      steps.push(step(ctx, "Resolve and install npm environment", ["install"]));
    } else if (request.operation === "add") {
      for (const p of request.packages) {
        rejectOtherGroups(before, p.name, request.group);
        steps.push(
          step(ctx, `Add ${p.name}`, [
            "install",
            await jsSource(ctx, p.name, p.source, p.version),
            groupFlag(request.group),
          ]),
        );
      }
    } else {
      for (const p of request.packages) {
        const dependency = selectDependency(before, p.name, p.group);
        if (dependency.source.kind !== "registry") {
          if (
            p.version ||
            dependency.source.kind === "unknown" ||
            /#[a-f0-9]{40}$/i.test(dependency.declared_specifier)
          ) {
            throw new DependencyError(
              "unsupported-source-operation",
              "An exact registry version cannot replace a local/Git source; immutable selectors require explicit add",
            );
          }
          steps.push(step(ctx, `Refresh ${p.name} from its existing source`, ["update", p.name, "--save=false"]));
          continue;
        }
        if (p.version || request.mode === "latest") {
          rejectOtherGroups(before, p.name, dependency.group);
          steps.push(
            step(ctx, `Update ${p.name}`, [
              "install",
              `${p.name}@${p.version ?? "latest"}`,
              groupFlag(dependency.group),
              ...(p.version ? ["--save-exact"] : []),
            ]),
          );
        } else {
          steps.push(step(ctx, `Update ${p.name} within constraints`, ["update", p.name, "--save=false"]));
        }
      }
    }
    return jsPlan(ctx, "package-lock.json", steps);
  },
};
