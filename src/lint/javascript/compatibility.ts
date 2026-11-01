import { object } from "../../dependencies/inventory";
import type { AdapterContext } from "../../dependencies/model";
import type { ToolVersions } from "../adapters/types";
import { LintError } from "../model";
import type { LintTarget } from "../targets";
import { fetchVersionJSON, stableVersion } from "../versions";
import { assertNative, installedPackages, nodeRun } from "./native";

export type Metadata = Record<string, unknown>;
export function satisfies(version: string, range: unknown): boolean {
  return typeof range === "string" && Bun.semver.satisfies(version, range);
}
export function compatible(
  metadata: Metadata,
  selected: ToolVersions,
  node: string,
): boolean {
  const engine = object(metadata.engines).node;
  if (engine && !satisfies(node, engine)) return false;
  for (const [name, range] of Object.entries(object(metadata.peerDependencies)))
    if (selected[name] && !satisfies(selected[name], range)) return false;
  return true;
}
export async function registryPackage(
  name: string,
  signal: AbortSignal,
): Promise<Metadata[]> {
  const data = object(
    await fetchVersionJSON(
      `https://registry.npmjs.org/${encodeURIComponent(name)}`,
      signal,
      "application/vnd.npm.install-v1+json",
    ),
  );
  return Object.entries(object(data.versions))
    .filter(([version]) => /^\d+\.\d+\.\d+$/.test(version))
    .sort(([a], [b]) => Bun.semver.order(b, a))
    .map(([version, value]) => ({ ...object(value), version }));
}
export async function toolMetadata(
  target: LintTarget,
  native: AdapterContext,
  tools: ToolVersions,
  signal: AbortSignal,
): Promise<Record<string, Metadata>> {
  const installed = await installedPackages(
    target,
    native,
    Object.keys(tools),
    signal,
  );
  const result: Record<string, Metadata> = {};
  for (const [name, version] of Object.entries(tools)) {
    stableVersion(version);
    result[name] =
      installed[name]?.version === version
        ? installed[name]
        : object(
            await fetchVersionJSON(
              `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,
              signal,
            ),
          );
    if (result[name]?.version !== version)
      throw new LintError(
        "invalid-version",
        `Registry did not return ${name}@${version}`,
      );
  }
  return result;
}
export async function nodeVersion(
  target: LintTarget,
  native: AdapterContext,
  signal: AbortSignal,
): Promise<string> {
  const result = await nodeRun(
    target,
    native,
    ["-p", "process.versions.node"],
    signal,
  );
  assertNative(result, "Read Node runtime version");
  const version = result.stdout
    .split("\n")
    .find((line) => /^\d+\.\d+\.\d+$/.test(line));
  return stableVersion(version);
}
export function validateCompatibility(
  metadata: Record<string, Metadata>,
  tools: ToolVersions,
  node: string,
): void {
  const selected = tools;
  for (const [name, data] of Object.entries(metadata)) {
    if (!compatible(data, selected, node))
      throw new LintError(
        "incompatible-toolchain",
        `${name}@${tools[name]} is incompatible with Node ${node} or selected peers ${JSON.stringify(selected)} (engines ${JSON.stringify(data.engines)}, peers ${JSON.stringify(data.peerDependencies)}); reconcile the runtime/tool versions explicitly`,
      );
    for (const peer of Object.keys(object(data.peerDependencies))) {
      if (
        !selected[peer] &&
        object(object(data.peerDependenciesMeta)[peer]).optional !== true
      )
        throw new LintError(
          "incompatible-toolchain",
          `${name} requires missing peer ${peer}`,
        );
    }
  }
}
