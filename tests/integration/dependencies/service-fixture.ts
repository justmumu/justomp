import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const roots: string[] = [];
export async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "justomp-service-")),
  );
  roots.push(root);
  await writeFile(
    join(root, "package.json"),
    '{"name":"fixture","packageManager":"npm@11.12.1","private":true}',
  );
  return root;
}
