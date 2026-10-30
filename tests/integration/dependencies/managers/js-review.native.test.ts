import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { yarnModernAdapter } from "../../../../src/dependencies/adapters/yarn-modern";
import { fixture, gitSource } from "./yarn-bun-fixture";

test("modern Yarn mixed native update keeps default registry constraints and Git/local sources", async () => {
  const f = await fixture("modern", true);
  const git = await gitSource(f.root);
  try {
    await mkdir(join(f.root, "local"));
    await writeFile(
      join(f.root, "local/package.json"),
      JSON.stringify({ name: "u6-local", version: "1.0.0" }),
    );
    await f.operate(yarnModernAdapter, {
      operation: "add",
      group: { kind: "runtime" },
      packages: [
        { name: "u6-dep", version: "^1.0.0", source: { kind: "registry" } },
        { name: "u6-other", version: "^1.0.0", source: { kind: "registry" } },
        { name: "u6-local", source: { kind: "path", path: "local" } },
        { name: "u6-git", source: { kind: "git", url: git.url, ref: "main" } },
      ],
    });
    const before = (await f.manifest()).dependencies;
    f.publish("2.0.0");
    await f.operate(yarnModernAdapter, {
      operation: "update",
      packages: [
        { name: "u6-dep", version: "2.0.0" },
        { name: "u6-other" },
        { name: "u6-local" },
        { name: "u6-git" },
      ],
    });
    const after = (await f.manifest()).dependencies;
    expect(after).toEqual({ ...before, "u6-dep": "2.0.0" });
    expect(await f.installed("u6-other")).toBe("1.1.0");
    expect(await f.installed("u6-dep")).toBe("2.0.0");
  } finally {
    await git.close();
    await f.close();
  }
}, 60000);
