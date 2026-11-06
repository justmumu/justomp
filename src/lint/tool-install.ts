import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { safePath } from "../dependencies/paths";
import { LintError, type PreparationChange } from "./model";

export interface NativeArtifact {
  archive: string;
  entry: string;
  base: string;
  checksums: string;
}

async function download(url: string, signal: AbortSignal, limit: number): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
  if (!response.ok || !response.body) {
    throw new LintError("download-failed", `Official lint artifact returned HTTP ${response.status}`);
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
        throw new LintError("download-failed", "Lint artifact exceeds its download limit");
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
        throw new LintError("tool-conflict", "Lint destination is not a regular file");
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
function checksum(text: string, filename: string): string {
  const matches = text.split(/\r?\n/).flatMap((line) => {
    const match = /^([a-fA-F0-9]{64})(?:\s+\*?(.+))?$/.exec(line.trim());
    return match && (!match[2] || match[2] === filename) ? [match[1]?.toLowerCase() ?? ""] : [];
  });
  if (matches.length !== 1 || !matches[0]) {
    throw new LintError("checksum-missing", "Official checksum must identify exactly one matching lint artifact");
  }
  return matches[0];
}
async function publish(temporary: string, path: string, create: boolean): Promise<void> {
  if (!create) {
    await rename(temporary, path);
    return;
  }
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LintError("tool-conflict", "Lint binary appeared during preparation");
    }
    throw error;
  }
}

/** Read only the selected archive member; archive paths never become filesystem paths. */
export async function installNativeTool(
  root: string,
  path: string,
  artifact: NativeArtifact,
  projectId: string,
  signal: AbortSignal,
  changes: PreparationChange[],
  validate: (path: string) => Promise<void>,
): Promise<void> {
  const before = await fingerprint(root, path);
  const expected = checksum(
    (await download(`${artifact.base}/${artifact.checksums}`, signal, 1024 * 1024)).toString("utf8"),
    artifact.archive,
  );
  const bytes = await download(`${artifact.base}/${artifact.archive}`, signal, 256 * 1024 * 1024);
  if (createHash("sha256").update(bytes).digest("hex") !== expected) {
    throw new LintError("checksum-mismatch", "Lint archive SHA-256 does not match the official checksum");
  }
  const binary = (await new Bun.Archive(bytes).files()).get(artifact.entry);
  if (!binary?.size || binary.size > 256 * 1024 * 1024) {
    throw new LintError("invalid-archive", "Official archive does not contain the expected lint binary");
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
      throw new LintError("tool-conflict", "Lint binary changed during preparation");
    }
    await publish(temporary, path, before === null);
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
