import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parse } from "smol-toml";
import { planUvDevBatch, uvAdapter } from "../../dependencies/adapters/uv";
import { readOptional } from "../../dependencies/executable";
import { object } from "../../dependencies/inventory";
import { type ProcessResult, redact } from "../../dependencies/model";
import { safePath, within } from "../../dependencies/paths";
import { runProcess } from "../../dependencies/runner";
import { type CheckKind, type LintCheck, type LintDiagnostic, LintError } from "../model";
import { lintManagerContext } from "../runtime";
import { collectLintScope } from "../scope";
import { type LintTarget } from "../targets";
import { fetchVersionJSON, stableVersion } from "../versions";
import { metadataChangeKind } from "./metadata";
import { type LintAdapter, type LintCheckContext, type LintOperationContext } from "./types";

export function pythonBinary(target: LintTarget, name = "ruff"): string {
  return join(
    resolve(target.scope.owner, target.scope.env.UV_PROJECT_ENVIRONMENT || ".venv"),
    process.platform === "win32" ? "Scripts" : "bin",
    `${name}${process.platform === "win32" ? ".exe" : ""}`,
  );
}
function successful(result: ProcessResult): boolean {
  return result.exit_code === 0 && !result.truncated && !result.cancelled;
}
function nativeFailure(result: ProcessResult, stage: string): never {
  throw new LintError(
    result.cancelled ? "cancelled" : "native-preparation-failed",
    redact(
      `${stage}: ${result.stderr || result.stdout || `exit ${result.exit_code}`}${result.truncated ? " (output truncated)" : ""}`,
    ),
  );
}
async function batch(context: LintOperationContext) {
  const contexts = [];
  let version: string | undefined;
  for (const target of context.targets) {
    const selected = stableVersion(context.versions[target.project.project_id]?.ruff);
    if (version && selected !== version) {
      throw new LintError("invalid-version", "Python batch requires the same exact Ruff version for every member");
    }
    version = selected;
    contexts.push(await lintManagerContext(target, context.signal));
  }
  return {
    contexts,
    steps: await planUvDevBatch(contexts, "ruff", version ?? ""),
  };
}
function paths(target: LintTarget, filename: string) {
  const absolute = resolve(target.scope.cwd, filename);
  if (!within(target.root, absolute) || !within(target.scope.cwd, absolute)) {
    return {};
  }
  return {
    path: relative(target.root, absolute).replaceAll("\\", "/"),
    project_path: relative(target.scope.cwd, absolute).replaceAll("\\", "/"),
  };
}
function diagnostics(context: LintCheckContext, kind: CheckKind, stdout: string): LintDiagnostic[] {
  const values: unknown = JSON.parse(stdout);
  if (!Array.isArray(values)) {
    throw new Error("Ruff returned invalid JSON diagnostics");
  }
  return values.map((value) => {
    const item = object(value),
      location = object(item.location),
      end = object(item.end_location);
    if (typeof item.filename !== "string" || typeof item.message !== "string") {
      throw new Error("Ruff returned invalid JSON diagnostics");
    }
    return {
      kind,
      ...paths(context.target, item.filename),
      ...positions(location, end),
      ...(typeof item.code === "string" ? { rule: item.code } : {}),
      severity: "error",
      message: redact(item.message),
    };
  });
}

