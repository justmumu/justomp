import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bumpRepository } from "../../../src/release/bump";
import { updateRepositoryChangelog } from "../../../src/release/service";
import { releaseFixture } from "./fixture";

test("repository bump publishes common records and leaves native Go metadata, index and HEAD untouched", async () => {
  const f = await releaseFixture();
  try {
    const go = "module example.com/demo\n\ngo 1.23.0\n";
    await writeFile(join(f.root, "go.mod"), go);
    await writeFile(join(f.root, "VERSION"), "1.0.0\n");
    await f.git(["add", "go.mod", "VERSION"]);
    await f.git(["commit", "-m", "feat: add module"]);
    await writeFile(join(f.root, ".gitignore"), "node_modules/\n.justomp/\nCHANGELOG.md\n");
    await f.git(["add", ".gitignore"]);
    await f.git(["commit", "-m", "chore: keep local release notes ignored"]);
    const head = (await f.git(["rev-parse", "HEAD"])).trim();
    const result = await bumpRepository(f.root, { increment: "minor" });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.changed_files).toEqual(["CHANGELOG.md", "VERSION"]);
    expect(await readFile(join(f.root, "VERSION"), "utf8")).toBe("1.1.0\n");
    expect(await readFile(join(f.root, "go.mod"), "utf8")).toBe(go);
    expect(await readFile(join(f.root, "CHANGELOG.md"), "utf8")).toContain("add module");
    expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(head);
    expect(await f.git(["diff", "--cached", "--name-only"])).toBe("");
    const rejected = await bumpRepository(f.root, { increment: "patch" });
    expect(rejected.status).toBe("rejected");
    expect(rejected.diagnostics[0]?.code).toBe("dirty-tree");
    const notes = await updateRepositoryChangelog(f.root);
    expect(notes.success, JSON.stringify(notes)).toBe(true);
    const stable = await readFile(join(f.root, "CHANGELOG.md"), "utf8");
    expect((await updateRepositoryChangelog(f.root)).changed_files).toEqual([]);
    expect(await readFile(join(f.root, "CHANGELOG.md"), "utf8")).toBe(stable);
  } finally {
    await f.close();
  }
});
