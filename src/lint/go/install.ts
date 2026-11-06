import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { object } from "../../dependencies/inventory";
import { safePath } from "../../dependencies/paths";
import { LintError, type PreparationChange } from "../model";
import { installNativeTool } from "../tool-install";
import { fetchVersionJSON, stableVersion } from "../versions";

const RELEASES = "https://github.com/golangci/golangci-lint/releases/download";
export function golangciArtifact(version: string) {
  stableVersion(version);
  if (!version.startsWith("2.")) {
    throw new LintError("unsupported-tool-version", "Go lint requires golangci-lint v2");
  }
  if (!["darwin", "linux"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) {
    throw new LintError(
      "unsupported-platform",
      `Go lint binary installation is not supported on ${process.platform}/${process.arch}`,
    );
  }
  const platform = `${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`;
  const stem = `golangci-lint-${version}-${platform}`;
  return {
    platform,
    archive: `${stem}.tar.gz`,
    entry: `${stem}/golangci-lint`,
    base: `${RELEASES}/v${version}`,
  };
}
export function golangciPath(root: string, version: string): string {
  return join(root, ".justomp/tools/golangci-lint", version, golangciArtifact(version).platform, "golangci-lint");
}
export async function latestGolangci(signal: AbortSignal): Promise<string> {
  const release = object(
    await fetchVersionJSON("https://api.github.com/repos/golangci/golangci-lint/releases/latest", signal),
  );
  if (release.draft || release.prerelease || typeof release.tag_name !== "string") {
    throw new LintError("version-resolution-failed", "Official Go lint release is not stable");
  }
  const version = stableVersion(release.tag_name.replace(/^v/, ""));
  golangciArtifact(version);
  return version;
}
/** Only a fixed regular-file destination is published; archive paths are never extracted to disk. */
export async function installGolangci(
  root: string,
  version: string,
  projectId: string,
  signal: AbortSignal,
  changes: PreparationChange[],
  validate: (path: string) => Promise<void>,
): Promise<void> {
  await installNativeTool(
    root,
    golangciPath(root, version),
    { ...golangciArtifact(version), checksums: `golangci-lint-${version}-checksums.txt` },
    projectId,
    signal,
    changes,
    validate,
  );
}
export async function localGolangci(root: string, version: string): Promise<string> {
  const path = await safePath(root, golangciPath(root, version));
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111)) {
    throw new LintError("not-ready", "Local Go lint binary is not an executable regular file");
  }
  return path;
}
