import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitContext, gitText } from "../../../src/precommit/git";
import { EffectLedger } from "../../../src/precommit/staging";

test("effect ledger detects drift and excludes ignored untracked outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-stage-"));
  try {
    await gitText(root, ["init", "-q"]);
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "ignored.txt"), "generated\n");
    await writeFile(join(root, "changed.txt"), "changed\n");
    const context = await gitContext(root);
    if (!context) throw new Error("No Git context");
    const ledger = new EffectLedger(context);
    await expect(ledger.observe(["../outside.txt"])).rejects.toThrow(
      "Invalid effect path",
    );
    await symlink(tmpdir(), join(root, "outside"));
    await expect(ledger.observe(["outside/escaped.txt"])).rejects.toThrow();
    expect(ledger.paths).toEqual([]);
    await ledger.observe(["changed.txt", "ignored.txt"]);
    await writeFile(join(root, "changed.txt"), "concurrent\n");
    await expect(ledger.stage()).rejects.toThrow("Concurrent file change");
    expect(await gitText(root, ["ls-files"])).toBe("");
    await ledger.observe(["changed.txt"]);
    expect(await ledger.stage()).toEqual(["changed.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git commit --only uses its temporary index in a linked worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-only-"));
  const worktree = `${root}-linked`;
  try {
    await gitText(root, ["init", "-q"]);
    await gitText(root, ["config", "user.name", "Test"]);
    await gitText(root, ["config", "user.email", "test@example.invalid"]);
    for (const path of ["a.txt", "b.txt"])
      await writeFile(join(root, path), "initial\n");
    await gitText(root, ["add", "--", "a.txt", "b.txt"]);
    await gitText(root, ["commit", "-qm", "test: initial"]);
    await gitText(root, ["worktree", "add", "-qb", "feature", worktree]);
    const module = fileURLToPath(
      new URL("../../../src/precommit/staging.ts", import.meta.url),
    );
    const gitModule = fileURLToPath(
      new URL("../../../src/precommit/git.ts", import.meta.url),
    );
    const script = join(root, "hook.ts");
    await writeFile(
      script,
      `import {EffectLedger} from ${JSON.stringify(module)};\nimport {gitContext} from ${JSON.stringify(gitModule)};\nawait Bun.write('a.txt','formatted\\n');\nconst ledger=new EffectLedger(await gitContext(process.cwd()));\nawait ledger.observe(['a.txt']);\nawait ledger.stage();\n`,
    );
    const hook = join(root, ".git/hooks/pre-commit");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(
      hook,
      `#!/bin/sh\nexec ${quote(process.execPath)} --no-install ${quote(script)}\n`,
    );
    await chmod(hook, 0o755);
    await writeFile(join(worktree, "a.txt"), "unformatted\n");
    await writeFile(join(worktree, "b.txt"), "keep staged\n");
    await gitText(worktree, ["add", "--", "b.txt"]);
    await mkdir(join(worktree, "nested"));
    const context = await gitContext(join(worktree, "nested"));
    expect(context?.gitDirectory).toContain("worktrees");
    await gitText(worktree, [
      "commit",
      "--only",
      "-m",
      "test: selected",
      "--",
      "a.txt",
    ]);
    expect(await gitText(worktree, ["show", "HEAD:a.txt"])).toBe("formatted\n");
    expect(await gitText(worktree, ["show", "HEAD:b.txt"])).toBe("initial\n");
    expect(await gitText(worktree, ["show", ":b.txt"])).toBe("keep staged\n");
    expect(await readFile(join(worktree, "a.txt"), "utf8")).toBe("formatted\n");
  } finally {
    await rm(worktree, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
