import { spyOn } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { closePackagingStructure } from "../../../src/packaging/get-structure";
import { pythonFixture, VERSION } from "../../fixtures/lint/python/fixture";
import { suppliedResponse } from "../../response";
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
export function registry() {
  const original = globalThis.fetch;
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (input: Parameters<typeof fetch>[0]) => {
        return suppliedResponse(() => {
          if (String(input) !== "https://pypi.org/pypi/ruff/json") {
            throw new Error(`Unexpected registry request: ${input}`);
          }
          return Response.json({ releases: { [VERSION]: [{ yanked: false }] } });
        });
      },
      { preconnect: original.preconnect },
    ),
  );
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
