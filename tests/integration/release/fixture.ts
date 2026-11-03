import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitText } from "../../../src/precommit/git";
export async function releaseFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "justomp-release-")));
  const git = (args: string[]) => gitText(root, args);
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Release fixture"]);
  await git(["config", "user.email", "fixture@users.noreply.github.com"]);
  await writeFile(join(root, ".gitignore"), "node_modules/\n.justomp/\n");
  await git(["add", ".gitignore"]);
  await git(["commit", "-m", "chore: initialize fixture"]);
  return { root, git, close: () => rm(root, { recursive: true, force: true }) };
}
