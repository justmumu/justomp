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

test("packed extension exposes APIs, resources, OMP tools and CLI launchers outside the checkout", async () => {
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
    const exported = JSON.parse(
      await command(installation, [
        "-e",
        'import * as api from "justomp/typecheck"; import * as root from "justomp"; console.log(JSON.stringify(Object.keys(api).filter(name => typeof root[name] === "function").sort()));',
      ]),
    );
    expect(exported).toEqual([
      "checkProjectTypecheck",
      "prepareProjectTypecheck",
      "typecheckProject",
    ]);
    const entry = join(installation, "node_modules/justomp/src/index.ts");
    expect(await realpath(entry)).toStartWith(await realpath(installation));
    for (const path of [
      "docs/dependencies.md",
      "docs/lint.md",
      "docs/lint-defaults.json",
      "docs/typecheck.md",
      "docs/typecheck-defaults.json",
      "src/lint/javascript/formatter.cjs",
    ])
      expect(
        await Bun.file(
          join(installation, "node_modules/justomp", path),
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
    const lintApi = await import(
      join(installation, "node_modules/justomp/src/lint/index.ts")
    );
    expect(typeof lintApi.checkProjectLint).toBe("function");
    expect(typeof lintApi.prepareLintProjects).toBe("function");
    const host = await createHost(project, entry);
    try {
      const result = await host.tool.execute("installed", {});
      expect(result.isError).not.toBe(true);
      expect(result.details.structure.complete).toBe(true);
      expect(result.details.structure.projects).toEqual([]);
      for (const name of [
        "project_lint",
        "project_typecheck",
        "list_projects",
        "dependency_list",
        "dependency_add",
        "dependency_remove",
        "dependency_update",
        "dependency_sync",
      ])
        expect(host.runner.getRegisteredTool(name)).toBeDefined();
      for (const tool of ["lint", "typecheck"]) {
        const child = Bun.spawn(
          [
            join(installation, "node_modules/.bin", `justomp-${tool}`),
            "--root",
            project,
            "--project-id",
            "javascript:missing/package.json",
            ...(tool === "typecheck" ? ["--check-only"] : []),
          ],
          { cwd: project, stdout: "pipe", stderr: "pipe" },
        );
        const [code, out, errors] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code, errors).toBe(2);
        expect(JSON.parse(out).error.code).toBe("project-not-found");
      }
      expect(await Bun.file(join(project, "package-lock.json")).exists()).toBe(
        false,
      );
    } finally {
      await host.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 120_000);
