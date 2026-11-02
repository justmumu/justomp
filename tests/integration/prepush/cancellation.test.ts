import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, gitText } from "../../../src/precommit/git";
import { installPrepush } from "../../../src/prepush/install";

test("cancelled Git push terminates a running hook descendant", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-push-cancel-"));
  const controller = new AbortController();
  let running: ReturnType<typeof git> | undefined;
  try {
    const repo = join(root, "repo"),
      remote = join(root, "remote.git");
    await mkdir(repo);
    await gitText(repo, ["init", "-q", "-b", "main"]);
    await gitText(repo, ["config", "user.name", "Test"]);
    await gitText(repo, ["config", "user.email", "test@example.invalid"]);
    await gitText(repo, ["commit", "--allow-empty", "-m", "test: cancellation"]);
    await gitText(root, ["init", "--bare", "-q", remote]);
    await gitText(repo, ["remote", "add", "origin", remote]);
    const cli = join(root, "cli.ts");
    await writeFile(
      cli,
      'const child = Bun.spawn(["sleep","30"]); await Bun.write("child-pid",String(child.pid)); await child.exited;',
    );
    expect((await installPrepush(repo, undefined, { cli, bun: process.execPath })).status).toBe("installed");
    running = git(repo, ["push", "origin", "main"], controller.signal);
    const marker = join(repo, "child-pid"),
      deadline = Date.now() + 10000;
    while (!(await Bun.file(marker).exists())) {
      if (Date.now() > deadline) {
        throw new Error("Hook child did not start");
      }
      await Bun.sleep(10);
    }
    const pid = Number(await readFile(marker, "utf8"));
    controller.abort();
    expect((await running).cancelled).toBe(true);
    expect((await git(remote, ["rev-parse", "--verify", "main"])).exit_code).not.toBe(0);
    const reaped = Date.now() + 2000;
    for (;;) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      if (Date.now() > reaped) {
        throw new Error("Push hook child survived cancellation");
      }
      await Bun.sleep(10);
    }
  } finally {
    controller.abort();
    await running;
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("real CLI forwards SIGTERM to detached native command and reports incomplete", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-push-signal-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let nativePid: number | undefined;
  try {
    await gitText(root, ["init", "-q"]);
    await writeFile(
      join(root, "pyproject.toml"),
      '[project]\nname = "cancel-fixture"\nversion = "0.1.0"\nrequires-python = ">=3.11"\n',
    );
    await writeFile(join(root, "uv.lock"), 'version = 1\nrequires-python = ">=3.11"\n');
    const bin = join(root, ".bin");
    await mkdir(bin);
    const uv = join(bin, "uv");
    await writeFile(
      uv,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "uv 0.11.6"; exit 0; fi\nprintf "%s" "$$" > blocked-native\nexec sleep 30\n',
    );
    await chmod(uv, 0o755);
    const cli = fileURLToPath(new URL("../../../src/prepush/cli.ts", import.meta.url));
    const spawned = Bun.spawn([process.execPath, cli], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    child = spawned;
    const stdout = new Response(spawned.stdout).text(),
      stderr = new Response(spawned.stderr).text();
    const marker = join(root, "blocked-native"),
      deadline = Date.now() + 10000;
    while (!(await Bun.file(marker).exists())) {
      if (Date.now() > deadline || child.exitCode !== null) {
        throw new Error(`Native command did not start (exit ${child.exitCode})`);
      }
      await Bun.sleep(10);
    }
    nativePid = Number(await readFile(marker, "utf8"));
    child.kill("SIGTERM");
    const code = await child.exited;
    const output = await stdout;
    expect(code, `${await stderr}\n${output}`).toBe(2);
    expect(JSON.parse(output)).toMatchObject({
      success: false,
      complete: false,
      cancelled: true,
    });
    expect(() => process.kill(nativePid as number, 0)).toThrow();
  } finally {
    child?.kill("SIGTERM");
    if (child) {
      await child.exited;
    }
    if (nativePid) {
      try {
        process.kill(nativePid, "SIGKILL");
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
