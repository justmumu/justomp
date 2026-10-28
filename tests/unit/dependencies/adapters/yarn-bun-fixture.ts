import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInventory } from "../../../../src/dependencies/inventory";
import type { AdapterContext } from "../../../../src/dependencies/model";
import { inspectProject } from "../../../../src/inspect/scan";
export async function fixture(manifest: Record<string, unknown> = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "justomp-u6-unit-")),
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "app", packageManager: "yarn@4.12.0", ...manifest }),
  );
  const structure = await inspectProject({ root });
  const project = structure.projects[0];
  if (!project) throw new Error("Missing fixture project");
  const context: AdapterContext = {
    root,
    owner: root,
    cwd: root,
    structure,
    project,
    manager: "yarn",
    version: "4.12.0",
    run: async () => {
      throw new Error("Unexpected native execution");
    },
  };
  const inventory = await readInventory(root, project);
  return {
    root,
    context,
    inventory,
    id: project.project_id,
    text: () => readFile(join(root, "package.json"), "utf8"),
    close: () => rm(root, { recursive: true, force: true }),
  };
}