function positions(location: Record<string, unknown>, end: Record<string, unknown>): Partial<LintDiagnostic> {
  return {
    ...(typeof location.row === "number" ? { line: location.row } : {}),
    ...(typeof location.column === "number" ? { column: location.column } : {}),
    ...(typeof end.row === "number" ? { end_line: end.row } : {}),
    ...(typeof end.column === "number" ? { end_column: end.column } : {}),
  };
}
async function existingPython(target: LintTarget): Promise<string | undefined> {
  const environment = resolve(target.scope.owner, target.scope.env.UV_PROJECT_ENVIRONMENT || ".venv");
  let existing: string | undefined;
  let environmentExists = false;
  try {
    await lstat(environment);
    environmentExists = true;
    existing = await realpath(pythonBinary(target, "python"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || environmentExists) {
      throw new LintError("runtime-unavailable", "Existing Python runtime is damaged; repair it explicitly");
    }
  }
  return existing;
}
async function validateRequirement(
  native: Awaited<ReturnType<typeof lintManagerContext>>,
  requirement: unknown,
  selected: ProcessResult,
): Promise<void> {
  if (typeof requirement === "string") {
    const version = await native.run({
      args: ["python", "find", "--show-version", selected.stdout.trim()],
      label: "Inspect selected Python",
      env: { UV_PYTHON_DOWNLOADS: "never" },
    });
    if (!successful(version)) {
      nativeFailure(version, "Could not inspect selected Python runtime");
    }
    const compatible = await native.run({
      args: ["python", "find", `${requirement},==${version.stdout.trim()}`],
      label: "Validate selected Python",
      env: { UV_PYTHON_DOWNLOADS: "never" },
    });
    if (!successful(compatible)) {
      nativeFailure(compatible, "Selected Python runtime does not satisfy project constraints");
    }
  }
}
async function observeMetadata(
  context: LintOperationContext,
  metadata: Map<string, LintTarget>,
  before: Map<string, string | null>,
): Promise<void> {
  for (const [path, target] of metadata) {
    const after = (await readOptional(path)) ?? null,
      previous = before.get(path);
    if (after !== previous) {
      context.changes.push({
        project_id: target.project.project_id,
        path: relative(target.root, path).replaceAll("\\", "/"),
        kind: metadataChangeKind(previous, after),
      });
    }
  }
}
function applyCheckResult(context: LintCheckContext, check: LintCheck, result: ProcessResult): void {
  const kind = check.kind;
  check.exit_code = result.exit_code;
  check.truncated = result.truncated;
  check.cancelled = result.cancelled;
  if (!result.truncated && !result.cancelled && (result.exit_code === 0 || result.exit_code === 1)) {
    check.diagnostics = diagnostics(context, kind, result.stdout);
    check.status = result.exit_code === 0 ? "passed" : "failed";
  } else {
    check.reason = redact(result.stderr || result.stdout || "Ruff did not complete");
  }
}
async function checkSource(context: LintCheckContext, files: string[], check: LintCheck): Promise<void> {
  const kind = check.kind;
  const start = performance.now();
  try {
    const executable = await safePath(context.target.root, pythonBinary(context.target));
    const result = await runProcess(
      executable,
      [
        kind === "lint" ? "check" : "format",
        ...(kind === "lint" ? ["--no-fix", "--no-fix-only"] : ["--check"]),
        "--config",
        context.projection.configs[kind],
        "--force-exclude",
        "--output-format",
        "json",
        "--",
        ...files.map((file) => `./${file}`),
      ],
      {
        cwd: context.target.scope.cwd,
        env: { ...context.target.scope.env, RUFF_OUTPUT_FILE: undefined },
        signal: context.signal,
      },
    );
    applyCheckResult(context, check, result);
  } catch (error) {
    check.reason = redact(error instanceof Error ? error.message : String(error));
    check.cancelled = context.signal.aborted;
  } finally {
    check.duration_ms = performance.now() - start;
  }
}
export const pythonAdapter: LintAdapter = {
  async resolve(targets, _policy, signal, existing) {
    const retained = Object.values(existing ?? {}).map((tools) => stableVersion(tools.ruff));
    let version = retained[0];
    if (!version) {
      const releases = object(object(await fetchVersionJSON("https://pypi.org/pypi/ruff/json", signal)).releases);
      const candidates = Object.entries(releases)
        .filter(
          ([release, files]) =>
            /^\d+\.\d+\.\d+$/.test(release) &&
            Array.isArray(files) &&
            files.some((file) => object(file).yanked === false),
        )
        .map(([release]) => release)
        .sort((a, b) => {
          const left = a.split(".").map(Number),
            right = b.split(".").map(Number);
          for (let index = 0; index < 3; index++) {
            const difference = (right[index] ?? 0) - (left[index] ?? 0);
            if (difference) {
              return difference;
            }
          }
          return 0;
        });
      version = stableVersion(candidates[0]);
    }
    if (retained.some((value) => value !== version)) {
      throw new LintError("invalid-version", "Python projects have inconsistent retained Ruff versions");
    }
    return Object.fromEntries(targets.map((target) => [target.project.project_id, { ruff: version }]));
  },
  async preflight(context) {
    const { contexts } = await batch(context);
    for (const [index, native] of contexts.entries()) {
      const target = context.targets[index];
      if (!target) {
        continue;
      }
      const existing = await existingPython(target);
      const data = object(parse(await readFile(join(target.root, target.project.manifest), "utf8")));
      const requirement = object(data.project)["requires-python"];
      // Honor native selection first, then evaluate that exact version against
      // requires-python. uv find otherwise only warns for an incompatible pin.
      const selected = await native.run({
        args: ["python", "find"],
        label: "Find existing Python",
        env: { UV_PYTHON_DOWNLOADS: "never" },
      });
      if (!successful(selected)) {
        nativeFailure(selected, "No compatible installed Python runtime");
      }
      if (existing && (await realpath(selected.stdout.trim())) !== existing) {
        throw new LintError(
          "runtime-conflict",
          "Python runtime would be replaced; reconcile the existing environment and project constraints explicitly",
        );
      }
      await validateRequirement(native, requirement, selected);
    }
  },
  async prepareBatch(context) {
    const { contexts, steps } = await batch(context);
    const native = contexts[0];
    const first = context.targets[0];
    if (!native || !first) {
      return;
    }
    const metadata = new Map<string, LintTarget>();
    for (const target of context.targets) {
      metadata.set(join(target.root, target.project.manifest), target);
    }
    metadata.set(join(native.owner, "uv.lock"), first);
    const before = new Map<string, string | null>();
    for (const path of metadata.keys()) {
      before.set(path, (await readOptional(path)) ?? null);
    }
    try {
      for (const step of steps) {
        const result = await native.run(step);
        if (!successful(result)) {
          nativeFailure(result, step.label);
        }
      }
    } finally {
      await observeMetadata(context, metadata, before);
    }
  },
  async verify(context) {
    try {
      const native = await lintManagerContext(context.target, context.signal);
      const inventory = await uvAdapter.inventory(native, false);
      const ruff = inventory.dependencies.filter((item) => item.name === "ruff");
      if (!inventory.complete || ruff.length !== 1) {
        return false;
      }
      const item = ruff[0];
      if (!item) {
        return false;
      }
      if (
        item.group.kind !== "dev" ||
        item.source.kind !== "registry" ||
        item.marker ||
        item.extras?.length ||
        item.ambiguous ||
        item.declared_specifier !== `==${context.versions.ruff}` ||
        !item.resolutions?.length ||
        item.resolutions.some((value) => value.version !== context.versions.ruff)
      ) {
        return false;
      }
      const executable = await safePath(context.target.root, pythonBinary(context.target));
      const result = await runProcess(executable, ["--version"], {
        cwd: context.target.scope.cwd,
        env: context.target.scope.env,
        signal: context.signal,
      });
      return successful(result) && result.stdout.trim() === `ruff ${context.versions.ruff}`;
    } catch {
      context.signal.throwIfAborted();
      return false;
    }
  },
  async fix(context, files) {
    return runProcess(
      await safePath(context.target.root, pythonBinary(context.target)),
      [
        "check",
        "--fix",
        "--no-fix-only",
        "--no-unsafe-fixes",
        "--config",
        context.projection.configs.lint,
        "--force-exclude",
        "--output-format",
        "json",
        "--",
        ...files.map((file) => `./${file}`),
      ],
      {
        cwd: context.target.scope.cwd,
        env: { ...context.target.scope.env, RUFF_OUTPUT_FILE: undefined },
        signal: context.signal,
      },
    );
  },
  async check(context) {
    const scope = await collectLintScope(context.target);
    const checks: LintCheck[] = [];
    for (const kind of ["lint", "format"] as const) {
      const check: LintCheck = {
        kind,
        status: scope.empty ? "no-sources" : "not-run",
        tool: "ruff",
        version: context.versions.ruff ?? null,
        exit_code: null,
        duration_ms: 0,
        diagnostics: [],
        truncated: false,
        cancelled: false,
      };
      checks.push(check);
      if (scope.empty) {
        continue;
      }
      await checkSource(context, scope.files, check);
    }
    return checks;
  },
};
