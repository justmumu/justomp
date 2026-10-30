import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JAVASCRIPT_DEFAULTS } from "../../../src/config/test/javascript/defaults";
import {
  closePackagingStructure,
  getPackagingStructure,
} from "../../../src/packaging/get-structure";
import { collectTestScope } from "../../../src/testing/scope";
import { resolveTestTarget } from "../../../src/testing/targets";

test("test scope retains literal names while excluding nested projects and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-test-scope-"));
  try {
    for (const dir of [
      "tests/unit",
      "tests/integration",
      "child",
      "node_modules",
      "src",
    ])
      await mkdir(join(root, dir), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "root", packageManager: "npm@10.9.0" }),
    );
    await writeFile(
      join(root, "child/package.json"),
      JSON.stringify({ name: "child" }),
    );
    for (const file of [
      "tests/unit/a[1].test.ts",
      "tests/integration/a.test.ts",
      "child/a.ts",
      "node_modules/no.ts",
      "src/a.ts",
    ])
      await writeFile(join(root, file), "export {};\n");
    await symlink(
      join(root, "src/a.ts"),
      join(root, "tests/unit/link.test.ts"),
    );
    const { structure } = await getPackagingStructure(root, { publish: false });
    const target = await resolveTestTarget(
      structure,
      "javascript:package.json",
    );
    const scope = await collectTestScope(target, JAVASCRIPT_DEFAULTS);
    expect(scope.tests).toEqual(["tests/unit/a[1].test.ts"]);
    expect(scope.sources).toEqual(["src/a.ts"]);
    await expect(
      collectTestScope(target, JAVASCRIPT_DEFAULTS, [
        "tests/unit/link.test.ts",
      ]),
    ).rejects.toThrow("not an owned unit test");
  } finally {
    await closePackagingStructure(root);
    await rm(root, { recursive: true, force: true });
  }
});
