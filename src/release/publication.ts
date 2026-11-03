import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type FileSnapshot, publishProjectionFile } from "../lint/files";
import { assertReleasePath } from "./repository";
export async function publishReleaseFile(
  root: string,
  path: string,
  before: FileSnapshot,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await assertReleasePath(root, path);
  if (before.text === content) {
    return;
  }
  await mkdir(dirname(join(root, path)), { recursive: true });
  await publishProjectionFile(root, join(root, path), before, content, async () => {
    signal?.throwIfAborted();
    await assertReleasePath(root, path);
  });
}
