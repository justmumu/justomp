import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitRepository } from "../../../src/commit/service";
import { runProcess } from "../../../src/dependencies/runner";
import { gitText } from "../../../src/precommit/git";
import { createSandboxCommand } from "../../../src/protection/sandbox";

test("commitlint rejects before installation; trusted Git runs hook once and reports actual message", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "justomp-commit-tool-")));
  try {
    await gitText(root, ["init", "-q"]);
    await gitText(root, ["config", "user.name", "Test"]);
    await gitText(root, ["config", "user.email", "test@example.invalid"]);
    await gitText(root, ["config", "core.abbrev", "4"]);
    await gitText(root, ["symbolic-ref", "HEAD", "refs/heads/feature]demo"]);
    await mkdir(join(root, ".justomp"));
    const invalid = await commitRepository(root, "not conventional");
    expect(invalid.validation?.valid).toBe(false);
    expect(await Bun.file(join(root, ".git/hooks/pre-commit")).exists()).toBe(false);
    expect(await Bun.file(join(root, ".justomp/config.json")).exists()).toBe(false);
    const config = join(root, ".justomp/config.json");
    await writeFile(config, "{}");
    const sandbox = await createSandboxCommand({
      command: "printf changed > .justomp/config.json",
      cwd: root,
      protectedPaths: [config],
    });
    try {
      const [binary, ...args] = sandbox.argv;
      if (!binary) {
        throw new Error("Missing sandbox binary");
      }
      const denied = await runProcess(binary, args, {
        cwd: root,
        env: sandbox.env,
      });
      expect(denied.exit_code).not.toBe(0);
      expect(await readFile(config, "utf8")).toBe("{}");
    } finally {
      await sandbox.cleanup();
    }
    const hook = join(root, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\nprintf x >> executions\nprintf '{\"trusted\":true}' > .justomp/config.json\n");
    await chmod(hook, 0o755);
    const messageHook = join(root, ".git/hooks/prepare-commit-msg");
    await writeFile(messageHook, '#!/bin/sh\nprintf "docs: actual message\\n" > "$1"\n');
    await chmod(messageHook, 0o755);
    await writeFile(join(root, "readme.txt"), "hello\n");
    await gitText(root, ["add", "--", "readme.txt"]);
    const result = await commitRepository(root, "docs: initial message");
    expect(result.errors).toEqual([]);
    expect(result.native?.exit_code).toBe(0);
    expect(result.success).toBe(true);
    expect(result.commit_hash).toBe((await gitText(root, ["rev-parse", "HEAD"])).trim());
    expect(result.message?.trim()).toBe("docs: actual message");
    expect(await readFile(join(root, "executions"), "utf8")).toBe("x");
    expect(JSON.parse(await readFile(config, "utf8")).trusted).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
