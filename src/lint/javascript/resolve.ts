import type { LintPolicy } from "../../config/lint/model";
import { object } from "../../dependencies/inventory";
import type { ToolVersions } from "../adapters/types";
import type { LintTarget } from "../targets";
import { fetchVersionJSON, stableVersion } from "../versions";
import { BIOME_PACKAGE, nativeJavascriptTools } from "./tools";

/** New membership selects latest once; a persisted complete selection survives retries. */
export async function resolveJavascript(
  targets: LintTarget[],
  _policy: LintPolicy,
  signal: AbortSignal,
  existing: Record<string, ToolVersions> = {},
): Promise<Record<string, ToolVersions>> {
  const retained = Object.fromEntries(
    targets.map((target) => [
      target.project.project_id,
      Object.fromEntries(
        Object.entries(
          nativeJavascriptTools(existing[target.project.project_id] ?? {}),
        ).map(([name, version]) => [name, stableVersion(version)]),
      ),
    ]),
  );
  if (
    targets.every(
      (target) => retained[target.project.project_id]?.[BIOME_PACKAGE],
    )
  )
    return retained;
  const metadata = await fetchVersionJSON(
    `https://registry.npmjs.org/-/package/${encodeURIComponent(BIOME_PACKAGE)}/dist-tags`,
    signal,
  );
  const version = stableVersion(object(metadata).latest);
  return Object.fromEntries(
    targets.map((target) => [
      target.project.project_id,
      { [BIOME_PACKAGE]: version },
    ]),
  );
}
