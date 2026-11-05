import { join, relative, resolve } from "node:path";
import { object } from "../../dependencies/inventory";
import { readProjectionFile } from "../../lint/files";
import { TypecheckError } from "../model";
import { type TypecheckTarget } from "../targets";
import { type JavascriptConfigNode } from "./config-graph";
import { inheritedBuild } from "./entrypoints";

interface Entry {
  path: string;
  node: JavascriptConfigNode;
  build?: string;
  types?: string;
}
function fail(path: string, reason: string): never {
  throw new TypecheckError("projection-conflict", `${path}: ${reason}`);
}
function relativeConfig(cwd: string, path: string): string {
  return relative(cwd, path).replaceAll("\\", "/");
}
function scriptConfig(cwd: string, path: string): string {
  const value = relativeConfig(cwd, path);
  if (!/^[A-Za-z0-9_./@+-]+$/.test(value) || value.startsWith("-")) {
    fail("package.json", `Build configuration path requires an explicit shell-safe script: ${value}`);
  }
  return value;
}
function rewritePath(path: string, cwd: string, entry: Entry): string {
  if (/['"]/.test(path)) {
    fail("package.json", `Build project cannot be resolved: ${path}`);
  }
  const selected = resolve(cwd, path);
  return entry.build && (selected === entry.path || resolve(selected, "tsconfig.json") === entry.path)
    ? scriptConfig(cwd, entry.build)
    : path;
}
function projectArgument(args: string[], cwd: string, entry: Entry): boolean {
  const index = args.findIndex((arg) => arg === "-p" || arg === "--project" || arg.startsWith("--project="));
  if (index < 0) {
    return false;
  }
  const flag = args[index] as string;
  if (flag.startsWith("--project=")) {
    args[index] = `--project=${rewritePath(flag.slice("--project=".length), cwd, entry)}`;
  } else {
    const path = args[index + 1];
    if (!path) {
      fail("package.json", "Build project argument is missing");
    }
    args[index + 1] = rewritePath(path, cwd, entry);
  }
  return true;
}
function buildArguments(args: string[], cwd: string, entry: Entry): boolean {
  const index = args.findIndex((arg) => arg === "-b" || arg === "--build");
  if (index < 0) {
    return false;
  }
  const paths = args
    .map((arg, offset) => ({ arg, offset }))
    .filter(({ arg, offset }) => offset > index && !arg.startsWith("-"));
  for (const { arg, offset } of paths) {
    args[offset] = rewritePath(arg, cwd, entry);
  }
  if (!paths.length && entry.build && entry.path === join(cwd, "tsconfig.json")) {
    args.splice(index + 1, 0, scriptConfig(cwd, entry.build));
  }
  return true;
}
function compilerWords(command: string): { prefix: string[]; args: string[] } {
  if (/[;&|`$<>\n]/.test(command)) {
    fail("package.json", `Build command cannot be safely rewired: ${command}`);
  }
  const words = command.trim().split(/\s+/),
    index = words.indexOf("tsc");
  if (
    index < 0 ||
    !["", "bunx", "npx", "pnpm exec", "yarn exec", "npm exec --"].includes(words.slice(0, index).join(" "))
  ) {
    fail("package.json", `Build command cannot be safely rewired: ${command}`);
  }
  return { prefix: words.slice(0, index + 1), args: words.slice(index + 1) };
}
function rewriteCommand(command: string, cwd: string, entry: Entry): string {
  if (!entry.build || !/(?:^|\s)tsc(?:\s|$)/.test(command)) {
    return command;
  }
  const { prefix, args } = compilerWords(command);
  if (args.includes("--noEmit") && args[args.indexOf("--noEmit") + 1] !== "false") {
    return command;
  }
  if (
    !projectArgument(args, cwd, entry) &&
    !buildArguments(args, cwd, entry) &&
    entry.path === join(cwd, "tsconfig.json")
  ) {
    if (args.some((arg) => !arg.startsWith("-"))) {
      fail("package.json", `Implicit build input cannot be resolved: ${command}`);
    }
    args.unshift("--project", scriptConfig(cwd, entry.build));
  }
  return [...prefix, ...args].join(" ");
}
function buildCommand(cwd: string, paths: string[]): string {
  return `tsc ${paths.length === 1 ? "--project" : "--build"} ${paths.map((path) => scriptConfig(cwd, path)).join(" ")}`;
}
/** Rewire real build consumers in the same preflight as their native graph. */
export async function planBuildConsumers(
  target: TypecheckTarget,
  entries: Entry[],
  signal: AbortSignal,
  nextConfig?: string,
  ownedScripts: readonly string[] = [],
) {
  signal.throwIfAborted();
  const path = resolve(target.root, target.project.manifest);
  const snapshot = await readProjectionFile(target.root, path);
  const manifest = snapshot.text ? object(JSON.parse(snapshot.text)) : {};
  const scripts = object(manifest.scripts);
  const changed = rewrittenScripts(scripts, entries, target.scope.cwd, ownedScripts);
  addBuildScripts(changed, scripts, entries, target.scope.cwd, path);
  const isNext =
    nextConfig !== undefined ||
    [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies].some(
      (group) => object(group).next !== undefined,
    );
  const framework = await nextConsumer(target, entries, nextConfig, isNext);
  return [
    ...(Object.keys(changed).length || ownedScripts.length ? [{ path, desired: { scripts: changed } }] : []),
    ...framework,
  ];
}
async function nextConsumer(
  target: TypecheckTarget,
  entries: Entry[],
  nextConfig: string | undefined,
  isNext: boolean,
) {
  const configured = nextConfig ? resolve(target.root, nextConfig) : join(target.scope.cwd, "tsconfig.json");
  const entry = entries.find((item) => item.build && item.path === configured && !inheritedBuild(item.node));
  if (!entry?.build) {
    return [];
  }
  const candidates = [];
  for (const name of ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"]) {
    const path = join(target.scope.cwd, name);
    if ((await readProjectionFile(target.root, path)).text !== null) {
      candidates.push(path);
    }
  }
  if (candidates.length > 1) {
    fail(candidates.join(", "), "Multiple framework configs cannot be safely migrated together");
  }
  const path = candidates[0] ?? (isNext ? join(target.scope.cwd, "next.config.mjs") : undefined);
  return path
    ? [{ path, desired: { typescript: { tsconfigPath: relativeConfig(target.scope.cwd, entry.build) } } }]
    : [];
}

function rewrittenScripts(
  scripts: Record<string, unknown>,
  entries: Entry[],
  cwd: string,
  ownedScripts: readonly string[],
): Record<string, string> {
  const changed: Record<string, string> = {};
  for (const [name, command] of Object.entries(scripts)) {
    if (
      name === "build:types" ||
      typeof command !== "string" ||
      /(?:^|:)typecheck(?:$|:)|(?:^|:)check(?:$|:)/.test(name)
    ) {
      continue;
    }
    let result = command;
    for (const entry of entries) {
      result = rewriteCommand(result, cwd, entry);
    }
    if (result !== command || ownedScripts.includes(name)) {
      changed[name] = result;
    }
  }
  return changed;
}
function addBuildScripts(
  changed: Record<string, string>,
  scripts: Record<string, unknown>,
  entries: Entry[],
  cwd: string,
  path: string,
): void {
  const production = entries.flatMap((entry) => (entry.build ? [entry.build] : []));
  if (production.length && scripts.build === undefined) {
    changed.build = buildCommand(cwd, production);
  }
  const typed = entries.flatMap((entry) => (entry.types ? [entry.types] : []));
  if (!typed.length) {
    return;
  }
  const desired = buildCommand(cwd, typed);
  const existing = scripts["build:types"];
  if (existing !== undefined && existing !== desired) {
    fail(path, "Existing build:types conflicts with the native declaration graph; reconcile the script explicitly");
  }
  changed["build:types"] = desired;
}
