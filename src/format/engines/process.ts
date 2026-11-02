import { type ProcessResult, redact } from "../../dependencies/model";
import { FormatError } from "../model";

/** Keep native results available for accounting; callers must reject incomplete execution. */
export function assertFormatProcess(result: ProcessResult, tool: string): void {
  if (result.exit_code === 0 && !result.cancelled && !result.truncated && !result.signal) {
    return;
  }
  throw new FormatError(
    result.cancelled ? "cancelled" : "format-failed",
    redact(
      `${tool}: ${result.stderr || result.stdout || `exit ${result.exit_code}${result.signal ? ` (${result.signal})` : ""}`}${result.truncated ? " (output truncated)" : ""}`,
    ),
  );
}
