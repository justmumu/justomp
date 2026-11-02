import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const roots: string[] = [];
export async function fixture(path = ".") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "justomp-outcomes-")));
  roots.push(root);
  await mkdir(join(root, path), { recursive: true });
  await writeFile(
    join(root, path, "package.json"),
    JSON.stringify({
      name: "fixture",
      packageManager: "npm@11.12.1",
      version: "1.0.0",
    }),
  );
  return root;
}
