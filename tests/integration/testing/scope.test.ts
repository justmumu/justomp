import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JAVASCRIPT_DEFAULTS as INTEGRATION_DEFAULTS } from "../../../src/config/integration-test/javascript/defaults";
import { JAVASCRIPT_DEFAULTS } from "../../../src/config/test/javascript/defaults";
import {
  closePackagingStructure,
  getPackagingStructure,
} from "../../../src/packaging/get-structure";
import { collectTestScope } from "../../../src/testing/scope";
import { resolveTestTarget } from "../../../src/testing/targets";

test("test scope retains literal names while excluding nested projects and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-test-scope-"));
  const outside = await mkdtemp(join(tmpdir(), "justomp-test-config-outside-"));
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
    const policies = {
      unit: JAVASCRIPT_DEFAULTS,
      integration: INTEGRATION_DEFAULTS,
      suite: "unit" as const,
    };
    const scope = await collectTestScope(target, policies);
    expect(scope.integration).toEqual(["tests/integration/a.test.ts"]);
    expect(scope.tests).toEqual(["tests/unit/a[1].test.ts"]);
    expect(scope.sources).toEqual(["src/a.ts"]);
    await expect(
      collectTestScope(target, policies, ["tests/unit/link.test.ts"]),
    ).rejects.toThrow("not an owned unit test");
    const configName = "integration config.ts";
    await writeFile(join(root, configName), "export default {};\n");
    await writeFile(
      join(root, "child/vitest.config.ts"),
      "export default {};\n",
    );
    await writeFile(join(outside, "config.ts"), "export default {};\n");
    await symlink(join(outside, "config.ts"), join(root, "external-config.ts"));
    const setConfig = async (path: string) => {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: "root",
          packageManager: "npm@10.9.0",
          scripts: { "test:integration": `vitest run --config="${path}"` },
        }),
      );
    };
    await setConfig(configName);
    expect(
      (
        await resolveTestTarget(
          structure,
          "javascript:package.json",
          "integration",
        )
      ).configFile,
    ).toBe(await realpath(join(root, configName)));
    for (const invalid of [
      "child/vitest.config.ts",
      "external-config.ts",
      "../config.ts",
    ]) {
      await setConfig(invalid);
      await expect(
        resolveTestTarget(structure, "javascript:package.json", "integration"),
      ).rejects.toThrow();
      // Integration-only metadata cannot break an otherwise valid unit target.
      expect(
        (await resolveTestTarget(structure, "javascript:package.json", "unit"))
          .configFile,
      ).toBeUndefined();
    }
  } finally {
    await closePackagingStructure(root);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
