import { type ProcessResult } from "../../dependencies/model";
import { runProcess } from "../../dependencies/runner";
import { type LintCheckContext } from "../../lint/adapters/types";
import { withGoEnvironment } from "../../lint/go/environment";
import { localGolangci } from "../../lint/go/install";
import { lintManagerContext } from "../../lint/runtime";
import { stableVersion } from "../../lint/versions";
import { assertGoFormatPolicy } from "../go-policy";
import { FormatError } from "../model";
import { isNativeGoPath } from "../selection";

/** Requires a prepared target and held mutation lease. The shared config owns formatter selection. */
export function formatGo(context: LintCheckContext, files: readonly string[]): Promise<ProcessResult> {
  return runGoFormat(context, files, false);
}
export function checkGoFormat(context: LintCheckContext, files: readonly string[]): Promise<ProcessResult> {
  return runGoFormat(context, files, true);
}
async function runGoFormat(
  context: LintCheckContext,
  files: readonly string[],
  check: boolean,
): Promise<ProcessResult> {
  context.signal.throwIfAborted();
  if (files.length === 0 || files.some((path) => !isNativeGoPath(path))) {
    throw new FormatError(
      "invalid-files",
      "Each target must be a safe explicit Go file; dot basenames, uppercase extensions and ... paths are unsupported",
    );
  }
  assertGoFormatPolicy(context.policy.go);
  const binary = await localGolangci(context.target.root, stableVersion(context.versions["golangci-lint"]));
  const native = await lintManagerContext(context.target, context.signal);
  return withGoEnvironment(context.target, native, (env) =>
    runProcess(
      binary,
      [
        "fmt",
        ...(check ? ["--diff"] : []),
        "--config",
        context.projection.configs.format,
        "--",
        ...files.map((file) => `./${file}`),
      ],
      { cwd: context.target.scope.cwd, env, signal: context.signal },
    ),
  );
}
