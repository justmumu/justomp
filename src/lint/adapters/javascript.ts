import { join, relative, resolve } from "node:path";
import { type ProcessResult, redact } from "../../dependencies/model";
import { within } from "../../dependencies/paths";
import { runProcess } from "../../dependencies/runner";
import { checkPrettierFile, prettierVersion } from "../../format/engines/prettier";
import { formatterFor } from "../../format/selection";
import { assertNative, succeeded } from "../javascript/native";
import { resolveJavascript } from "../javascript/resolve";
import { biomeDiagnostics } from "../javascript/result";
import { BIOME_PACKAGE } from "../javascript/tools";
import { type LintCheck, LintError } from "../model";
import { collectLintScope } from "../scope";
import { BIOME_VERSION, bundledBiome } from "../toolchain";
import { type LintAdapter, type LintCheckContext } from "./types";

function biomeEnvironment(env: Record<string, string | undefined>) {
  return {
    ...env,
    BIOME_BINARY: undefined,
    BIOME_CONFIG_PATH: undefined,
    BIOME_LOG_FILE: undefined,
    BIOME_LOG_LEVEL: undefined,
  };
}

async function runBiome(context: LintCheckContext, args: string[]): Promise<ProcessResult> {
  return runProcess(await bundledBiome(), args, {
    cwd: context.target.scope.cwd,
    env: biomeEnvironment(context.target.scope.env),
    signal: context.signal,
  });
}

async function biomeVersion(signal: AbortSignal): Promise<ProcessResult> {
  return runProcess(await bundledBiome(), ["--version"], {
    cwd: process.cwd(),
    env: biomeEnvironment(process.env),
    signal,
  });
}

function expectedBiome(result: ProcessResult): boolean {
  return succeeded(result) && result.stdout.trim().replace(/^Version:\s*/, "") === BIOME_VERSION;
}

function diagnosticPath(context: LintCheckContext, filename: string) {
  const absolute = resolve(context.target.scope.cwd, filename);
  if (!within(context.target.root, absolute) || !within(context.target.scope.cwd, absolute)) {
    return {};
  }
  return {
    path: relative(context.target.root, absolute).replaceAll("\\", "/"),
    project_path: relative(context.target.scope.cwd, absolute).replaceAll("\\", "/"),
  };
}
function biomeArgs(context: LintCheckContext, files: readonly string[], write = false): string[] {
  return [
    "check",
    `--config-path=${context.projection.configs.lint}`,
    "--formatter-enabled=false",
    "--linter-enabled=true",
    "--assist-enabled=true",
    "--enforce-assist=true",
    "--max-diagnostics=none",
    "--reporter=json",
    ...(write ? ["--write"] : []),
    "--",
    ...files.map((file) => `./${file}`),
  ];
}
function applyCheckResult(context: LintCheckContext, files: string[], check: LintCheck, result: ProcessResult): void {
  const tool = check.tool;
  check.exit_code = result.exit_code;
  check.cancelled = result.cancelled;
  check.truncated = result.truncated;
  if (!result.cancelled && !result.truncated && (result.exit_code === 0 || result.exit_code === 1)) {
    check.diagnostics = biomeDiagnostics(context, result, files);
    check.status = result.exit_code === 0 ? "passed" : "failed";
  } else {
    check.reason = redact(result.stderr || `${tool} did not complete (exit ${result.exit_code})`);
  }
}
async function checkSource(context: LintCheckContext, files: string[], check: LintCheck): Promise<void> {
  const { kind } = check;
  const start = performance.now();
  try {
    context.signal.throwIfAborted();
    if (kind === "format") {
      await checkFormatting(context, files, check);
      check.exit_code = check.diagnostics.length ? 1 : 0;
      check.status = check.diagnostics.length ? "failed" : "passed";
      return;
    }
    const result = await runBiome(context, biomeArgs(context, files));
    applyCheckResult(context, files, check, result);
  } catch (error) {
    check.reason = redact(error instanceof Error ? error.message : String(error));
    check.cancelled = context.signal.aborted;
  } finally {
    check.duration_ms = performance.now() - start;
  }
}
async function checkFormatting(context: LintCheckContext, files: string[], check: LintCheck): Promise<void> {
  const kind = check.kind;
  for (const file of files) {
    context.signal.throwIfAborted();
    const formatter = formatterFor(file, "javascript");
    if (formatter?.engine !== "prettier") {
      throw new Error(`No bundled formatter for ${file}`);
    }
    if (
      !(await checkPrettierFile(
        join(context.target.scope.cwd, file),
        formatter.parser,
        context.policy.javascript.prettier,
      ))
    ) {
      check.diagnostics.push({
        kind,
        severity: "error",
        message: "File does not match the shared Prettier format",
        ...diagnosticPath(context, file),
      });
    }
  }
  context.signal.throwIfAborted();
}
export const javascriptAdapter: LintAdapter = {
  resolve: resolveJavascript,
  async preflight(context) {
    const result = await biomeVersion(context.signal);
    assertNative(result, "Verify Justomp Biome");
    if (!expectedBiome(result)) {
      throw new LintError("missing-tool", `Justomp requires bundled Biome ${BIOME_VERSION}`);
    }
  },
  async prepareBatch(context) {
    context.signal.throwIfAborted();
    await bundledBiome();
  },
  async verify(context) {
    if (context.versions[BIOME_PACKAGE] !== BIOME_VERSION) {
      return false;
    }
    try {
      return expectedBiome(await biomeVersion(context.signal));
    } catch {
      context.signal.throwIfAborted();
      return false;
    }
  },
  fix(context, files) {
    return runBiome(context, biomeArgs(context, files, true));
  },
  async check(context) {
    const scope = await collectLintScope(context.target, context.policy.javascript.exclude);
    const checks: LintCheck[] = [];
    for (const kind of ["lint", "format"] as const) {
      const tool = kind === "lint" ? "biome" : "prettier";
      const check: LintCheck = {
        kind,
        status: scope.empty ? "no-sources" : "not-run",
        tool,
        version: kind === "format" ? prettierVersion : BIOME_VERSION,
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
