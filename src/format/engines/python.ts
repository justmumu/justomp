import type { ProcessResult } from "../../dependencies/model";
import { safePath } from "../../dependencies/paths";
import { runProcess } from "../../dependencies/runner";
import { pythonBinary } from "../../lint/adapters/python";
import type { LintCheckContext } from "../../lint/adapters/types";

/** Requires a prepared target and held mutation lease. No lint fixes or tool installation. */
export async function formatPython(
  context: LintCheckContext,
  files: readonly string[],
): Promise<ProcessResult> {
  context.signal.throwIfAborted();
  return runProcess(
    await safePath(context.target.root, pythonBinary(context.target)),
    [
      "format",
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
