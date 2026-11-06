import { type LintPolicy } from "../../config/lint/model";
import { type ToolVersions } from "../adapters/types";
import { type LintTarget } from "../targets";
import { BIOME_VERSION } from "../toolchain";
import { BIOME_PACKAGE } from "./tools";

export function resolveJavascript(
  targets: LintTarget[],
  _policy: LintPolicy,
  signal: AbortSignal,
  _existing: Record<string, ToolVersions> = {},
): Promise<Record<string, ToolVersions>> {
  return Promise.resolve().then(() => {
    signal.throwIfAborted();
    return Object.fromEntries(targets.map((target) => [target.project.project_id, { [BIOME_PACKAGE]: BIOME_VERSION }]));
  });
}
