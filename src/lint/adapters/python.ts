import { relative, resolve } from "node:path";
import { object } from "../../dependencies/inventory";
import { type ProcessResult, redact } from "../../dependencies/model";
import { within } from "../../dependencies/paths";
import { runProcess } from "../../dependencies/runner";
import { type CheckKind, type LintCheck, type LintDiagnostic, LintError } from "../model";
import { installRuff, localRuff, ruffArtifact } from "../ruff-install";
import { collectLintScope } from "../scope";
import { type LintTarget } from "../targets";
import { RUFF_VERSION } from "../toolchain";
import { type LintAdapter, type LintCheckContext } from "./types";

function successful(result: ProcessResult): boolean {
  return result.exit_code === 0 && !result.truncated && !result.cancelled;
}
async function versionMatches(path: string, context: Pick<LintCheckContext, "target" | "signal">): Promise<boolean> {
  const result = await runProcess(path, ["--version"], {
    cwd: context.target.scope.cwd,
    env: { ...context.target.scope.env, RUFF_OUTPUT_FILE: undefined },
    signal: context.signal,
  });
  return successful(result) && result.stdout.trim() === `ruff ${RUFF_VERSION}`;
}
async function ready(context: Pick<LintCheckContext, "target" | "signal" | "versions">): Promise<boolean> {
  try {
    return (
      context.versions.ruff === RUFF_VERSION && (await versionMatches(await localRuff(context.target.root), context))
    );
  } catch {
    context.signal.throwIfAborted();
    return false;
  }
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
    const executable = await localRuff(context.target.root);
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
  resolve(targets, _policy, signal) {
    return Promise.resolve().then(() => {
      signal.throwIfAborted();
      return Object.fromEntries(targets.map((target) => [target.project.project_id, { ruff: RUFF_VERSION }]));
    });
  },
  preflight(context) {
    return Promise.resolve().then(() => {
      context.signal.throwIfAborted();
      ruffArtifact();
      for (const target of context.targets) {
        if (context.versions[target.project.project_id]?.ruff !== RUFF_VERSION) {
          throw new LintError("invalid-version", "Ruff preparation requires the Justomp release version");
        }
      }
    });
  },
  async prepareBatch(context) {
    await pythonAdapter.preflight(context);
    const prepared = new Set<string>();
    for (const target of context.targets) {
      if (prepared.has(target.root)) {
        continue;
      }
      const check = {
        target,
        versions: { ruff: RUFF_VERSION },
        signal: context.signal,
      };
      if (!(await ready(check))) {
        await installRuff(target.root, target.project.project_id, context.signal, context.changes, async (path) => {
          if (!(await versionMatches(path, check))) {
            throw new LintError(
              "native-preparation-failed",
              "Official Ruff binary does not match the Justomp release version",
            );
          }
        });
      }
      prepared.add(target.root);
    }
  },
  verify(context) {
    return ready(context);
  },
  async fix(context, files) {
    return runProcess(
      await localRuff(context.target.root),
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
