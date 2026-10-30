import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { closePackagingStructure } from "../../../src/packaging/get-structure";
import { checkProjectTypecheck } from "../../../src/typecheck/index";
import { pythonFixture } from "../../fixtures/typecheck/python/fixture";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function cli(root: string, extra: string[] = []) {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("../../../src/typecheck/cli.ts", import.meta.url).pathname,
      "--root",
      root,
      "--project-id",
      "python:pyproject.toml",
      ...extra,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exit, out, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exit, result: JSON.parse(out), error };
}
test("CLI defaults to full preparation; explicit check-only is readonly and shares native API diagnostics", async () => {
  const f = await pythonFixture();
  cleanup.push(async () => {
    await closePackagingStructure(f.root);
    await f.dispose();
  });
  expect((await cli(f.root, ["--check-only"])).exit).toBe(2);
  expect(await Bun.file(join(f.root, ".justomp/config.json")).exists()).toBe(
    false,
  );
  const first = await cli(f.root);
  expect(first.exit, JSON.stringify(first)).toBe(0);
  expect(first.result.preparation.changes.length).toBeGreaterThan(0);
  await writeFile(join(f.root, "module.py"), 'answer: int = "bad"\n');
  const files = [
    "module.py",
    "pyproject.toml",
    "uv.lock",
    "pyright.justomp.json",
    ".justomp/config.json",
    ".justomp/typecheck_state.json",
  ];
  const bytes = () =>
    Promise.all(files.map((path) => readFile(join(f.root, path), "utf8")));
  const before = await bytes(),
    api = await checkProjectTypecheck(f.root, "python:pyproject.toml"),
    command = await cli(f.root, ["--check-only"]);
  expect(command.exit, JSON.stringify(command)).toBe(1);
  expect(command.result.diagnostics).toEqual(api.diagnostics);
  expect(await bytes()).toEqual(before);
  expect((await cli(f.root, ["--manager", "uv"])).exit).toBe(2);
}, 60000);

test("CLI SIGTERM cancels and joins its actual native setup process", async () => {
  const f = await pythonFixture();
  cleanup.push(async () => {
    await closePackagingStructure(f.root);
    await f.dispose();
  });
  const uv = Bun.which("uv");
  if (!uv) throw new Error("uv required");
  const bin = join(f.root, ".fixture-bin"),
    started = join(f.root, "started"),
    stopped = join(f.root, "stopped");
  await mkdir(bin);
  await writeFile(
    join(bin, "uv"),
    `#!/usr/bin/env python3\nimport os, signal, sys, time\nif len(sys.argv)>1 and sys.argv[1]=='add':\n def stop(signum, frame):\n  time.sleep(0.08)\n  open(${JSON.stringify(stopped)}, 'w').write('closed')\n  sys.exit(1)\n signal.signal(signal.SIGTERM, stop)\n open(${JSON.stringify(started)}, 'w').write(str(os.getpid()))\n while True: time.sleep(0.05)\nelse: os.execv(${JSON.stringify(uv)}, [${JSON.stringify(uv)}]+sys.argv[1:])\n`,
    { mode: 0o755 },
  );
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("../../../src/typecheck/cli.ts", import.meta.url).pathname,
      "--root",
      f.root,
      "--project-id",
      "python:pyproject.toml",
    ],
    {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const out = new Response(child.stdout).text(),
    error = new Response(child.stderr).text();
  try {
    const deadline = Date.now() + 20000;
    while (!(await Bun.file(started).exists())) {
      if (Date.now() > deadline) throw new Error("Native setup did not start");
      await Bun.sleep(20);
    }
    const pid = Number(await readFile(started, "utf8"));
    child.kill("SIGTERM");
    expect(await child.exited, await error).toBe(2);
    const result = JSON.parse(await out);
    expect(result.project_id).toBe("python:pyproject.toml");
    expect(result.cancelled).toBe(true);
    expect(result.complete).toBe(false);
    expect(await readFile(stopped, "utf8")).toBe("closed");
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
}, 30000);
