import { resolve } from "node:path";
import { type LoadedConfig, loadConfig } from "../config/load";
import { type ProcessResult } from "../dependencies/model";
import { type LintCheckContext } from "../lint/adapters/types";
import { withReadyLintTarget } from "../lint/coordinator";
import { lintAdapters } from "../lint/service";
import { checkGoFormat } from "./engines/go";
import { checkPrettier } from "./engines/prettier";
import { checkPythonFormat } from "./engines/python";
import { readFormatFile } from "./files";
import { type Formatter } from "./model";
import { type FormatIssue, formatIssue } from "./result";
import { collectFormatScope } from "./scope";
import { formatterFor } from "./selection";

interface FormatCheckFile {
  path: string;
  engine: Formatter["engine"];
  status: "passed" | "unformatted" | "error" | "not-run";
  error?: FormatIssue;
}
export interface FormatCheckResult {
  project_id: string;
  relative_path: string | null;
  success: boolean;
  complete: boolean;
  cancelled: boolean;
  files: FormatCheckFile[];
  errors: FormatIssue[];
}
function nativePassed(result: ProcessResult, engine: "ruff" | "go"): boolean {
  if (result.cancelled || result.truncated || result.exit_code === null || result.signal) {
    throw new Error("Native format check did not complete");
  }
  if (engine === "ruff" && result.exit_code === 1) {
    return false;
  }
  // golangci-lint fmt --diff exits 1 after emitting a patch. A bare exit 1
  // (for example, invalid config) is still an incomplete check.
  if (engine === "go" && result.exit_code === 1 && result.stdout.trim() && !result.stderr.trim()) {
    return false;
  }
  if (result.exit_code !== 0) {
    throw new Error(result.stderr || `Native format check exited ${result.exit_code}`);
  }
  return engine !== "go" || result.stdout.trim() === "";
}
async function checkFile(
  file: FormatCheckFile,
  context: LintCheckContext,
  policy: LoadedConfig,
  result: FormatCheckResult,
  signal: AbortSignal,
): Promise<void> {
  const target = context.target;
  const formatter = formatterFor(file.path, target.project.ecosystem);
  if (!formatter) {
    throw new Error(`Unsupported format file: ${file.path}`);
  }
  const before = await readFormatFile(target.root, resolve(target.scope.cwd, file.path));
  let passed: boolean;
  if (formatter.engine === "prettier") {
    passed = await checkPrettier(before.text, formatter.parser, policy.format.prettier);
  } else {
    const native = await (formatter.engine === "ruff" ? checkPythonFormat : checkGoFormat)(context, [file.path]);
    result.cancelled ||= native.cancelled;
    passed = nativePassed(native, formatter.engine);
  }
  signal.throwIfAborted();
  file.status = passed ? "passed" : "unformatted";
}
/** Uses prepared tools and the full formatter scope without installs or file publication. */
export async function checkProjectFormat(
  root: string,
  projectId: string,
  signal = new AbortController().signal,
): Promise<FormatCheckResult> {
  const result: FormatCheckResult = {
    project_id: projectId,
    relative_path: null,
    success: false,
    complete: false,
    cancelled: false,
    files: [],
    errors: [],
  };
  try {
    await withReadyLintTarget(
      root,
      projectId,
      lintAdapters,
      async (context) => {
        const target = context.target;
        result.relative_path = target.project.path;
        const policy = await loadConfig(target.root, { signal, flush: false });
        const scope = await collectFormatScope(target, policy.format, policy.lint);
        result.files = scope.files.map((path) => {
          const formatter = formatterFor(path, target.project.ecosystem);
          if (!formatter) {
            throw new Error(`Unsupported format file: ${path}`);
          }
          return { path, engine: formatter.engine, status: "not-run" };
        });
        for (const file of result.files) {
          signal.throwIfAborted();
          try {
            await checkFile(file, context, policy, result, signal);
          } catch (error) {
            file.status = "error";
            file.error = {
              ...formatIssue(error, "format-check-failed"),
              path: file.path,
            };
            result.errors.push(file.error);
            break;
          }
        }
      },
      signal,
    );
  } catch (error) {
    result.errors.push(formatIssue(error, "format-check-failed"));
  }
  result.cancelled ||= signal.aborted;
  result.complete =
    !result.cancelled &&
    !result.errors.length &&
    result.files.every((file) => file.status === "passed" || file.status === "unformatted");
  result.success = result.complete && result.files.every((file) => file.status === "passed");
  return result;
}
