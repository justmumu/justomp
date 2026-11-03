import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitText } from "../../../src/precommit/git";
import { addRelease } from "../../../src/release/changelog";
import { tagRepository } from "../../../src/release/tag";
import { releaseFixture } from "./fixture";

test("annotated release tag uses live default HEAD and stays local", async () => {
  const f = await releaseFixture();
  const remote = await mkdtemp(join(tmpdir(), "justomp-release-remote-"));
  try {
    const old = (await f.git(["rev-parse", "HEAD"])).trim();
    await gitText(remote, ["init", "--bare", "--initial-branch=main"]);
    await f.git(["remote", "add", "origin", remote]);
    await writeFile(join(f.root, "VERSION"), "1.2.3\n");
    await writeFile(join(f.root, "CHANGELOG.md"), addRelease(null, "1.2.3", "2026-11-03", "No changes.\n").text);
    await f.git(["add", "VERSION", "CHANGELOG.md"]);
    await f.git(["commit", "-m", "chore(release): prepare 1.2.3"]);
    const head = (await f.git(["rev-parse", "HEAD"])).trim();
    await f.git(["push", "origin", "main"]);
    await f.git(["update-ref", "refs/remotes/origin/main", old]);
    const created = await tagRepository(f.root);
    expect(created.success, JSON.stringify(created)).toBe(true);
    expect(created.created).toBe(true);
    expect(created.observed_target).toBe(head);
    expect(created.default_branch).toBe("main");
    expect((await f.git(["cat-file", "-t", "refs/tags/v1.2.3"])).trim()).toBe("tag");
    expect((await f.git(["rev-parse", "refs/tags/v1.2.3^{commit}"])).trim()).toBe(head);
    expect(await f.git(["ls-remote", "origin", "refs/tags/v1.2.3"])).toBe("");
    const repeated = await tagRepository(f.root);
    expect(repeated.status).toBe("rejected");
    expect(repeated.created).toBe(false);
    expect(repeated.observed_target).toBe(head);
    expect(repeated.diagnostics[0]?.code).toBe("tag-already-exists");
    expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(head);
    expect(await f.git(["status", "--porcelain=v1"])).toBe("");
  } finally {
    await f.close();
    await rm(remote, { recursive: true, force: true });
  }
});
