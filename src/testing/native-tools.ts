import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parse } from "smol-toml";
import { planUvDevBatch, uvAdapter } from "../dependencies/adapters/uv";
import { readOptional } from "../dependencies/executable";
import { object } from "../dependencies/inventory";
import { type Inventory, type NativeStep, type ProcessResult, redact } from "../dependencies/model";
import { runProcess } from "../dependencies/runner";
import { compatible, nodeVersion, registryPackage, satisfies, toolMetadata } from "../lint/javascript/compatibility";
import { installedPackages, localTool, nativeAdapter, succeeded } from "../lint/javascript/native";
import { lintManagerContext } from "../lint/runtime";
import { type NativeTestResult, type TestRunContext, type TestToolContext, type TestTools } from "./adapters";
import { TestError, type TestPreparation, unknownTests } from "./model";
import { testIssue } from "./prepare";
import { type TestTarget } from "./targets";
import { stableVersion } from "./versions";
export function requireNative(result: ProcessResult, label: string): void {
  if (!succeeded(result)) {
    throw new TestError(
      result.cancelled ? "cancelled" : "native-preparation-failed",
      redact(`${label}: ${result.stderr || result.stdout || result.exit_code}`),
    );
  }
}
export function pythonBinary(target: TestTarget): string {
  return join(
    resolve(target.scope.owner, target.scope.env.UV_PROJECT_ENVIRONMENT || ".venv"),
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python",
  );
}
export function exactDeclarations(inventory: Inventory, tools: TestTools, python = false): boolean {
  if (!inventory.complete || inventory.diagnostics.length) {
    return false;
  }
  return Object.entries(tools).every(([name, version]) => {
    const entries = inventory.dependencies.filter((d) => d.name === name),
      item = entries[0];
    return (
      entries.length === 1 &&
      !!item &&
      item.group.kind === "dev" &&
      item.source.kind === "registry" &&
      !item.ambiguous &&
      !item.marker &&
      !item.extras?.length &&
      item.declared_specifier === `${python ? "==" : ""}${version}` &&
      !!item.resolutions?.length &&
      item.resolutions.every((r) => r.version === version)
    );
  });
}
export async function trackChanges(
  context: TestToolContext,
  paths: string[],
  changes: TestPreparation["changes"],
  work: () => Promise<void>,
): Promise<void> {
  const before = new Map<string, string | null>();
  for (const path of paths) {
    before.set(path, (await readOptional(path)) ?? null);
  }
  try {
    await work();
  } finally {
    for (const [path, previous] of before) {
      const after = (await readOptional(path)) ?? null;
      if (after !== previous) {
        changes.push({
          project_id: context.target.project.project_id,
          path: relative(context.target.root, path).replaceAll("\\", "/"),
          kind: after === null ? "removed" : previous === null ? "created" : "updated",
        });
      }
    }
  }
}
async function pythonPlan(context: TestToolContext) {
  const native = await lintManagerContext(context.target, context.signal);
  const declarations: NativeStep[] = [];
  let solve: NativeStep[] = [];
  for (const [name, version] of Object.entries(context.tools)) {
    const steps = await planUvDevBatch([native], name, stableVersion(version));
    declarations.push(...steps.slice(0, -2));
    solve = steps.slice(-2);
  }
  return {
    native,
    steps: [...declarations, ...solve].map((step) => ({
      ...step,
      env: { ...step.env, UV_PYTHON_DOWNLOADS: "never" },
    })),
  };
}
export async function preflightPython(context: TestToolContext): Promise<void> {
  const { native } = await pythonPlan(context),
    { target } = context;
  const env = resolve(target.scope.owner, target.scope.env.UV_PROJECT_ENVIRONMENT || ".venv");
  let existing: string | undefined,
    exists = false;
  try {
    await lstat(env);
    exists = true;
    existing = await realpath(pythonBinary(target));
  } catch (error) {
    if (exists || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new TestError("runtime-unavailable", "Existing Python environment is damaged");
    }
  }
  const selected = await native.run({
    args: ["python", "find"],
    label: "Find installed Python",
    env: { UV_PYTHON_DOWNLOADS: "never" },
  });
  requireNative(selected, "Find installed Python");
  if (existing && existing !== (await realpath(selected.stdout.trim()))) {
    throw new TestError("runtime-conflict", "Preparation would replace the installed Python interpreter");
  }
  const data = object(parse(await readFile(join(target.root, target.project.manifest), "utf8"))),
    requirement = object(data.project)["requires-python"];
  const version = await native.run({
    args: ["python", "find", "--show-version", selected.stdout.trim()],
    label: "Inspect Python",
    env: { UV_PYTHON_DOWNLOADS: "never" },
  });
  requireNative(version, "Inspect Python");
  if (typeof requirement === "string") {
    requireNative(
      await native.run({
        args: ["python", "find", `${requirement},==${version.stdout.trim()}`],
        label: "Validate Python",
        env: { UV_PYTHON_DOWNLOADS: "never" },
      }),
      "Validate Python",
    );
  }
  // Let uv's dry-run solver validate selected latest tools and Python before any cohort mutation.
  const check = await native.run({
    args: [
      "pip",
      "install",
      "--dry-run",
      "--break-system-packages",
      "--python",
      selected.stdout.trim(),
      ...Object.entries(context.tools).map(([n, v]) => `${n}==${v}`),
    ],
    label: "Validate pytest compatibility",
    env: { UV_PYTHON_DOWNLOADS: "never" },
  });
  requireNative(check, "Validate pytest compatibility");
}
export async function preparePython(context: TestToolContext, changes: TestPreparation["changes"]): Promise<void> {
  const { native, steps } = await pythonPlan(context);
  await trackChanges(
    context,
    [join(context.target.root, context.target.project.manifest), join(native.owner, "uv.lock")],
    changes,
    async () => {
      for (const step of steps) {
        requireNative(await native.run(step), step.label);
      }
    },
  );
}
export async function verifyPython(context: TestToolContext): Promise<boolean> {
  try {
    const native = await lintManagerContext(context.target, context.signal);
    if (!exactDeclarations(await uvAdapter.inventory(native, false), context.tools, true)) {
      return false;
    }
    const result = await runProcess(
      pythonBinary(context.target),
      [
        "-I",
        "-B",
        "-c",
        'import json,sys,pytest,pytest_cov,importlib.metadata as m; from packaging.specifiers import SpecifierSet; names=["pytest","pytest-cov"]; assert all(SpecifierSet(m.metadata(n).get("Requires-Python","")).contains(".".join(map(str,sys.version_info[:3]))) for n in names); print(json.dumps({n:m.version(n) for n in names}))',
      ],
      {
        cwd: context.target.scope.cwd,
        env: context.target.scope.env,
        signal: context.signal,
      },
    );
    if (!succeeded(result)) {
      return false;
    }
    const actual = JSON.parse(result.stdout);
    if (Object.entries(context.tools).some(([n, v]) => actual[n] !== v)) {
      return false;
    }
    return succeeded(
      await native.run({
        args: ["lock", "--check", "--offline"],
        label: "Verify pytest lock",
        env: { UV_PYTHON_DOWNLOADS: "never" },
      }),
    );
  } catch {
    context.signal.throwIfAborted();
    return false;
  }
}
export function javascriptToolRequest(project_id: string, name: string, version: string, inventory: Inventory) {
  stableVersion(version);
  const entries = inventory.dependencies.filter((d) => d.name === name);
  if (
    entries.length > 1 ||
    entries.some((d) => d.group.kind !== "dev" || d.source.kind !== "registry" || d.ambiguous)
  ) {
    throw new TestError("conflicting-declaration", `${name} requires one registry dev declaration`);
  }
  return entries.length
    ? {
        operation: "update" as const,
        project_id,
        mode: "within_constraints" as const,
        packages: [{ name, version, group: { kind: "dev" as const } }],
      }
    : {
        operation: "add" as const,
        project_id,
        group: { kind: "dev" as const },
        packages: [{ name, version, source: { kind: "registry" as const } }],
      };
}
export async function javascriptPlan(context: TestToolContext) {
  const native = await lintManagerContext(context.target, context.signal),
    adapter = nativeAdapter(native),
    inventory = await adapter.inventory(native, false);
  const plans = [];
  for (const [name, version] of Object.entries(context.tools)) {
    const request = javascriptToolRequest(context.target.project.project_id, name, version, inventory);
    const plan = await adapter.plan(native, request, inventory);
    if (request.operation === "add") {
      for (const step of plan.steps) {
        step.args.push(native.manager === "npm" || native.manager === "pnpm" ? "--save-exact" : "--exact");
      }
    }
    plans.push(plan);
  }
  return { native, adapter, inventory, plans };
}
export async function preflightJavascript(context: TestToolContext): Promise<void> {
  const { native, inventory } = await javascriptPlan(context);
  const metadata = await toolMetadata(context.target, native, context.tools, context.signal),
    node = await nodeVersion(context.target, native, context.signal),
    selected = { ...context.tools };
  const vite = inventory.dependencies.find((d) => d.name === "vite");
  if (vite) {
    const installed = await installedPackages(context.target, native, ["vite"], context.signal);
    const candidate =
      installed.vite?.version ??
      vite.resolutions?.[0]?.version ??
      (await registryPackage("vite", context.signal)).find(
        (m) => typeof m.version === "string" && satisfies(m.version, vite.declared_specifier),
      )?.version;
    selected.vite = stableVersion(candidate);
    if (!satisfies(selected.vite, vite.declared_specifier)) {
      throw new TestError("incompatible-toolchain", "Installed Vite conflicts with its application declaration");
    }
    const range = object(metadata.vitest?.dependencies).vite ?? object(metadata.vitest?.peerDependencies).vite;
    if (range && !satisfies(selected.vite, range)) {
      throw new TestError(
        "incompatible-toolchain",
        `Application Vite ${selected.vite} is incompatible with Vitest ${selected.vitest}; reconcile explicitly`,
      );
    }
  }
  for (const [name, data] of Object.entries(metadata)) {
    if (!compatible(data, selected, node)) {
      throw new TestError(
        "incompatible-toolchain",
        `${name} is incompatible with Node ${node} or selected runner peers`,
      );
    }
  }
}
/** Keep native manager scope/flags, solving the runner and its matching peer together. */
export function batchJavascriptSteps(steps: NativeStep[], tools: TestTools): NativeStep[] {
  const packages = new Set(Object.entries(tools).flatMap(([n, v]) => [n, `${n}@${v}`])),
    groups = new Map<string, NativeStep>();
  for (const step of steps) {
    const rest = step.args.filter((a) => !packages.has(a)),
      key = JSON.stringify([step.cwd, step.env, rest]);
    const previous = groups.get(key);
    if (previous) {
      const additions = step.args.filter((a) => packages.has(a));
      previous.args.push(...additions);
    } else {
      groups.set(key, { ...step, args: [...step.args] });
    }
  }
  return [...groups.values()].sort((a, b) => Number(b.args.includes("remove")) - Number(a.args.includes("remove")));
}
export async function prepareJavascript(context: TestToolContext, changes: TestPreparation["changes"]): Promise<void> {
  const { native, plans } = await javascriptPlan(context);
  const paths = [...new Set(plans.flatMap((p) => p.metadata.map((path) => join(context.target.root, path))))];
  await trackChanges(context, paths, changes, async () => {
    for (const step of batchJavascriptSteps(
      plans.flatMap((p) => p.steps),
      context.tools,
    )) {
      requireNative(await native.run(step), step.label);
    }
  });
}
export async function verifyJavascript(context: TestToolContext): Promise<boolean> {
  try {
    const { target, tools, signal } = context,
      native = await lintManagerContext(target, signal),
      inventory = await nativeAdapter(native).inventory(native, false);
    if (!exactDeclarations(inventory, tools)) {
      return false;
    }
    const installed = await installedPackages(target, native, [...Object.keys(tools), "vite"], signal),
      node = await nodeVersion(target, native, signal),
      selected = { ...tools };
    const vite = inventory.dependencies.find((d) => d.name === "vite");
    if (vite) {
      const actual = installed.vite?.version;
      if (typeof actual !== "string" || !satisfies(actual, vite.declared_specifier)) {
        return false;
      }
      selected.vite = actual;
      const range = object(installed.vitest?.dependencies).vite ?? object(installed.vitest?.peerDependencies).vite;
      if (range && !satisfies(actual, range)) {
        return false;
      }
    }
    if (
      !Object.entries(tools).every(
        ([n, v]) => installed[n]?.version === v && compatible(installed[n] ?? {}, selected, node),
      )
    ) {
      return false;
    }
    const result = await localTool(target, native, { package: "vitest", binary: "vitest" }, ["--version"], signal);
    return succeeded(result) && result.stdout.includes(`vitest/${tools.vitest}`);
  } catch {
    context.signal.throwIfAborted();
    return false;
  }
}
export function coverageEnabled(context: TestRunContext): boolean {
  return context.mode === "full" && context.policy.coverage.enabled;
}
export function nativeResult(process: ProcessResult): NativeTestResult {
  const errors = [];
  if (process.cancelled) {
    errors.push({
      code: "cancelled",
      message: "Native test process was cancelled",
    });
  } else if (process.exit_code !== 0) {
    errors.push({
      code: "native-test-failed",
      message: `Native test process exited ${process.exit_code}${process.signal ? ` (${process.signal})` : ""}`,
    });
  }
  return {
    tests: unknownTests(),
    errors,
    executed_files: [],
    stdout: redact(process.stdout),
    stderr: redact(process.stderr),
    logs_truncated: process.truncated,
  };
}
export function classifyResult(result: NativeTestResult, collectionError = false): void {
  if (!collectionError && result.tests.failed && result.errors.some((e) => e.code === "native-test-failed")) {
    result.errors = result.errors.map((e) =>
      e.code === "native-test-failed" ? { code: "test-failed", message: "One or more tests failed" } : e,
    );
  }
  if (collectionError) {
    result.errors.push({
      code: "collection-failed",
      message: "Native test collection or setup failed",
    });
  }
}
export async function parseEvidence(result: NativeTestResult, read: () => Promise<void>): Promise<void> {
  try {
    await read();
  } catch (error) {
    result.errors.push(testIssue(error));
  }
}
