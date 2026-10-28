import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { safePath } from "./paths";
export type Fingerprints = Map<string, string | null>;
export async function fingerprint(
  root: string,
  paths: string[],
): Promise<Fingerprints> {
  const result: Fingerprints = new Map();
  for (const path of [...new Set(paths)].sort()) {
    const absolute = await safePath(root, path);
    try {
      result.set(
        relative(root, absolute),
        createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex"),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      result.set(relative(root, absolute), null);
    }
  }
  return result;
}
export function changes(before: Fingerprints, after: Fingerprints) {
  return [...after]
    .filter(([path, hash]) => before.get(path) !== hash)
    .map(([path, hash]) => ({
      path,
      change:
        hash === null
          ? "deleted"
          : before.get(path) === null
            ? "created"
            : "modified",
    }));
}
