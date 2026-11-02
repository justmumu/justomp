import { object } from "../dependencies/inventory";
import { TestError } from "./model";

export { fetchVersionJSON } from "../typecheck/versions";

import { fetchVersionJSON } from "../typecheck/versions";
export function stableVersion(value: unknown): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new TestError("invalid-version", "Expected exact stable runner version");
  }
  return value;
}
export async function latestNpm(name: string, signal: AbortSignal): Promise<string> {
  return stableVersion(
    object(await fetchVersionJSON(`https://registry.npmjs.org/-/package/${encodeURIComponent(name)}/dist-tags`, signal))
      .latest,
  );
}
export async function latestPython(name: string, signal: AbortSignal): Promise<string> {
  const releases = object(object(await fetchVersionJSON(`https://pypi.org/pypi/${name}/json`, signal)).releases);
  const versions = Object.entries(releases)
    .filter(
      ([v, files]) =>
        /^\d+\.\d+\.\d+$/.test(v) && Array.isArray(files) && files.some((f) => object(f).yanked === false),
    )
    .map(([v]) => v)
    .sort((a, b) => Bun.semver.order(b, a));
  return stableVersion(versions[0]);
}
