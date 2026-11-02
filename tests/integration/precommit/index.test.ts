import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitContext, gitText, stagedRecords } from "../../../src/precommit/git";

test("real Git index preserves NUL paths from a nested cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-index-"));
  try {
    await gitText(root, ["init", "-q"]);
    await mkdir(join(root, "nested"));
    const names = ["space name.ts", "line\nname.ts", ":(glob)literal.ts"];
    for (const name of names) {
      await writeFile(join(root, name), "hello\n");
    }
    await gitText(root, ["--literal-pathspecs", "add", "--", ...names]);
    const context = await gitContext(join(root, "nested"));
    expect(context).not.toBeNull();
    if (!context) {
      throw new Error("Missing Git context");
    }
    expect((await stagedRecords(context)).flatMap((r) => r.paths).sort()).toEqual(names.sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
