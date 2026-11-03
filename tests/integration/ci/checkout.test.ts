import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeCheckout } from "../../../scripts/ci/evidence";
import { gitText } from "../../../src/precommit/git";

test("CI observes real staged and working changes while ignoring generated output", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-ci-checkout-"));
  try {
    await gitText(root, ["init", "-q"]);
    await gitText(root, ["config", "user.name", "CI fixture"]);
    await gitText(root, ["config", "user.email", "test@example.invalid"]);
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "tracked.txt"), "before\n");
    await gitText(root, ["add", "--", ".gitignore", "tracked.txt"]);
    await gitText(root, ["commit", "-q", "-m", "test: initial"]);
    const baseline = await observeCheckout(root, "baseline");
    expect(baseline.changes).toEqual([]);
    await writeFile(join(root, "ignored.txt"), "cache");
    expect((await observeCheckout(root, "install")).changes).toEqual([]);
    await writeFile(join(root, "tracked.txt"), "changed\n");
    await gitText(root, ["add", "--", "tracked.txt"]);
    await writeFile(join(root, "tracked.txt"), "changed again\n");
    await writeFile(join(root, "new file\nwith newline.ts"), "source");
    const observation = await observeCheckout(root, "check");
    expect(observation.head).toBe(baseline.head);
    expect(observation.changes).toEqual(
      expect.arrayContaining([
        { status: "MM", path: "tracked.txt" },
        { status: "??", path: "new file\nwith newline.ts" },
      ]),
    );
    expect(observation.changes).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
