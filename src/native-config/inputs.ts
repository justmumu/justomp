import { type FileSnapshot, readProjectionFile } from "../lint/files";

/** A successful check must still describe the inherited configuration it started with. */
export async function nativeInputsCurrent(
  root: string,
  inputs: readonly { path: string; before: FileSnapshot }[] = [],
): Promise<boolean> {
  for (const input of inputs) {
    const current = await readProjectionFile(root, input.path);
    if (current.text !== input.before.text || current.identity !== input.before.identity) {
      return false;
    }
  }
  return true;
}
