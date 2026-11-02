import { type AdapterContext, type ProcessResult, redact } from "../../dependencies/model";
import { localTool, succeeded } from "../../lint/javascript/native";
import { lintManagerContext } from "../../lint/runtime";
import { TypecheckError } from "../model";
import { type TypecheckTarget } from "../targets";
/** Shared dependency/lint helpers retain their error details under this feature's identity. */
export async function typecheckNative<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof TypecheckError) {
      throw error;
    }
    throw new TypecheckError(
      typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code
        : "native-preparation-failed",
      redact(error instanceof Error ? error.message : String(error)),
    );
  }
}
export function assertTypecheckNative(result: ProcessResult, label: string): void {
  if (!succeeded(result)) {
    throw new TypecheckError(
      result.cancelled ? "cancelled" : "native-preparation-failed",
      redact(
        `${label}: ${result.stderr || result.stdout || `exit ${result.exit_code}`}${result.truncated ? " (output truncated)" : ""}`,
      ),
    );
  }
}
export async function typescriptRun(
  target: TypecheckTarget,
  args: string[],
  signal: AbortSignal,
  native?: AdapterContext,
) {
  return typecheckNative(async () =>
    localTool(
      target,
      native ?? (await lintManagerContext(target, signal)),
      { package: "typescript", binary: "tsc" },
      args,
      signal,
    ),
  );
}
