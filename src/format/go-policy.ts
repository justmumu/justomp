import type { GoPolicy } from "../config/lint/model";
import { FormatError } from "./model";

/** Native RE2 path filters and lax generated detection cannot be approximated as JS globs. */
export function assertGoFormatPolicy(policy: GoPolicy): void {
  const exclusions = policy.golangci.formatters.exclusions;
  if (
    exclusions.paths !== undefined &&
    (!Array.isArray(exclusions.paths) || exclusions.paths.length > 0)
  )
    throw new FormatError(
      "unsupported-config",
      "project_format does not support Go formatters.exclusions.paths; use format.exclude for file selection",
    );
  if (!["strict", "disable"].includes(exclusions.generated))
    throw new FormatError(
      "unsupported-config",
      "project_format supports Go generated exclusions in strict or disable mode only",
    );
}

/** Known generated outputs are never format targets, even when native checks allow them. */
export function isGeneratedGo(text: string): boolean {
  return /^\uFEFF?[ \t]*\/\/ Code generated .* DO NOT EDIT\.\r?$/m.test(text);
}
