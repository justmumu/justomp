import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitRepository } from "../../../src/commit/service";
import { git, gitText } from "../../../src/precommit/git";

test("repo_commit cancellation terminates the running hook child and reads back unchanged index", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-commit-cancel-"));
  const controller = new AbortController();
  let running: ReturnType<typeof commitRepository> | undefined;
  try {
    await gitText(root, ["init", "-q"]);
    await gitText(root, ["config", "user.name", "Test"]);
    await gitText(root, ["config", "user.email", "test@example.invalid"]);
    await writeFile(join(root, "file.txt"), "staged\n");
    await gitText(root, ["add", "--", "file.txt"]);
    const index = await gitText(root, ["ls-files", "--stage", "-z"]);
    const hook = join(root, ".git/hooks/pre-commit");
    // A real Git hook descendant, with its PID published before cancellation.
    await writeFile(
      hook,
      '#!/bin/sh\nsleep 30 &\nchild=$!\nprintf "%s" "$child" > hook-child\nwait "$child"\n',
    );
    await chmod(hook, 0o755);
    running = commitRepository(
      root,
      "test: cancelled commit",
      controller.signal,
    );
    const marker = join(root, "hook-child");
    const deadline = Date.now() + 10000;
    while (!(await Bun.file(marker).exists())) {
      if (Date.now() > deadline) throw new Error("Commit hook did not start");
      await Bun.sleep(10);
    }
    const pid = Number(await readFile(marker, "utf8"));
    expect(pid).toBeGreaterThan(0);
    controller.abort();
    const result = await running;
    expect(result.cancelled).toBe(true);
    expect(result.success).toBe(false);
    expect(result.committed).toBeNull();
    expect(result.commit_hash).toBeNull();
    expect(
      (await git(root, ["rev-parse", "--verify", "HEAD"])).exit_code,
    ).not.toBe(0);
    expect(await gitText(root, ["ls-files", "--stage", "-z"])).toBe(index);
    expect(result.repository_status).toContain("A  file.txt\0");
    const reaped = Date.now() + 2000;
    for (;;) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      if (Date.now() > reaped)
        throw new Error("Hook child survived cancellation");
      await Bun.sleep(10);
    }
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort();
    await running;
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
