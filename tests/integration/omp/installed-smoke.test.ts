import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost } from "./host";

async function command(cwd: string, args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0)
    throw new Error(`${args.join(" ")} exited ${code}\n${out}\n${error}`);
  return out;
}
test("packed extension installs and loads outside the source checkout", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "justomp-installed-"));
  try {
    const checkout = new URL("../../../", import.meta.url).pathname;
    const archive = join(temporary, "justomp.tgz");
    await command(checkout, [
      "pm",
      "pack",
      "--filename",
      archive,
      "--ignore-scripts",
      "--quiet",
    ]);
    const installation = join(temporary, "installation"),
      project = join(temporary, "project");
    await mkdir(installation);
    await mkdir(project);
    await writeFile(
      join(installation, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: { justomp: `file:${archive}` },
      }),
    );
    await command(installation, ["install", "--ignore-scripts"]);
    const entry = join(installation, "node_modules/justomp/src/index.ts");
    expect(await realpath(entry)).toStartWith(await realpath(installation));
    await writeFile(
      join(project, "package.json"),
      '{"name":"installed-project"}',
    );
    const host = await createHost(project, entry);
    try {
      await host.runner.emit({ type: "session_start" });
      const result = await host.tool.execute("installed", {});
      expect(result.isError).not.toBe(true);
      expect(result.details.structure.projects[0]?.name).toBe(
        "installed-project",
      );
      expect(result.details.cacheHit).toBe(true);
    } finally {
      await host.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 120_000);
