import { expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitText } from "../../../src/precommit/git";
import { installPrecommit } from "../../../src/precommit/install";

test("installer preserves an executable hook, composes once and rejects edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-hook-"));
  try {
    await gitText(root, ["init", "-q"]);
    const path = join(root, ".git/hooks/pre-commit");
    const original = "#!/bin/sh\nprintf original >> hook-order\n";
    await writeFile(path, original);
    await chmod(path, 0o755);
    const cli = join(root, "fake-cli.ts");
    await writeFile(
      cli,
      "await Bun.write('hook-order', (await Bun.file('hook-order').text()) + 'justomp');\n",
    );
    expect(
      (await installPrecommit(root, undefined, { cli, bun: process.execPath }))
        .status,
    ).toBe("installed");
    expect(
      (await installPrecommit(root, undefined, { cli, bun: process.execPath }))
        .status,
    ).toBe("ready");
    await gitText(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "test: hooks",
    ]);
    expect(await readFile(join(root, "hook-order"), "utf8")).toBe(
      "originaljustomp",
    );
    await writeFile(path, "#!/bin/sh\nexit 3\n");
    expect(
      (await installPrecommit(root, undefined, { cli, bun: process.execPath }))
        .status,
    ).toBe("conflict");
    expect(
      await readFile(
        join(root, ".git/hooks/pre-commit.justomp-original"),
        "utf8",
      ),
    ).toBe(original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installer refuses external and symlinked hook ownership, and recovers interrupted publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-hook-recovery-"));
  const external = await mkdtemp(join(tmpdir(), "justomp-external-hooks-"));
  try {
    await gitText(root, ["init", "-q"]);
    const cli = join(root, "fake-cli.ts");
    await writeFile(cli, "await Bun.write('cli-ran', 'yes');\n");
    const runtime = { cli, bun: process.execPath };
    await gitText(root, ["config", "core.hooksPath", external]);
    expect((await installPrecommit(root, undefined, runtime)).status).toBe(
      "conflict",
    );
    expect(await Bun.file(join(external, "pre-commit")).exists()).toBe(false);
    await symlink(external, join(root, "linked-hooks"));
    await gitText(root, ["config", "core.hooksPath", "linked-hooks"]);
    expect((await installPrecommit(root, undefined, runtime)).status).toBe(
      "conflict",
    );
    await gitText(root, ["config", "--unset", "core.hooksPath"]);

    const path = join(root, ".git/hooks/pre-commit");
    const original = "#!/bin/sh\nprintf original > original-ran\nexit 9\n";
    await writeFile(path, original, { mode: 0o755 });
    const backup = `${path}.justomp-original`;
    // Crash after preserving the original, before recording ownership.
    await copyFile(path, backup);
    await chmod(backup, 0o755);
    expect((await installPrecommit(root, undefined, runtime)).status).toBe(
      "installed",
    );
    const wrapper = await readFile(path, "utf8");
    // Crash after publishing the ownership record, before replacing the original.
    await writeFile(path, original);
    expect((await installPrecommit(root, undefined, runtime)).status).toBe(
      "installed",
    );
    expect(await readFile(path, "utf8")).toBe(wrapper);
    expect(await readFile(backup, "utf8")).toBe(original);
    const result = await git(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "test: original failure",
    ]);
    expect(result.exit_code).not.toBe(0);
    expect(await readFile(join(root, "original-ran"), "utf8")).toBe("original");
    expect(await Bun.file(join(root, "cli-ran")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});
