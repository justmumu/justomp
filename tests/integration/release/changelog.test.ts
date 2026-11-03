import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RELEASE_DEFAULTS } from "../../../src/config/release/defaults";
import { readProjectionFile } from "../../../src/lint/files";
import { renderReleaseNotes, updateUnreleased } from "../../../src/release/changelog";
import { captureHistory } from "../../../src/release/history";
import { publishReleaseFile } from "../../../src/release/publication";
import { releaseFixture } from "./fixture";

test("merged constituent commits reach owned changelog publication without touching index or refs", async () => {
  const f = await releaseFixture();
  try {
    await f.git(["tag", "v0.1.0"]);
    await f.git(["switch", "-c", "topic"]);
    await f.git(["commit", "--allow-empty", "-m", "docs: describe feature"]);
    await f.git(["commit", "--allow-empty", "-m", "feat: implement feature"]);
    await f.git(["switch", "main"]);
    await f.git(["commit", "--allow-empty", "-m", "ci: check feature"]);
    await f.git(["merge", "--no-ff", "topic", "-m", "Merge topic"]);
    const history = await captureHistory(f.root, RELEASE_DEFAULTS);
    expect(history.commits).toHaveLength(3);
    const notes = await renderReleaseNotes(history.commits);
    for (const text of ["describe feature", "implement feature", "check feature"]) {
      expect(notes.body).toContain(text);
    }
    const path = join(f.root, "CHANGELOG.md");
    await writeFile(path, "# Changelog\n\n## [Unreleased]\n\nHuman note.\n");
    const before = await readProjectionFile(f.root, path);
    const updated = updateUnreleased(before.text, notes.body);
    await publishReleaseFile(f.root, "CHANGELOG.md", before, updated);
    expect(await readFile(path, "utf8")).toBe(updated);
    expect(updated).toContain("Human note.");
    expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(history.end);
    expect(await f.git(["diff", "--cached", "--name-only"])).toBe("");
    expect((await f.git(["tag", "--list"])).trim()).toBe("v0.1.0");
    await expect(publishReleaseFile(f.root, "CHANGELOG.md", before, "stale")).rejects.toThrow("changed");
  } finally {
    await f.close();
  }
});
