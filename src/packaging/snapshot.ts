import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { assertNotSymlink } from "../config/load";
import { type PackagingStructure } from "../inspect/model";
export async function publishSnapshot(structure: PackagingStructure, signal: AbortSignal): Promise<number> {
  const started = performance.now();
  signal.throwIfAborted();
  const directory = join(structure.root, ".justomp");
  const destination = join(directory, "packaging_structure.json");
  await assertNotSymlink(directory);
  await mkdir(directory, { recursive: true });
  await assertNotSymlink(directory);
  await assertNotSymlink(destination);
  const temporary = join(directory, `.snapshot-${randomUUID()}.tmp`);
  try {
    signal.throwIfAborted();
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(structure, null, 2)}\n`, {
        signal,
      });
      await file.sync();
    } finally {
      await file.close();
    }
    await assertNotSymlink(directory);
    await assertNotSymlink(destination);
    signal.throwIfAborted();
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }
  return performance.now() - started;
}
