import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { safePath } from "../dependencies/paths";
/** Reports are private to one invocation; an older run cannot satisfy this run. */
export async function testArtifacts(root: string) {
  const parent = await safePath(root, join(root, ".justomp/test_runs"));
  await mkdir(parent, { recursive: true });
  const path = await mkdtemp(join(parent, "run-"));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}
