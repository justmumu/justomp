import { assertSourcePath, type FileSnapshot, publishProjectionFile, readSourceFile } from "../lint/files";
import { LintError } from "../lint/model";
import { FormatError } from "./model";

async function formatFileOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof LintError) {
      throw new FormatError(error.code, error.message);
    }
    throw error;
  }
}
export async function readFormatFile(root: string, path: string): Promise<FileSnapshot & { text: string }> {
  return await formatFileOperation(() => readSourceFile(root, path));
}
export async function publishFormatFile(
  root: string,
  path: string,
  before: FileSnapshot,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  await publishProjectionFile(root, path, before, content, async () => {
    await formatFileOperation(() => assertSourcePath(root, path));
    signal?.throwIfAborted();
  });
}
