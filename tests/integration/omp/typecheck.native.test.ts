import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkProjectTypecheck } from "../../../src/typecheck/index";
import { VERSION } from "../../fixtures/typecheck/python/fixture";
import { cleanups, fixture, json, registry, until } from "./typecheck-fixture";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
test("OMP native typecheck exposes setup effects and the same diagnostics as readonly API", async () => {
  const { f, h } = await fixture();
  const network = registry();
  try {
    const updates: unknown[] = [];
    const first = await h
      .getTool("project_typecheck")
      .execute(
        "prepare",
        { project_id: "python:pyproject.toml" },
        undefined,
        (result) => updates.push(result),
      );
    const result = json(first);
    expect(result).toEqual(first.details);
    expect(result.preparation).not.toHaveProperty("projects");
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.preparation.tools).toEqual({ pyright: VERSION });
    expect(
      result.preparation.changes.some(
        (c: { path: string }) => c.path === "pyproject.toml",
      ),
    ).toBe(true);
    expect(updates.length).toBeGreaterThan(0);
  } finally {
    network.mockRestore();
  }
  await writeFile(
    join(f.root, "module.py"),
    '"""Example module."""\n\nvalue=unknown\n',
  );
  const bytes = await f.bytes();
  const direct = await checkProjectTypecheck(f.root, "python:pyproject.toml");
  const tool = json(
    await h
      .getTool("project_typecheck")
      .execute("check", { project_id: "python:pyproject.toml" }),
  );
  expect(tool.diagnostics).toEqual(direct.diagnostics);
  expect(tool.checks.map((c: { status: string }) => c.status)).toEqual([
    "failed",
  ]);
  expect(await f.bytes()).toEqual(bytes);
  expect(
    JSON.parse(await readFile(join(f.root, ".justomp/config.json"), "utf8"))
      .lint,
  ).toBeDefined();
}, 30000);
for (const transition of ["shutdown", "root change"] as const) {
  test(`session ${transition} cancels and joins actual background setup subprocess`, async () => {
    const { f, h } = await fixture();
    const actualUv = Bun.which("uv");
    if (!actualUv)
      throw new Error("uv required for native setup lifecycle test");
    const bin = join(f.root, ".fixture-bin");
    await mkdir(bin);
    const started = join(f.root, "started"),
      stopped = join(f.root, "stopped");
    await writeFile(
      join(bin, "uv"),
      `#!/usr/bin/env python3\nimport os, signal, sys, time\nif len(sys.argv)>1 and sys.argv[1]=='add' and any('pyright' in arg for arg in sys.argv[2:]):\n def stop(signum, frame):\n  time.sleep(0.08)\n  open(${JSON.stringify(stopped)}, 'w').write('closed')\n  sys.exit(1)\n signal.signal(signal.SIGTERM, stop)\n open(${JSON.stringify(started)}, 'w').write(str(os.getpid()))\n while True: time.sleep(0.05)\nelse: os.execv(${JSON.stringify(actualUv)}, [${JSON.stringify(actualUv)}]+sys.argv[1:])\n`,
      { mode: 0o755 },
    );
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous}`;
    const network = registry();
    try {
      await h.runner.emit({ type: "session_start" });
      await until(
        () => Bun.file(started).exists(),
        "native setup child did not start",
      );
      const pid = Number(await readFile(started, "utf8"));
      if (transition === "shutdown") await h.close();
      else {
        const next = join(f.root, ".new-root");
        await mkdir(next);
        await h.session.moveTo(next, join(next, ".host/sessions"));
        await h.runner.emit({ type: "session_start" });
      }
      expect(await readFile(stopped, "utf8")).toBe("closed");
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await h.close();
      process.env.PATH = previous;
      network.mockRestore();
    }
  }, 30000);
}
