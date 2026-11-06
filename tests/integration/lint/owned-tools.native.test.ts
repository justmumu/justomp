import { expect, test } from "bun:test";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { javascriptAdapter } from "../../../src/lint/adapters/javascript";
import { pythonAdapter } from "../../../src/lint/adapters/python";
import { javascriptFixture } from "../../fixtures/lint/javascript/fixture";
import { pythonFixture } from "../../fixtures/lint/python/fixture";

test("isolated Python lint prepares without Python or uv and leaves project dependencies untouched", async () => {
  const f = await pythonFixture();
  try {
    for (const target of f.targets) {
      target.scope.env.PATH = "";
    }
    const before = parse(await readFile(join(f.root, "pyproject.toml"), "utf8"));
    await f.prepare();
    const after = parse(await readFile(join(f.root, "pyproject.toml"), "utf8"));
    expect(after.project).toEqual(before.project);
    expect(after["dependency-groups"]).toEqual(before["dependency-groups"]);
    await expect(lstat(join(f.root, "uv.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(f.root, ".venv"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await pythonAdapter.verify(await f.checkContext())).toBe(true);
  } finally {
    await f.dispose();
  }
}, 120_000);

test("isolated JavaScript lint uses Justomp Biome without Node or child packages", async () => {
  const f = await javascriptFixture("npm");
  try {
    for (const target of f.targets) {
      target.scope.env.PATH = "";
      target.scope.env.BIOME_BINARY = "/untrusted/biome";
    }
    const before = await readFile(join(f.root, "package.json"), "utf8");
    await f.prepare();
    expect(await readFile(join(f.root, "package.json"), "utf8")).toBe(before);
    await expect(lstat(join(f.root, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(f.root, "package-lock.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const context = await f.checkContext();
    expect(await javascriptAdapter.verify(context)).toBe(true);
    expect((await javascriptAdapter.check(context)).map((check) => check.status)).toEqual(["passed", "passed"]);
  } finally {
    await f.dispose();
  }
}, 120_000);
