import { type ProcessResult } from "../../dependencies/model";
import { runProcess } from "../../dependencies/runner";
import { type LintCheckContext } from "../../lint/adapters/types";
import { localRuff } from "../../lint/ruff-install";

/** Requires a prepared target and held mutation lease. No lint fixes or tool installation. */
export function formatPython(context: LintCheckContext, files: readonly string[]): Promise<ProcessResult> {
  return runPythonFormat(context, files, false);
}
export function checkPythonFormat(context: LintCheckContext, files: readonly string[]): Promise<ProcessResult> {
  return runPythonFormat(context, files, true);
}
async function runPythonFormat(
  context: LintCheckContext,
  files: readonly string[],
  check: boolean,
): Promise<ProcessResult> {
  context.signal.throwIfAborted();
  return runProcess(
    await localRuff(context.target.root),
    [
      "format",
      ...(check ? ["--check"] : []),
      "--config",
      context.projection.configs.format,
      "--force-exclude",
      "--",
      ...files.map((file) => `./${file}`),
    ],
    {
      cwd: context.target.scope.cwd,
      env: { ...context.target.scope.env, RUFF_OUTPUT_FILE: undefined },
      signal: context.signal,
    },
  );
}
