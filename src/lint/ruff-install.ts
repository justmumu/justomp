import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { safePath } from "../dependencies/paths";
import { LintError, type PreparationChange } from "./model";
import { installNativeTool } from "./tool-install";
import { RUFF_VERSION } from "./toolchain";

export function ruffArtifact() {
  if (!["darwin", "linux"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) {
    throw new LintError(
      "unsupported-platform",
      `Ruff installation is not supported on ${process.platform}/${process.arch}`,
    );
  }
  const architecture = process.arch === "x64" ? "x86_64" : "aarch64";
  const platform = `${process.platform}-${process.arch}`;
  const target = `${architecture}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-gnu"}`;
  const stem = `ruff-${target}`;
  const archive = `${stem}.tar.gz`;
  return {
    platform,
    archive,
    entry: `${stem}/ruff`,
    base: `https://releases.astral.sh/github/ruff/releases/download/${RUFF_VERSION}`,
    checksums: `${archive}.sha256`,
  };
}
export function ruffPath(root: string): string {
  return join(root, ".justomp/tools/ruff", RUFF_VERSION, ruffArtifact().platform, "ruff");
}
export async function localRuff(root: string): Promise<string> {
  const path = await safePath(root, ruffPath(root));
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111)) {
    throw new LintError("not-ready", "Owned Ruff binary is not an executable regular file");
  }
  return path;
}
export async function installRuff(
  root: string,
  projectId: string,
  signal: AbortSignal,
  changes: PreparationChange[],
  validate: (path: string) => Promise<void>,
): Promise<void> {
  await installNativeTool(root, ruffPath(root), ruffArtifact(), projectId, signal, changes, validate);
}
