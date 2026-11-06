import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { closePackagingStructure } from "../../../src/packaging/get-structure";
import { pythonFixture } from "../../fixtures/lint/python/fixture";
export const cleanups: (() => Promise<void>)[] = [];
export async function fixture() {
  const f = await pythonFixture();
  cleanups.push(async () => {
    await closePackagingStructure(f.root);
    await f.dispose();
  });
  await writeFile(join(f.root, "module.py"), '"""Example module."""\n');
  return f;
}
export async function cli(root: string, id: string) {
  const process = Bun.spawn(
    [
      Bun.which("bun") ?? "bun",
      new URL("../../../src/lint/cli.ts", import.meta.url).pathname,
      "--root",
      root,
      "--project-id",
      id,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exit, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exit, result: JSON.parse(stdout), stderr };
}
