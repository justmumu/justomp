import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
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
      join(project, ".npmrc"),
      `cache=${join(project, ".npm-cache")}\naudit=false\nfund=false\n`,
    );
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
      '{"name":"installed-project","private":true,"packageManager":"npm@11.12.1"}',
    );
    await mkdir(join(project, "local"));
    await writeFile(
      join(project, "local/package.json"),
      '{"name":"installed-local","version":"1.0.0"}',
    );
    expect(
      await Bun.file(
        join(installation, "node_modules/justomp/docs/dependencies.md"),
      ).exists(),
    ).toBe(true);
    const api = await import(
      join(installation, "node_modules/justomp/src/dependencies/index.ts")
    );
    expect(Object.keys(api.adapters).sort()).toEqual([
      "bun",
      "go",
      "npm",
      "pnpm",
      "uv",
      "yarn-classic",
      "yarn-modern",
    ]);
    const host = await createHost(project, entry);
    try {
      await host.runner.emit({ type: "session_start" });
      const result = await host.tool.execute("installed", {});
      expect(result.isError).not.toBe(true);
      expect(
        result.details.structure.projects.map((p: { name: string }) => p.name),
      ).toContain("installed-project");
      expect(result.details.cacheHit).toBe(true);
      for (const name of [
        "list_projects",
        "dependency_list",
        "dependency_add",
        "dependency_remove",
        "dependency_update",
        "dependency_sync",
      ])
        expect(host.runner.getRegisteredTool(name)).toBeDefined();
      const added = await host
        .getTool("dependency_add")
        .execute("installed-add", {
          project_id: "javascript:package.json",
          group: { kind: "runtime" },
          packages: [
            {
              name: "installed-local",
              source: { kind: "path", path: "local" },
            },
          ],
        });
      expect(added.isError, JSON.stringify(added.content)).not.toBe(true);
      expect(
        JSON.parse(await readFile(join(project, "package.json"), "utf8"))
          .dependencies["installed-local"],
      ).toBe("file:local");
    } finally {
      await host.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 120_000);
