import { readFile, realpath } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { loadConfig } from "../../config/load";
import { type JavascriptTypecheckPolicy } from "../../config/typecheck/model";
import { object } from "../../dependencies/inventory";
import { safePath, within } from "../../dependencies/paths";
import { readProjectionFile } from "../../lint/files";
import { installedPackages, localTool, nodeRun, succeeded } from "../../lint/javascript/native";
import { lintManagerContext } from "../../lint/runtime";
import { LintStateStore } from "../../lint/state";
import { getPackagingStructure } from "../../packaging/get-structure";
import { excludeSourceFiles } from "../../packaging/source-exclusions";
import { javascriptAdapter, typescriptDiagnostics } from "../adapters/javascript";
import { type TypecheckAdapterRegistry, type TypecheckCheckContext } from "../adapters/types";
import { verifyReadyTypecheckContext, withReadyTypecheckTarget } from "../coordinator";
import {
  changedTypecheckFiles,
  contentHash,
  fingerprintTypecheckAnalysisSources,
  fingerprintTypecheckSources,
  snapshotTypecheckFiles,
} from "../freshness";
import { TypecheckError, type TypecheckPreparation } from "../model";
import { preparationFailure } from "../prepare";
import { applyProjection } from "../projection";
import { STRICT_OPTIONS } from "../projections/javascript";
import { collectTypecheckScope } from "../scope";
import { type GeneratedTypeReceipt, type NextTypeInputs, TypecheckStateStore } from "../state";
import { resolveTypecheckTarget, type TypecheckTarget } from "../targets";
import { type JavascriptConfigNode, readJavascriptConfigGraph } from "./config-graph";
import { assertTypecheckNative, typescriptRun } from "./native";
import { JavascriptConfigRead } from "./read-session";

