import { lstat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { within } from "../dependencies/paths";
import {
  type FileSnapshot,
  publishProjectionFile,
  readProjectionFile,
} from "../lint/files";
import { FormatError } from "./model";

/** Reject every symlink component, including aliases that resolve inside the project. */
async function assertPath(root: string, path: string): Promise<void> {
  if (!within(root, path))
    throw new FormatError("unsafe-path", "Format path is outside the project");
  let current = root;
  for (const part of ["", ...relative(root, path).split(sep)]) {
    current = resolve(current, part);
    const stat = await lstat(current);
    if (
      stat.isSymbolicLink() ||
      (current === path ? !stat.isFile() : !stat.isDirectory())
    )
      throw new FormatError(
        "unsafe-path",
        `Refusing unsafe format path: ${path}`,
      );
  }
}
export async function readFormatFile(
  root: string,
  path: string,
): Promise<FileSnapshot & { text: string }> {
  await assertPath(root, path);
  const before = await readProjectionFile(root, path);
  if (before.text === null)
    throw new FormatError("file-missing", `Format file disappeared: ${path}`);
  return { ...before, text: before.text };
}
export async function publishFormatFile(
  root: string,
  path: string,
  before: FileSnapshot,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  await publishProjectionFile(root, path, before, content, async () => {
    await assertPath(root, path);
    signal?.throwIfAborted();
  });
}
