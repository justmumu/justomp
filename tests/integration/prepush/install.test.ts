import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitText } from "../../../src/precommit/git";
import { installPrecommit } from "../../../src/precommit/install";
import { installPrepush } from "../../../src/prepush/install";

test("push composes original argv/stdin once and gate failure preserves remote", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-prepush-"));
  try {
    const repo = join(root, "repo"),
      remote = join(root, "remote.git");
    await mkdir(repo);
    await gitText(root, ["init", "--bare", "-q", remote]);
    await gitText(repo, ["init", "-q", "-b", "main"]);
    await gitText(repo, ["config", "user.name", "Test"]);
    await gitText(repo, ["config", "user.email", "test@example.invalid"]);
    await gitText(repo, ["commit", "--allow-empty", "-m", "test: initial"]);
    await gitText(repo, ["remote", "add", "origin", remote]);
    const hook = join(repo, ".git/hooks/pre-push");
    await writeFile(
      hook,
      '#!/bin/sh\nprintf "%s\\n" "$@" > args\ncat > refs\nprintf original >> order\n[ ! -e reject-original ]\n',
      { mode: 0o755 },
    );
    const cli = join(root, "cli.ts");
    await writeFile(
      cli,
      'import { appendFile } from "node:fs/promises"; await appendFile("order","justomp"); process.exitCode = await Bun.file("reject-gate").exists() ? 1 : 0;',
    );
    const runtime = { cli, bun: process.execPath };
    expect((await installPrepush(repo, undefined, runtime)).status).toBe("installed");
    expect((await installPrepush(repo, undefined, runtime)).status).toBe("ready");
    // Each hook owns separate records; installing pre-commit preserves pre-push.
    expect((await installPrecommit(repo, undefined, runtime)).status).toBe("installed");
    const wrapper = await readFile(hook, "utf8");
    expect((await git(repo, ["push", "origin", "main"])).exit_code).toBe(0);
    expect(await readFile(join(repo, "args"), "utf8")).toBe(`origin\n${remote}\n`);
    expect(await readFile(join(repo, "refs"), "utf8")).toMatch(/^refs\/heads\/main [a-f0-9]+ refs\/heads\/main 0+\n$/);
    expect(await readFile(join(repo, "order"), "utf8")).toBe("originaljustomp");
    const first = await gitText(remote, ["rev-parse", "main"]);
    await gitText(repo, ["commit", "--allow-empty", "-m", "test: next"]);
    await writeFile(join(repo, "order"), "");
    await writeFile(join(repo, "reject-gate"), "");
    expect((await git(repo, ["push", "origin", "main"])).exit_code).not.toBe(0);
    expect(await gitText(remote, ["rev-parse", "main"])).toBe(first);
    expect(await readFile(join(repo, "order"), "utf8")).toBe("originaljustomp");
    await writeFile(join(repo, "order"), "");
    await writeFile(join(repo, "reject-original"), "");
    expect((await git(repo, ["push", "origin", "main"])).exit_code).not.toBe(0);
    expect(await readFile(join(repo, "order"), "utf8")).toBe("original");
    await writeFile(hook, `${wrapper}# user change\n`);
    expect((await installPrepush(repo, undefined, runtime)).status).toBe("conflict");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