interface DeclarationStep {
  target: TypecheckTarget;
  node: JavascriptConfigNode;
  outputs: string[];
  args: string[];
  projection: string;
}
export interface JavascriptTypePlan {
  target: TypecheckTarget;
  targets: TypecheckTarget[];
  project_ids: string[];
  declarations: DeclarationStep[];
  next_targets: TypecheckTarget[];
  next: Record<string, NextTypeInputs>;
  exclude: string[];
}
function unsupported(message: string): never {
  throw new TypecheckError("unsupported-generated-types", message);
}
async function manifest(target: TypecheckTarget) {
  return object(JSON.parse(await readFile(resolve(target.root, target.project.manifest), "utf8")));
}
function typePaths(value: unknown): string[] {
  const data = object(value);
  return Object.entries(data).flatMap(([key, value]) =>
    key === "types" && typeof value === "string" ? [value] : typeof value === "object" ? typePaths(value) : [],
  );
}
function packageOutputs(data: Record<string, unknown>): string[] {
  const explicit = [data.types, data.typings, ...typePaths(data.exports)].filter(
    (path): path is string => typeof path === "string",
  );
  if (explicit.length) {
    return [...new Set(explicit)];
  }
  return typeof data.main === "string" && /\.[cm]?js$/.test(data.main)
    ? [data.main.replace(/\.(c|m)?js$/, ".d.$1ts")]
    : [];
}
function commonDirectory(files: string[]): string {
  let root = dirname(files[0] ?? "");
  for (const file of files) {
    while (!within(root, file)) {
      root = dirname(root);
    }
  }
  return root;
}
function declarationArguments(
  node: JavascriptConfigNode,
  shared: JavascriptTypecheckPolicy["compilerOptions"],
): string[] {
  const args: string[] = [];
  const options = {
    ...Object.fromEntries(STRICT_OPTIONS.map((key) => [key, shared.strict])),
    ...shared,
  };
  for (const [name, value] of Object.entries(options)) {
    args.push(`--${name}`, String(value));
  }
  // Unknown preserved policy keys cannot disable checking or enable application emit.
  args.push(
    "--project",
    node.path,
    "--pretty",
    "false",
    "--declaration",
    "--emitDeclarationOnly",
    "--noEmit",
    "false",
    "--noCheck",
    "false",
    "--noEmitOnError",
    "true",
    "--listEmittedFiles",
    "--incremental",
    "false",
    "--composite",
    "false",
  );
  // Disabling the native incremental shortcut repairs removed declaration files.
  // Composite's implicit config-directory root must survive that invocation override.
  if (typeof node.compilerOptions.rootDir === "string") {
    args.push("--rootDir", resolve(dirname(node.path), node.compilerOptions.rootDir));
  } else if (node.compilerOptions.composite) {
    args.push("--rootDir", dirname(node.path));
  }
  return args;
}
async function effectiveDeclarationStep(
  target: TypecheckTarget,
  node: JavascriptConfigNode,
  shared: JavascriptTypecheckPolicy["compilerOptions"],
  read: JavascriptConfigRead,
  exclude: readonly string[],
): Promise<DeclarationStep> {
  const args = declarationArguments(node, shared);
  const result = await read.showConfig(target, args);
  let effective: Record<string, unknown>;
  if (succeeded(result)) {
    try {
      effective = object(JSON.parse(result.stdout));
    } catch {
      unsupported(`Invalid native declaration config metadata: ${node.path}`);
    }
  } else if (!result.cancelled && !result.truncated && !result.stderr.trim() && /error TS18003:/.test(result.stdout)) {
    effective = {
      compilerOptions: { ...node.compilerOptions, ...shared },
      files: [],
    };
  } else {
    assertTypecheckNative(result, `Resolve effective declaration inputs for ${node.path}`);
    effective = {};
  }
  const resolved = {
    ...node,
    compilerOptions: object(effective.compilerOptions),
    files: excludeSourceFiles(
      Array.isArray(effective.files)
        ? effective.files
            .filter((file): file is string => typeof file === "string")
            .map((file) => relative(target.scope.cwd, resolve(dirname(node.path), file)).replaceAll("\\", "/"))
        : [],
      exclude,
    ).map((file) => resolve(target.scope.cwd, file)),
  };
  return {
    target,
    node: resolved,
    args,
    outputs: await declarationOutputs(target, resolved),
    projection: join(dirname(node.path), `tsconfig.justomp.declarations.${contentHash(node.path).slice(0, 12)}.json`),
  };
}
async function declarationOutputs(target: TypecheckTarget, node: JavascriptConfigNode): Promise<string[]> {
  const options = node.compilerOptions;
  if (options.outFile) {
    unsupported(`Declaration bundles are not supported: ${node.path}`);
  }
  const inputs = node.files.filter((path) => !/\.d\.[cm]?ts$/.test(path) && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path));
  const root =
    typeof options.rootDir === "string"
      ? resolve(dirname(node.path), options.rootDir)
      : options.composite
        ? dirname(node.path)
        : commonDirectory(inputs);
  const output =
    typeof options.declarationDir === "string"
      ? resolve(dirname(node.path), options.declarationDir)
      : typeof options.outDir === "string"
        ? resolve(dirname(node.path), options.outDir)
        : undefined;
  const outputs: string[] = [];
  for (const input of inputs) {
    if (!within(root, input)) {
      unsupported(`Native rootDir does not contain declaration input: ${input}`);
    }
    const destination = output ? resolve(output, relative(root, input)) : input;
    const extension = extname(destination);
    const path =
      destination.slice(0, -extension.length) +
      (extension === ".mts" || extension === ".mjs"
        ? ".d.mts"
        : extension === ".cts" || extension === ".cjs"
          ? ".d.cts"
          : ".d.ts");
    await safePath(target.root, path);
    outputs.push(path);
    if (options.declarationMap) {
      outputs.push(`${path}.map`);
    }
  }
  return outputs;
}
/** Read-only closure: config references and inspected/native package edges, never folder-name guesses. */
export async function resolveJavascriptTypes(
  target: TypecheckTarget,
  signal: AbortSignal,
  next?: Record<string, NextTypeInputs>,
): Promise<JavascriptTypePlan> {
  const read = new JavascriptConfigRead(signal);
  const store = await TypecheckStateStore.load(target.root);
  const policy = (await loadConfig(target.root, { signal, flush: false })).typecheck.javascript;
  const shared = policy.compilerOptions;
  const useSavedNext = next === undefined;
  next ??= { ...store.state.generated?.[target.project.project_id]?.next };
  const targets = new Map<string, TypecheckTarget>([[target.project.project_id, target]]);
  const steps = new Map<string, DeclarationStep>();
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const nextTargets = new Map<string, TypecheckTarget>();
  const getTarget = async (id: string) => {
    let member = targets.get(id);
    if (!member) {
      member = await resolveTypecheckTarget(target.structure, id);
      targets.set(id, member);
    }
    return member;
  };
  const visitProject = async (member: TypecheckTarget, emit: boolean, entry?: string): Promise<void> => {
    if (emit && entry && steps.has(entry)) {
      return;
    }
    const key = `${member.project.project_id}:${entry ?? ""}:${emit}`;
    if (visiting.has(key)) {
      unsupported(`Cyclic local declaration dependencies: ${member.project.project_id}`);
    }
    if (visited.has(key)) {
      return;
    }
    visiting.add(key);
    const ownNext = store.state.generated?.[member.project.project_id]?.next[member.project.project_id];
    if (useSavedNext && ownNext) {
      next[member.project.project_id] = ownNext;
    }
    const data = await manifest(member);
    if (
      [data.dependencies, data.devDependencies, data.peerDependencies].some(
        (section) => object(section).next !== undefined,
      )
    ) {
      nextTargets.set(member.project.project_id, member);
    }
    const native = await read.native(member);
    const dependencies = {
      ...object(data.dependencies),
      ...object(data.devDependencies),
      ...object(data.optionalDependencies),
      ...object(data.peerDependencies),
    };
    const localIds = new Set(
      (member.structure.localDependencies ?? [])
        .filter((edge) => edge.from === member.project.project_id)
        .map((edge) => edge.to),
    );
    const candidates = member.structure.projects.filter(
      (project) => project.ecosystem === "javascript" && project.name && dependencies[project.name] !== undefined,
    );
    for (const name of new Set(candidates.map((project) => project.name as string))) {
      const matches = candidates.filter((project) => project.name === name);
      if (matches.length > 1) {
        unsupported(`Ambiguous local package '${name}'`);
      }
      const result = await nodeRun(
        member,
        native,
        [
          "-e",
          `const fs=require('node:fs'),path=require('node:path'),req=require('node:module').createRequire(path.join(process.cwd(),'package.json'));try {let file;try{file=req.resolve(process.argv[1]+'/package.json')}catch{let dir=path.dirname(req.resolve(process.argv[1]));while(!fs.existsSync(path.join(dir,'package.json'))){const parent=path.dirname(dir);if(parent===dir)throw Error();dir=parent}file=path.join(dir,'package.json')}console.log(fs.realpathSync(file))}catch{}`,
          name,
        ],
        signal,
      );
      assertTypecheckNative(result, `Resolve local dependency ${name}`);
      const found = result.stdout.trim();
      for (const candidate of matches) {
        if (found && found === (await realpath(resolve(target.root, candidate.manifest)))) {
          localIds.add(candidate.project_id);
        }
      }
    }
    for (const id of [...localIds].sort()) {
      const dependency = await getTarget(id);
      const expected = packageOutputs(await manifest(dependency));
      if (expected.some((path) => /\.d\.[cm]?ts$/.test(path))) {
        await visitProject(dependency, true);
      } else if (expected.some((path) => /\.[cm]?tsx?$/.test(path))) {
        await visitProject(dependency, false);
      } else if (!expected.length && (await collectTypecheckScope(dependency, policy.exclude)).empty)
      // JSON-only configuration packages are inputs, not declaration producers.
      {
        await visitProject(dependency, false);
      } else {
        unsupported(`Local package ${id} has no supported native declaration entry (types/exports/main)`);
      }
    }
    const nextInput = next?.[member.project.project_id];
    const graph = await readJavascriptConfigGraph(
      member,
      signal,
      entry ?? (nextInput ? resolve(target.root, nextInput.config) : undefined),
      read,
      policy.exclude,
    );
    const nodeMap = new Map(graph.nodes.map((node) => [node.path, node]));
    const visitedNodes = new Set<string>();
    const visitNode = async (node: JavascriptConfigNode, required: boolean): Promise<void> => {
      if (visitedNodes.has(node.path)) {
        return;
      }
      visitedNodes.add(node.path);
      for (const path of node.references) {
        const dependency = nodeMap.get(path);
        if (!dependency) {
          unsupported(`Missing reference metadata: ${path}`);
        }
        if (dependency.project_id === member.project.project_id) {
          // A solution's app/test references select check contexts; a source-bearing
          // consumer reference also needs the referenced config's native outputs.
          const needed = required || node.files.length > 0;
          if (needed && dependency.compilerOptions.composite !== true) {
            unsupported(`Referenced config must retain native composite:true: ${path}`);
          }
          await visitNode(dependency, needed);
        } else {
          const origin = await getTarget(dependency.project_id);
          if (dependency.compilerOptions.composite !== true) {
            unsupported(`Referenced project must retain native composite:true: ${path}`);
          }
          await visitProject(origin, true, path);
        }
      }
      if (required && node.project_id === member.project.project_id) {
        const step = await effectiveDeclarationStep(member, node, shared, read, policy.exclude);
        if (step.outputs.length) {
          steps.set(node.path, step);
        }
      }
    };
    for (const root of graph.roots) {
      const node = nodeMap.get(root);
      if (node) {
        await visitNode(node, emit);
      }
    }
    if (emit) {
      const expected = packageOutputs(data).filter((path) => /\.d\.[cm]?ts$/.test(path));
      const outputs = [...steps.values()]
        .filter((step) => step.target.project.project_id === member.project.project_id)
        .flatMap((step) => step.outputs);
      for (const path of expected) {
        const absolute = await safePath(target.root, resolve(member.scope.cwd, path));
        // A source declaration package need not carry a native tsconfig.
        const sourceDeclarations = (
          graph.nodes.length
            ? graph.nodes.flatMap((node) => node.files)
            : graph.scope.files.map((file) => resolve(member.scope.cwd, file))
        ).filter((file) => /\.d\.[cm]?ts$/.test(file));
        const matches = (candidate: string) =>
          path.includes("*")
            ? new Bun.Glob(path.replace(/^\.\//, "")).match(relative(member.scope.cwd, candidate))
            : candidate === absolute;
        if (![...outputs, ...sourceDeclarations].some(matches)) {
          unsupported(`Native declaration output does not match package types/exports: ${absolute}`);
        }
      }
      if (!outputs.length && expected.some((path) => !/\.d\.[cm]?ts$/.test(path))) {
        unsupported(`No declaration config for ${member.project.project_id}`);
      }
    }
    visiting.delete(key);
    visited.add(key);
  };
  await visitProject(target, false);
  const destinations = new Map<string, string>();
  for (const step of steps.values()) {
    for (const output of step.outputs) {
      const previous = destinations.get(output);
      if (previous && previous !== step.node.path) {
        unsupported(`Conflicting declaration output: ${output}`);
      }
      destinations.set(output, step.node.path);
    }
  }
  return {
    target,
    exclude: policy.exclude,
    targets: [...targets.values()],
    project_ids: [...targets.keys()].sort(),
    declarations: [...steps.values()],
    next_targets: [...nextTargets.values()],
    next: Object.fromEntries(Object.entries(next).filter(([id]) => nextTargets.has(id))),
  };
}
function preparation(context: TypecheckCheckContext): TypecheckPreparation {
  return {
    status: "ready",
    action: "prepared",
    tools: context.versions,
    affected_projects: [],
    changes: [],
    diagnostics: [],
    complete: true,
    cancelled: false,
    errors: [],
  };
}
function generatedPaths(plan: JavascriptTypePlan): string[] {
  return [
    ...plan.declarations.flatMap((step) =>
      [...step.outputs, step.projection].map((path) => relative(plan.target.root, path)),
    ),
    ...Object.values(plan.next).map((input) => join(input.dist, "types")),
    ...plan.next_targets.map((target) => relative(target.root, join(target.scope.cwd, "next-env.d.ts"))),
  ];
}
function snapshotOutputs(plan: JavascriptTypePlan): string[] {
  return [
    ...generatedPaths(plan),
    ...plan.declarations.flatMap((step) => {
      const options = step.node.compilerOptions;
      const directory =
        typeof options.declarationDir === "string"
          ? options.declarationDir
          : typeof options.outDir === "string"
            ? options.outDir
            : undefined;
      return directory ? [resolve(dirname(step.node.path), directory)] : [];
    }),
  ];
}
async function projectDeclarations(plan: JavascriptTypePlan): Promise<Record<string, string>> {
  const mappings = Object.fromEntries(plan.declarations.map((step) => [step.node.path, step.projection]));
  const marker = "// Generated by justomp; managed typecheck declarations v1.\n";
  for (const step of plan.declarations) {
    const before = await readProjectionFile(plan.target.root, step.projection);
    if (before.text !== null && !before.text.startsWith(marker)) {
      throw new TypecheckError(
        "projection-conflict",
        `Declaration config filename is not owned by justomp: ${step.projection}`,
      );
    }
    const options = step.node.compilerOptions;
    const rootDir =
      typeof options.rootDir === "string"
        ? resolve(dirname(step.node.path), options.rootDir)
        : commonDirectory(step.node.files.filter((file) => !/\.d\.[cm]?ts$/.test(file)));
    const content =
      marker +
      JSON.stringify(
        {
          extends: step.node.path,
          compilerOptions: {
            ...options,
            rootDir,
            composite: true,
            incremental: true,
            noEmit: false,
            noCheck: false,
            declaration: true,
            emitDeclarationOnly: true,
          },
          files: step.node.files,
          include: [],
          exclude: [],
          references: step.node.references.map((path) => ({
            path: mappings[path] ?? path,
          })),
        },
        null,
        2,
      ) +
      "\n";
    await applyProjection({
      target: step.target,
      files: [
        {
          path: step.projection,
          before,
          content,
          changed: before.text !== content,
        },
      ],
      configs: { check: [] },
      current: before.text === content,
    });
  }
  return Object.fromEntries(
    Object.entries(mappings).map(([source, destination]) => [
      relative(plan.target.root, source),
      relative(plan.target.root, destination),
    ]),
  );
}
async function inputHash(plan: JavascriptTypePlan): Promise<string> {
  return contentHash(
    JSON.stringify([
      plan.project_ids,
      plan.exclude,
      plan.declarations.map((step) => ({
        path: step.node.path,
        files: step.node.files,
        references: step.node.references,
        options: step.node.compilerOptions,
        inherited: step.node.inherited,
      })),
      plan.next,
      await fingerprintTypecheckSources(plan.targets, [
        ...generatedPaths(plan),
        ...Object.values(plan.next).map((input) => input.dist),
      ]),
      plan.next_targets.length
        ? contentHash(JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b))))
        : "",
    ]),
  );
}
export async function verifyJavascriptTypes(plan: JavascriptTypePlan): Promise<boolean> {
  if (!plan.declarations.length && !plan.next_targets.length) {
    return true;
  }
  const store = await TypecheckStateStore.load(plan.target.root);
  const receipt = store.state.generated?.[plan.target.project.project_id];
  if (
    !receipt?.ready ||
    JSON.stringify(receipt.project_ids) !== JSON.stringify(plan.project_ids) ||
    receipt.input_hash !== (await inputHash(plan))
  ) {
    return false;
  }
  for (const [path, hash] of Object.entries(receipt.outputs)) {
    try {
      if (contentHash(await readFile(await safePath(plan.target.root, path))) !== hash) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return Object.keys(receipt.outputs).length > 0;
}
async function loadNextInputs(target: TypecheckTarget, signal: AbortSignal): Promise<NextTypeInputs> {
  const native = await lintManagerContext(target, signal);
  const installed = await installedPackages(target, native, ["next"], signal);
  if (!installed.next) {
    unsupported(`Next is declared but not installed for ${target.project.project_id}`);
  }
  const result = await nodeRun(
    target,
    native,
    [
      "-e",
      `const req=require('node:module').createRequire(require('node:path').join(process.cwd(),'package.json'));const load=req('next/dist/server/config').default;load(req('next/constants').PHASE_PRODUCTION_BUILD,process.cwd()).then(c=>console.log('JUSTOMP_NEXT_INPUTS='+JSON.stringify({config:c.typescript.tsconfigPath||'tsconfig.json',dist:c.distDir}))).catch(e=>{console.error(e);process.exitCode=1});`,
    ],
    signal,
  );
  assertTypecheckNative(result, "Load native Next production configuration");
  const line = result.stdout.split("\n").find((line) => line.startsWith("JUSTOMP_NEXT_INPUTS="));
  if (!line) {
    unsupported("Next did not expose its native config paths");
  }
  const input = JSON.parse(line.slice("JUSTOMP_NEXT_INPUTS=".length)) as NextTypeInputs;
  const config = await safePath(target.root, resolve(target.scope.cwd, input.config));
  const dist = await safePath(target.root, resolve(target.scope.cwd, input.dist));
  if (!within(target.scope.cwd, dist) || dist === target.scope.cwd) {
    unsupported("Next distDir must remain within its project");
  }
  return {
    config: relative(target.root, config),
    dist: relative(target.root, dist),
  };
}
class ChangedClosure extends Error {
  constructor(
    readonly ids: string[],
    readonly preparation?: TypecheckPreparation,
  ) {
    super("Required local declaration closure changed");
  }
}
async function invalidateTools(context: TypecheckCheckContext, plan: JavascriptTypePlan): Promise<void> {
  const store = await TypecheckStateStore.load(context.target.root);
  const lint = await LintStateStore.load(context.target.root);
  for (const target of plan.targets) {
    const receipt = store.state.projects[target.project.project_id];
    if (
      receipt &&
      !(await javascriptAdapter.verifyTools({
        ...context,
        target,
        versions: receipt.tools,
      }))
    ) {
      receipt.ready = false;
      if (store.state.waves.javascript) {
        store.state.waves.javascript.complete = false;
      }
      const lintReceipt = lint.state.projects[target.project.project_id];
      if (lintReceipt) {
        lintReceipt.ready = false;
      }
    }
  }
  await store.save();
  await lint.save();
}
/** Caller owns every plan project/domain lease. Native config loading occurs only here. */
export async function prepareJavascriptTypes(
  context: TypecheckCheckContext,
  plan: JavascriptTypePlan,
  leasedProjectIds: readonly string[],
): Promise<TypecheckPreparation> {
  const report = preparation(context);
  const effectTargets = [...plan.targets];
  const observedOutputs = new Set<string>();
  const before = await snapshotTypecheckFiles(
    plan.targets,
    snapshotOutputs(plan),
    Object.values(plan.next).map((input) => input.dist),
  );
  const initialSourceBefore = await fingerprintTypecheckAnalysisSources(
    plan.targets,
    generatedPaths(plan),
    plan.exclude,
  );
  let store = await TypecheckStateStore.load(context.target.root);
  const next = { ...plan.next };
  store.state.generated ??= {};
  const previous = store.state.generated[context.target.project.project_id];
  if (previous) {
    previous.ready = false;
    await store.save();
  }
  try {
    for (const target of plan.next_targets) {
      report.affected_projects.push(target.project.project_id);
      next[target.project.project_id] = await loadNextInputs(target, context.signal);
    }
    plan = await resolveJavascriptTypes(context.target, context.signal, next);
    if (plan.project_ids.some((id) => !leasedProjectIds.includes(id))) {
      throw new ChangedClosure(plan.project_ids, report);
    }
    if (
      initialSourceBefore !==
      (await fingerprintTypecheckAnalysisSources(effectTargets, generatedPaths(plan), plan.exclude))
    ) {
      throw new TypecheckError(
        "source-changed",
        "Source or route inputs changed during native config loading; prepare again",
      );
    }
    const discoveredTargets = plan.targets.filter(
      (target) => !effectTargets.some((existing) => existing.project.project_id === target.project.project_id),
    );
    if (discoveredTargets.length) {
      const discoveredBefore = await snapshotTypecheckFiles(
        discoveredTargets,
        snapshotOutputs(plan),
        Object.values(plan.next).map((input) => input.dist),
      );
      for (const [path, hash] of Object.entries(discoveredBefore)) {
        if (!(path in before)) {
          before[path] = hash;
        }
      }
      effectTargets.push(...discoveredTargets);
    }
    const sourceBefore = await fingerprintTypecheckAnalysisSources(plan.targets, generatedPaths(plan), plan.exclude);
    store.state.generated ??= {};
    const declarations = await projectDeclarations(plan);
    store.state.generated[context.target.project.project_id] = {
      declarations,
      ready: false,
      project_ids: plan.project_ids,
      input_hash: "",
      outputs: {},
      next,
    };
    for (const target of plan.next_targets) {
      const id = target.project.project_id;
      const input = next[id];
      if (!input) {
        continue;
      }
      const own = store.state.generated[id] ?? {
        ready: false,
        project_ids: [id],
        input_hash: "",
        outputs: {},
        next: {},
      };
      own.ready = false;
      own.next = { ...own.next, [id]: input };
      store.state.generated[id] = own;
    }
    await store.save();
    for (const target of plan.next_targets) {
      const result = await localTool(
        target,
        await lintManagerContext(target, context.signal),
        { package: "next", binary: "next" },
        ["typegen"],
        context.signal,
      );
      assertTypecheckNative(result, "Native next typegen (no build/dev fallback)");
    }
    for (const step of plan.declarations) {
      context.signal.throwIfAborted();
      if (!report.affected_projects.includes(step.target.project.project_id)) {
        report.affected_projects.push(step.target.project.project_id);
      }
      const args = [...step.args];
      args[args.lastIndexOf("--project") + 1] = step.projection;
      const result = await typescriptRun(step.target, args, context.signal);
      const emitted: string[] = [];
      for (const line of result.stdout.split("\n")) {
        if (line.startsWith("TSFILE: ")) {
          const path = await safePath(
            context.target.root,
            resolve(step.target.scope.cwd, line.slice("TSFILE: ".length).trim()),
          );
          emitted.push(path);
          observedOutputs.add(path);
        }
      }
      const output = result.stdout
        .split("\n")
        .filter((line) => !line.startsWith("TSFILE: "))
        .join("\n");
      if (
        !result.cancelled &&
        !result.truncated &&
        !result.stderr.trim() &&
        [0, 1, 2].includes(result.exit_code ?? -1)
      ) {
        const diagnostics = typescriptDiagnostics({ ...context, target: step.target }, output);
        report.diagnostics.push(...diagnostics);
      }
      assertTypecheckNative(result, `Prepare declarations for ${step.target.project.project_id}`);
      const unexpected = emitted.filter((path) => !step.outputs.includes(path));
      if (unexpected.length) {
        unsupported(`Native declaration output differed from effective config prediction: ${unexpected.join(", ")}`);
      }
      for (const output of step.outputs) {
        if (!emitted.includes(output) || !(await Bun.file(output).exists())) {
          unsupported(`Native declaration output is missing from this invocation: ${output}`);
        }
      }
    }
    plan = await resolveJavascriptTypes(context.target, context.signal, next);
    if (plan.project_ids.some((id) => !leasedProjectIds.includes(id))) {
      throw new ChangedClosure(plan.project_ids, report);
    }
    if (
      sourceBefore !== (await fingerprintTypecheckAnalysisSources(plan.targets, generatedPaths(plan), plan.exclude))
    ) {
      throw new TypecheckError(
        "source-changed",
        "Source or route inputs changed during generated type preparation; prepare again",
      );
    }
    await invalidateTools(context, plan);
    // Next can rewrite native config and dependencies. It never selects the retained compiler target.
    const current = await TypecheckStateStore.load(context.target.root);
    for (const target of plan.targets) {
      const receipt = current.state.projects[target.project.project_id];
      if (
        !receipt?.ready ||
        !(await javascriptAdapter.verifyTools({
          ...context,
          target,
          versions: receipt.tools,
        }))
      ) {
        throw new TypecheckError(
          "generator-changed-toolchain",
          "Generated preparation changed the exact compiler environment; prepare the retained target again",
        );
      }
      await applyProjection(await javascriptAdapter.plan(target, context.policy, context.signal), report.changes);
    }
    await verifyReadyTypecheckContext(context, {
      javascript: javascriptAdapter,
    });
    const after = await snapshotTypecheckFiles(
      plan.targets,
      generatedPaths(plan),
      Object.values(plan.next).map((input) => input.dist),
    );
    const outputs: Record<string, string> = {};
    for (const path of generatedPaths(plan)) {
      for (const [file, hash] of Object.entries(after)) {
        if (within(resolve(context.target.root, path), resolve(context.target.root, file))) {
          outputs[file] = hash;
        }
      }
    }
    store = await TypecheckStateStore.load(context.target.root);
    store.state.generated ??= {};
    const receipt: GeneratedTypeReceipt = {
      ready: true,
      declarations,
      project_ids: plan.project_ids,
      input_hash: await inputHash(plan),
      outputs,
      next,
    };
    store.state.generated[context.target.project.project_id] = receipt;
    await store.save();
  } catch (error) {
    if (error instanceof ChangedClosure) {
      throw error;
    }
    report.status = "failed";
    report.complete = false;
    report.cancelled = context.signal.aborted;
    report.errors.push(preparationFailure(error, context.target.project.project_id));
    // A failed or cancelled native generator can still have changed the compiler.
    // Native processes have settled; verify their retained effects before returning.
    try {
      await invalidateTools({ ...context, signal: new AbortController().signal }, plan);
    } catch (verificationError) {
      report.errors.push(preparationFailure(verificationError, context.target.project.project_id));
    }
  } finally {
    report.changes.push(
      ...changedTypecheckFiles(
        effectTargets,
        before,
        await snapshotTypecheckFiles(
          effectTargets,
          [...snapshotOutputs(plan), ...observedOutputs],
          Object.values(plan.next).map((input) => input.dist),
        ),
      ),
    );
    report.affected_projects = [
      ...new Set([...report.affected_projects, ...report.changes.map((change) => change.project_id)]),
    ];
  }
  return report;
}
export interface JavascriptTypesResult<T> {
  ready: boolean;
  preparation: TypecheckPreparation;
  value?: T;
}
/** Internal orchestration seam: one existing union lease covers generation, verification and the caller's check. */
export async function withJavascriptTypes<T>(
  root: string,
  projectId: string,
  adapters: TypecheckAdapterRegistry,
  mode: "prepare" | "check-only",
  operation: (context: TypecheckCheckContext) => Promise<T>,
  signal = new AbortController().signal,
): Promise<JavascriptTypesResult<T>> {
  let retained: TypecheckPreparation | undefined;
  let value: T | undefined;
  let extra: string[] = [];
  for (;;) {
    try {
      const { structure } = await getPackagingStructure(root, {
        refresh: true,
        publish: false,
        signal,
      });
      const target = await resolveTypecheckTarget(structure, projectId);
      const plan = await resolveJavascriptTypes(target, signal);
      const ids = [...new Set([...plan.project_ids, ...extra])];
      await withReadyTypecheckTarget(
        root,
        projectId,
        adapters,
        async (context) => {
          const current = await resolveJavascriptTypes(context.target, signal);
          if (current.project_ids.some((id) => !ids.includes(id))) {
            throw new ChangedClosure(current.project_ids);
          }
          if (mode === "prepare") {
            const result = await prepareJavascriptTypes(context, current, ids);
            if (retained) {
              result.changes.unshift(...retained.changes);
            }
            retained = result;
            if (!result.complete) {
              return;
            }
          } else {
            retained = { ...preparation(context), action: "not-attempted" };
            if (!(await verifyJavascriptTypes(current))) {
              throw new TypecheckError(
                "stale-generated-types",
                "Generated types are missing or stale; run full typecheck preparation",
              );
            }
          }
          const verified = await verifyReadyTypecheckContext(context, adapters);
          value = await operation(verified);
          if (!(await verifyJavascriptTypes(await resolveJavascriptTypes(verified.target, signal)))) {
            throw new TypecheckError(
              "stale-generated-types",
              "Required generated inputs or outputs changed during the check; prepare again",
            );
          }
        },
        signal,
        ids,
      );
      if (!retained) {
        throw new TypecheckError("not-ready", "Generated preparation did not run");
      }
      return {
        ready: retained.complete,
        preparation: retained,
        ...(value === undefined ? {} : { value }),
      };
    } catch (error) {
      if (error instanceof ChangedClosure) {
        extra = error.ids;
        if (error.preparation) {
          if (retained) {
            error.preparation.changes.unshift(...retained.changes);
          }
          retained = error.preparation;
        }
        continue;
      }
      retained ??= {
        status: "failed",
        action: "not-attempted",
        tools: {},
        affected_projects: [],
        changes: [],
        diagnostics: [],
        complete: false,
        cancelled: signal.aborted,
        errors: [],
      };
      retained.status = "failed";
      retained.complete = false;
      retained.cancelled ||= signal.aborted;
      retained.errors.push(preparationFailure(error, projectId));
      return {
        ready: false,
        preparation: retained,
        ...(value === undefined ? {} : { value }),
      };
    }
  }
}
