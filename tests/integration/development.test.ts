import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entrypoints = [
  "src/lint/cli.ts",
  "src/typecheck/cli.ts",
  "src/precommit/cli.ts",
  "src/prepush/cli.ts",
  "scripts/test-cost.ts",
  "scripts/development.ts",
];

test("importing executable modules performs no command work", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-entry-import-"));
  try {
    const urls = entrypoints.map((file) => new URL(`../../${file}`, import.meta.url).href);
    // Invalid launch arguments keep the regression probe from starting real gates.
    const source = `process.argv=[process.execPath,'probe','--invalid-import-probe'];
const errors=[];const before=[process.listenerCount('SIGINT'),process.listenerCount('SIGTERM')];
for(const url of ${JSON.stringify(urls)}){try{await import(url)}catch(error){errors.push(String(error))}}
const result={errors,exit:process.exitCode??0,before,after:[process.listenerCount('SIGINT'),process.listenerCount('SIGTERM')]};
process.exitCode=0;process.stdout.write('IMPORT_RESULT='+JSON.stringify(result)+'\\n');`;
    const child = Bun.spawn([process.execPath, "--eval", source], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    const marker = stdout.split("\n").find((line) => line.startsWith("IMPORT_RESULT="));
    expect(marker).toBeDefined();
    const result = JSON.parse(marker?.slice("IMPORT_RESULT=".length) ?? "{}");
    expect(result.errors).toEqual([]);
    expect(result.exit).toBe(0);
    expect(result.after).toEqual(result.before);
    expect(stdout).toBe(`${marker}\n`);
    expect(stderr).toBe("");
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct CLI execution still validates arguments and returns failure", async () => {
  const cli = new URL("../../src/prepush/cli.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, cli, "--invalid"], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).toBe(2);
  expect(stderr).toContain("takes no arguments");
});
