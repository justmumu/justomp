import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { object } from "../../dependencies/inventory";
import type { AdapterContext } from "../../dependencies/model";
import type { ToolVersions } from "../adapters/types";
import { LintError } from "../model";
import type { LintTarget } from "../targets";
import { fetchVersionJSON, stableVersion } from "../versions";
import {
  assertNative,
  installedPackages,
  nativeAdapter,
  nodeRun,
} from "./native";

export type Metadata = Record<string, unknown>;
export function satisfies(version: string, range: unknown): boolean {
  return typeof range === "string" && Bun.semver.satisfies(version, range);
}
export function compatible(
  metadata: Metadata,
  selected: ToolVersions,
  node: string,
): boolean {
  if (
    metadata.name === "eslint" &&
    Number(String(metadata.version).split(".")[0]) < 9
  )
    return false;
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
/** Existing environment/lock owns the application's actual version. Fresh ranges use registry resolution. */
export async function applicationVersions(
  target: LintTarget,
  native: AdapterContext,
  signal: AbortSignal,
  localOnly = false,
): Promise<ToolVersions> {
  const manifest = object(
    JSON.parse(await readFile(join(target.scope.cwd, "package.json"), "utf8")),
  );
  const declarations = {
    ...object(manifest.dependencies),
    ...object(manifest.devDependencies),
  };
  const installed = await installedPackages(
    target,
    native,
    ["typescript", "next"],
    signal,
  );
  const inventory = await nativeAdapter(native).inventory(native, false);
  const versions: ToolVersions = {};
  for (const name of ["typescript", "next"]) {
    const spec = declarations[name];
    if (typeof spec !== "string") continue;
    const actual = installed[name]?.version;
    const locked = inventory.dependencies.find((item) => item.name === name)
      ?.resolutions?.[0]?.version;
    const candidate = typeof actual === "string" ? actual : locked;
    if (candidate) {
      if (!satisfies(candidate, spec))
        throw new LintError(
          "incompatible-toolchain",
          `${name}@${candidate} does not satisfy declared ${spec}; reconcile the application environment explicitly`,
        );
      versions[name] = stableVersion(candidate);
    } else if (localOnly)
      throw new LintError(
        "unprepared",
        `No installed or locked application version for ${name}`,
      );
    else if (/^\d+\.\d+\.\d+$/.test(spec)) versions[name] = spec;
    else {
      const selected = (await registryPackage(name, signal)).find(
        (value) =>
          typeof value.version === "string" && satisfies(value.version, spec),
      );
      if (!selected)
        throw new LintError(
          "incompatible-toolchain",
          `Cannot resolve declared ${name}@${spec}`,
        );
      versions[name] = stableVersion(selected.version);
    }
  }
  return versions;
}
export function validateCompatibility(
  metadata: Record<string, Metadata>,
  tools: ToolVersions,
  application: ToolVersions,
  node: string,
): void {
  const selected = { ...tools, ...application };
  for (const [name, data] of Object.entries(metadata)) {
    if (!compatible(data, selected, node))
      throw new LintError(
        "incompatible-toolchain",
        `${name}@${tools[name]} is incompatible with Node ${node} or selected peers ${JSON.stringify(selected)} (engines ${JSON.stringify(data.engines)}, peers ${JSON.stringify(data.peerDependencies)}); keep typed rules enabled and reconcile the application/tool versions explicitly`,
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
  if (tools.eslint?.split(".")[0] !== tools["@eslint/js"]?.split(".")[0])
    throw new LintError(
      "incompatible-toolchain",
      "ESLint and @eslint/js must use the same major family",
    );
  if (
    tools["@next/eslint-plugin-next"] &&
    tools["@next/eslint-plugin-next"]?.split(".")[0] !==
      application.next?.split(".")[0]
  )
    throw new LintError(
      "incompatible-toolchain",
      "Next lint plugin must match the application's actual Next major",
    );
}
