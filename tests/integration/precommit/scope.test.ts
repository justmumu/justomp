import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childProjectRoots } from "../../../src/packaging/file-scope";
import { closePackagingStructure, getPackagingStructure } from "../../../src/packaging/get-structure";
import { packagingInvocation } from "../../../src/packaging/invocation";

test("invocation excludes submodule discovery and native file scope without publishing its snapshot", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "justomp-scope-")));
  try {
    await mkdir(join(root, "vendor"));
    for (const directory of [root, join(root, "vendor")]) {
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({
          name: directory === root ? "root" : "vendor",
          packageManager: "bun@1.4.2",
        }),
      );
    }
    const ordinary = await getPackagingStructure(root);
    expect(ordinary.structure.projects).toHaveLength(2);
    const before = await Bun.file(join(root, ".justomp/packaging_structure.json")).text();
    await packagingInvocation.run({ root, excluded: ["vendor"] }, async () => {
      const result = await getPackagingStructure(root, { refresh: true });
      expect(result.structure.projects).toHaveLength(1);
      const project = result.structure.projects[0];
      if (!project) {
        throw new Error("Missing root project");
      }
      expect(childProjectRoots(project, result.structure.projects)).toContain("vendor");
    });
    expect(await Bun.file(join(root, ".justomp/packaging_structure.json")).text()).toBe(before);
    expect((await getPackagingStructure(root)).structure.projects).toHaveLength(2);
  } finally {
    await closePackagingStructure(root);
    await rm(root, { recursive: true, force: true });
  }
});
