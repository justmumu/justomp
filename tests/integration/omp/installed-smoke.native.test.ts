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
  if (code !== 0) {
    throw new Error(`${args.join(" ")} exited ${code}\n${out}\n${error}`);
  }
  return out;
}

test("packed extension exposes APIs, resources, OMP tools and CLI launchers outside the checkout", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "justomp-installed-"));
  try {
    const checkout = new URL("../../../", import.meta.url).pathname;
    const archive = join(temporary, "justomp.tgz");
    await command(checkout, ["pm", "pack", "--filename", archive, "--ignore-scripts", "--quiet"]);
    const installation = join(temporary, "installation"),
      project = join(temporary, "project");
    await mkdir(installation);
    await mkdir(project);
    await writeFile(
      join(installation, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: { "@justmumu/justomp": `file:${archive}` },
      }),
    );
    await command(installation, ["install", "--ignore-scripts"]);
    const exported = JSON.parse(
      await command(installation, [
        "-e",
        'import * as api from "@justmumu/justomp/typecheck"; import * as root from "@justmumu/justomp"; console.log(JSON.stringify(Object.keys(api).filter(name => typeof root[name] === "function").sort()));',
      ]),
    );
    expect(exported).toEqual(["checkProjectTypecheck", "prepareProjectTypecheck", "typecheckProject"]);
    const testingExports = JSON.parse(
      await command(installation, [
        "-e",
        'import {testProject} from "@justmumu/justomp/testing"; import {formatProject} from "@justmumu/justomp/format"; import * as root from "@justmumu/justomp"; console.log(JSON.stringify(typeof testProject === "function" && root.testProject === testProject && root.formatProject === formatProject));',
      ]),
    );
    expect(testingExports).toBe(true);
    const releaseExports = JSON.parse(
      await command(installation, [
        "-e",
        'import * as api from "@justmumu/justomp/release"; import * as root from "@justmumu/justomp"; console.log(JSON.stringify(Object.keys(api).filter(name => typeof api[name] === "function" && root[name] === api[name]).sort()));',
      ]),
    );
    expect(releaseExports).toEqual(["bumpRepository", "tagRepository", "updateRepositoryChangelog"]);
    const entry = join(installation, "node_modules/@justmumu/justomp/src/index.ts");
    expect(await realpath(entry)).toStartWith(await realpath(installation));
    for (const path of [
      "docs/dependencies.md",
      "docs/protection.md",
      "src/protection/sandbox.ts",
      "docs/lint.md",
      "docs/lint-migration.md",
      "docs/format.md",
      "docs/precommit.md",
      "docs/prepush.md",
      "docs/release.md",
      "docs/lint-defaults.json",
      "docs/typecheck.md",
      "docs/typecheck-defaults.json",
      "docs/testing.md",
      "docs/test-defaults.json",
      "src/testing/go/inventory.go",
      "src/testing/python/managed_pytest.py",
      "src/testing/javascript/bun-import-all.ts",
      "src/lint/javascript/result.ts",
      "src/config/lint/javascript/migrate.ts",
    ]) {
      expect(await Bun.file(join(installation, "node_modules/@justmumu/justomp", path)).exists()).toBe(true);
    }
    const api = await import(join(installation, "node_modules/@justmumu/justomp/src/dependencies/index.ts"));
    expect(Object.keys(api.adapters).sort()).toEqual(["bun", "go", "npm", "pnpm", "uv", "yarn-classic", "yarn-modern"]);
    const lintApi = await import(join(installation, "node_modules/@justmumu/justomp/src/lint/index.ts"));
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
        "project_format",
        "repo_commit",
        "repo_changelog",
        "repo_bump",
        "repo_release_tag",
        "project_typecheck",
        "project_test",
        "project_integration_test",
        "list_projects",
        "dependency_list",
        "dependency_add",
        "dependency_remove",
        "dependency_update",
        "dependency_sync",
      ]) {
        expect(host.runner.getRegisteredTool(name)).toBeDefined();
      }
      for (const [tool, label] of [
        ["precommit", "Pre-commit"],
        ["prepush", "Pre-push"],
      ]) {
        const child = Bun.spawn([join(installation, "node_modules/.bin", `justomp-${tool}`)], {
          cwd: project,
          stdout: "pipe",
          stderr: "pipe",
        });
        const output = await new Response(child.stdout).text();
        expect(await child.exited).toBe(2);
        expect(JSON.parse(output).errors).toContain(`${label} requires a Git working tree`);
      }
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
      // Shipped plugin/WASM resources and tool wiring, using the existing installation.
      await writeFile(
        join(project, "pyproject.toml"),
        '[project]\nname="packed"\nversion="0.1.0"\n[tool.uv]\npackage=false\n',
      );
      const formatted = await host.getTool("project_format").execute("installed-format", {
        project_id: "python:pyproject.toml",
        files: ["pyproject.toml"],
      });
      expect(formatted.details.success, JSON.stringify(formatted.details)).toBe(true);
      expect(await Bun.file(join(project, "pyproject.toml")).text()).toContain('name = "packed"');
      expect(await Bun.file(join(project, "package.json")).exists()).toBe(false);
      expect(await Bun.file(join(project, "package-lock.json")).exists()).toBe(false);
    } finally {
      await host.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 120_000);
