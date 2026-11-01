import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitText } from "../../../src/precommit/git";
import type { GateOperations } from "../../../src/precommit/operations";
import { runPrecommit } from "../../../src/precommit/service";

test("real index stages whole observed fixes on a completed failure and preserves unrelated work", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-flow-"));
  try {
    await gitText(root, ["init", "-q"]);
    await writeFile(
      join(root, "pyproject.toml"),
      '[project]\nname="sample"\nversion="0.1.0"\n',
    );
    await writeFile(join(root, "uv.lock"), "version = 1\n");
    await writeFile(join(root, "a.py"), "staged = 1\n");
    await gitText(root, ["add", "--", "pyproject.toml", "uv.lock", "a.py"]);
    await writeFile(join(root, "a.py"), "unstaged=2\n");
    await writeFile(join(root, "unrelated.txt"), "leave me\n");
    const operations: GateOperations = {
      prepare: async () => ({
        stage: "preparation",
        success: true,
        complete: true,
        effects: [],
        affected_projects: [],
        details: {},
      }),
      run: async (stage, _root, id) => {
        if (stage === "format")
          await writeFile(join(root, "a.py"), "unstaged = 2\n");
        return {
          stage,
          project_id: id,
          success: stage !== "typecheck",
          complete: true,
          effects: stage === "format" ? ["a.py"] : [],
          affected_projects: [],
          details: {},
        };
      },
    };
    const result = await runPrecommit(root, undefined, operations);
    expect(result.errors).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.success).toBe(false);
    expect(result.staged_files).toEqual(["a.py"]);
    expect(await gitText(root, ["show", ":a.py"])).toBe("unstaged = 2\n");
    expect(await gitText(root, ["ls-files", "--", "unrelated.txt"])).toBe("");
    expect(await readFile(join(root, "unrelated.txt"), "utf8")).toBe(
      "leave me\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
