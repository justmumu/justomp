import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { object } from "../../dependencies/inventory";
import { safePath } from "../../dependencies/paths";
import { LintError, type PreparationChange } from "../model";
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
async function download(url: string, signal: AbortSignal, limit: number): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  });
  if (!response.ok || !response.body) {
    throw new LintError("download-failed", `Official Go lint artifact returned HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      size += value.length;
      if (size > limit) {
        throw new LintError("download-failed", "Go lint artifact exceeds its download limit");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
  }
}
async function fingerprint(root: string, path: string): Promise<string | null> {
  await safePath(root, path);
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) {
        throw new LintError("tool-conflict", "Go lint destination is not a regular file");
      }
      return `${stat.dev}:${stat.ino}:${createHash("sha256")
        .update(await file.readFile())
        .digest("hex")}`;
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
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
  const artifact = golangciArtifact(version),
    path = golangciPath(root, version);
  const before = await fingerprint(root, path);
  const checksums = (
    await download(`${artifact.base}/golangci-lint-${version}-checksums.txt`, signal, 1024 * 1024)
  ).toString("utf8");
  const matches = checksums
    .split(/\r?\n/)
    .map((line) => /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line))
    .filter((match) => match?.[2] === artifact.archive);
  if (matches.length !== 1) {
    throw new LintError(
      "checksum-missing",
      "Official checksum list must contain exactly one matching Go lint artifact",
    );
  }
  const bytes = await download(`${artifact.base}/${artifact.archive}`, signal, 256 * 1024 * 1024);
  if (createHash("sha256").update(bytes).digest("hex") !== matches[0]?.[1]?.toLowerCase()) {
    throw new LintError("checksum-mismatch", "Go lint archive SHA-256 does not match the official checksum");
  }
  const entries = await new Bun.Archive(bytes).files();
  const binary = entries.get(artifact.entry);
  if (!binary?.size || binary.size > 256 * 1024 * 1024) {
    throw new LintError("invalid-archive", "Official archive does not contain the expected Go lint binary");
  }
  signal.throwIfAborted();
  await mkdir(await safePath(root, dirname(path)), { recursive: true });
  const temporary = join(dirname(path), `.download-${randomUUID()}`);
  try {
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o755,
    );
    try {
      await file.writeFile(Buffer.from(await binary.arrayBuffer()));
      await file.sync();
    } finally {
      await file.close();
    }
    await validate(temporary);
    signal.throwIfAborted();
    if ((await fingerprint(root, path)) !== before) {
      throw new LintError("tool-conflict", "Go lint binary changed during preparation");
    }
    if (before === null) {
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new LintError("tool-conflict", "Go lint binary appeared during preparation");
        }
        throw error;
      }
    } else {
      await rename(temporary, path);
    }
    changes.push({
      project_id: projectId,
      path: relative(root, path).replaceAll("\\", "/"),
      kind: before === null ? "created" : "updated",
    });
  } finally {
    await unlink(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    });
  }
}
export async function localGolangci(root: string, version: string): Promise<string> {
  const path = await safePath(root, golangciPath(root, version));
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111)) {
    throw new LintError("not-ready", "Local Go lint binary is not an executable regular file");
  }
  return path;
}
