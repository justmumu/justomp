import { expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../../src/dependencies/runner";
import { createSandboxCommand } from "../../../src/protection/sandbox";

// One native launch proves our argv/profile actually reaches the OS boundary.
// No manager install, registry fixture, or upstream policy matrix is needed.
test("native sandbox allows source/read and rejects protected child writes and replacement", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "justomp-sandbox-")),
  );
  const target = join(root, "package.json");
  let cleanup: (() => Promise<void>) | undefined;
  try {
    await writeFile(target, "{}");
    await symlink(target, join(root, "alias.json"));
    const script = join(root, "attempt.mjs");
    await writeFile(
      script,
      `import fs from 'node:fs';
fs.writeFileSync('source.txt','source');
const original=fs.readFileSync('package.json','utf8');
const denied=[];
for (const [name,operation] of [
  ['write',()=>fs.writeFileSync('package.json','changed')],
  ['symlink',()=>fs.writeFileSync('alias.json','changed')],
  ['replace',()=>{fs.writeFileSync('new.json','changed');fs.renameSync('new.json','package.json')}],
  ['unlink',()=>fs.unlinkSync('package.json')],
]) {try {operation();denied.push([name,false]);} catch {denied.push([name,true]);}}
console.log(JSON.stringify({original,denied}));`,
    );
    const prepared = await createSandboxCommand({
      command: [process.execPath, script]
        .map((value) => `'${value.replaceAll("'", "'\\''")}'`)
        .join(" "),
      cwd: root,
      protectedPaths: [target],
    });
    cleanup = prepared.cleanup;
    const [executable, ...args] = prepared.argv;
    if (!executable) throw new Error("Sandbox argv is empty");
    const result = await runProcess(executable, args, {
      cwd: root,
      env: prepared.env,
      signal: AbortSignal.timeout(10_000),
    });
    expect(result.exit_code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      original: "{}",
      denied: [
        ["write", true],
        ["symlink", true],
        ["replace", true],
        ["unlink", true],
      ],
    });
    expect(await readFile(target, "utf8")).toBe("{}");
    expect(await readFile(join(root, "source.txt"), "utf8")).toBe("source");
  } finally {
    await cleanup?.();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("missing-path cleanup preserves an outside writer's empty replacement", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "justomp-placeholder-")),
  );
  const lock = join(root, "go.sum");
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const prepared = await createSandboxCommand({
      command: "true",
      cwd: root,
      protectedPaths: [lock],
    });
    cleanup = prepared.cleanup;
    await writeFile(join(root, "replacement"), "");
    await rename(join(root, "replacement"), lock);
    await cleanup();
    await cleanup();
    expect(await readFile(lock, "utf8")).toBe("");
  } finally {
    await cleanup?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("overlapping preparations retain missing mount points until their last owner exits", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "justomp-placeholder-owners-")),
  );
  const lock = join(root, "generated", "uv.lock");
  const prepared: Array<Awaited<ReturnType<typeof createSandboxCommand>>> = [];
  try {
    const first = await createSandboxCommand({
      command: "true",
      cwd: root,
      protectedPaths: [lock],
    });
    prepared.push(first);
    const second = await createSandboxCommand({
      command: "true",
      cwd: root,
      protectedPaths: [lock],
    });
    prepared.push(second);
    await first.cleanup();
    expect(await Bun.file(lock).exists()).toBe(process.platform === "linux");
    await second.cleanup();
    expect(await Bun.file(lock).exists()).toBe(false);
    const { lstat } = await import("node:fs/promises");
    await expect(lstat(join(root, "generated"))).rejects.toThrow();
  } finally {
    await Promise.all(prepared.map((value) => value.cleanup()));
    await rm(root, { recursive: true, force: true });
  }
});
