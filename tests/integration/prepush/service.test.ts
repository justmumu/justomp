import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../../../src/dependencies/runner";
import { gitText } from "../../../src/precommit/git";
import { type PushOperations } from "../../../src/prepush/operations";
import { runPrepush } from "../../../src/prepush/service";

test("nested and linked worktree invocations select all projects without Git staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-push-service-"));
  try {
    const repo = join(root, "repo"),
      worktree = join(root, "worktree");
    await mkdir(join(repo, "apps/api"), { recursive: true });
    await mkdir(join(repo, "apps/web"), { recursive: true });
    await writeFile(
      join(repo, "apps/api/pyproject.toml"),
      '[project]\nname="api"\nversion="0.1.0"\n[tool.uv]\npackage=false\n',
    );
    await writeFile(join(repo, "apps/web/package.json"), '{"name":"web","packageManager":"npm@11.12.1"}');
    await gitText(repo, ["init", "-q"]);
    await gitText(repo, ["config", "user.name", "Test"]);
    await gitText(repo, ["config", "user.email", "test@example.invalid"]);
    await gitText(repo, ["add", "--", "apps"]);
    await gitText(repo, ["commit", "-m", "test: projects"]);
    await gitText(repo, ["worktree", "add", "-q", "-b", "linked", worktree]);
    const roots: string[] = [];
    const operations: PushOperations = {
      prepare: async (cwd) => {
        roots.push(cwd);
        return {
          stage: "preparation",
          success: true,
          complete: true,
          effects: [],
          details: {},
        };
      },
      run: async (stage, cwd, id) => {
        roots.push(cwd);
        return {
          stage,
          project_id: id,
          success: true,
          complete: true,
          effects: [],
          details: {},
        };
      },
    };
    for (const base of [repo, worktree]) {
      await writeFile(join(base, "untracked.txt"), "working tree\n");
      const before = await gitText(base, ["ls-files", "--stage", "-z"]);
      const result = await runPrepush(join(base, "apps/api"), undefined, operations);
      expect(result.success).toBe(true);
      expect(result.selected_projects).toHaveLength(2);
      expect(result.stages.filter((s) => s.stage === "unit")).toHaveLength(2);
      expect(await gitText(base, ["ls-files", "--stage", "-z"])).toBe(before);
      expect(await readFile(join(base, "untracked.txt"), "utf8")).toBe("working tree\n");
    }
    expect(new Set(roots).size).toBe(2);
    const cli = fileURLToPath(new URL("../../../src/prepush/cli.ts", import.meta.url));
    const invalid = await runProcess(process.execPath, ["--no-install", cli], {
      cwd: root,
    });
    expect(invalid.exit_code).toBe(2);
    expect(JSON.parse(invalid.stdout).errors).toContain("Pre-push requires a Git working tree");
    const argument = await runProcess(process.execPath, ["--no-install", cli, "unexpected"], { cwd: repo });
    expect(argument.exit_code).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
