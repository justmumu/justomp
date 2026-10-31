import { expect, test } from "bun:test";
import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProtectedBash } from "../../../src/protection/bash";

test("foreground bash streams output, denies metadata writes and reaps on timeout", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "justomp-bash-")));
  const path = join(root, "package.json");
  try {
    await writeFile(path, "{}");
    const chunks: string[] = [];
    const ok = await runProtectedBash({
      command: "printf source > source.txt; printf out; printf err >&2",
      cwd: root,
      protectedPaths: [path],
      onOutput: (chunk) => chunks.push(chunk),
    });
    expect(ok.exitCode).toBe(0);
    expect(ok.output).toContain("out");
    expect(ok.output).toContain("err");
    expect(chunks.join("")).toContain("out");
    expect(await readFile(join(root, "source.txt"), "utf8")).toBe("source");
    const denied = await runProtectedBash({
      command: "printf wrong > package.json",
      cwd: root,
      protectedPaths: [path],
    });
    expect(denied.exitCode).not.toBe(0);
    expect(await readFile(path, "utf8")).toBe("{}");
    const timed = await runProtectedBash({
      command: "(sleep 0.2; printf late > timed-child.txt) & wait",
      cwd: root,
      protectedPaths: [path],
      timeoutMs: 30,
    });
    expect(timed.timedOut).toBe(true);
    const controller = new AbortController();
    const cancelled = runProtectedBash({
      command: "(sleep 0.2; printf late > cancelled-child.txt) & wait",
      cwd: root,
      protectedPaths: [path],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    expect((await cancelled).cancelled).toBe(true);
    await Bun.sleep(250);
    await expect(access(join(root, "timed-child.txt"))).rejects.toThrow();
    await expect(access(join(root, "cancelled-child.txt"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("foreground exit terminates a background child holding the output pipes", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "justomp-bash-child-")),
  );
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), 1000);
  try {
    const result = await runProtectedBash({
      command: "(sleep 0.2; printf late > background.txt) & printf done",
      cwd: root,
      protectedPaths: [],
      timeoutMs: 0,
      signal: controller.signal,
    });
    expect(result.cancelled).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("done");
    await Bun.sleep(250);
    await expect(access(join(root, "background.txt"))).rejects.toThrow();
  } finally {
    clearTimeout(watchdog);
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
});
