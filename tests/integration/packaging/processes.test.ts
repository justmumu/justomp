import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("two processes publish complete independent snapshots without consuming disk cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-process-"));
  const entry = new URL("../../../src/packaging/get-structure.ts", import.meta.url).href;
  const code = `import {getPackagingStructure,closePackagingStructure} from ${JSON.stringify(entry)};const root=process.env.JUSTOMP_FIXTURE_ROOT;const ids=[];try{for(let i=0;i<5;i++){const r=await getPackagingStructure(root,{refresh:true});ids.push(r.structure.scanId);}console.log(JSON.stringify(ids));}finally{await closePackagingStructure(root);}`;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    await writeFile(join(root, "package.json"), '{"name":"shared"}');
    const jobs = Array.from({ length: 2 }, async () => {
      const child = Bun.spawn([process.execPath, "-e", code], {
        env: { ...process.env, JUSTOMP_FIXTURE_ROOT: root },
        stdout: "pipe",
        stderr: "pipe",
      });
      children.push(child);
      const [status, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (status !== 0) {
        throw new Error(error);
      }
      return JSON.parse(output) as string[];
    });
    const ids = (await Promise.all(jobs)).flat();
    expect(new Set(ids).size).toBe(10);
    const final = JSON.parse(await readFile(join(root, ".justomp/packaging_structure.json"), "utf8"));
    expect(ids).toContain(final.scanId);
    expect(final.complete).toBe(true);
    expect(final.projects[0].name).toBe("shared");
  } finally {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill();
      }
    }
    await Promise.all(children.map((child) => child.exited));
    await rm(root, { recursive: true, force: true });
  }
});
