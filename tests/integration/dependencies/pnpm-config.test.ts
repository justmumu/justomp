import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { closePackagingStructure } from "../../../src/packaging/get-structure";
import {
  cleanups,
  fixture,
  isolatedEnvironment,
  originalModules,
  originalPath,
  roots,
  scope,
} from "./pnpm-config-fixture";

afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalModules === undefined) delete process.env.npm_config_modules_dir;
  else process.env.npm_config_modules_dir = originalModules;
  for (const [key, value] of Object.entries(isolatedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await closePackagingStructure();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
test("workspace modules directory checks every member's symlink destination", async () => {
  const { root, project } = await fixture();
  await mkdir(join(project, "packages/member"), { recursive: true });
  await writeFile(
    join(project, "packages/member/package.json"),
    '{"name":"member","version":"1.0.0"}',
  );
  await writeFile(
    join(project, "pnpm-workspace.yaml"),
    "packages: ['packages/*']\nmodulesDir: installed\n",
  );
  await mkdir(join(root, "outside"));
  await symlink(
    join(root, "outside"),
    join(project, "packages/member/installed"),
  );
  await expect(scope(project)).rejects.toMatchObject({ code: "outside-root" });
});
test("pnpm environment destination participates in root validation", async () => {
  const { project } = await fixture();
  process.env.npm_config_modules_dir = "../outside";
  await expect(scope(project)).rejects.toMatchObject({ code: "outside-root" });
});
test("custom pnpm modules directory also validates the single-importer virtual store fallback", async () => {
  const { root, project } = await fixture();
  await writeFile(
    join(project, ".npmrc"),
    `${await readFile(join(project, ".npmrc"), "utf8")}\nmodules-dir=installed\n`,
  );
  await mkdir(join(root, "outside"));
  await symlink(join(root, "outside"), join(project, "node_modules"));
  await expect(scope(project)).rejects.toMatchObject({ code: "outside-root" });
});
