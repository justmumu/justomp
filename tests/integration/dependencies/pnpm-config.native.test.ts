import { afterEach, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pnpmAdapter } from "../../../src/dependencies/adapters/pnpm";
import { resolveManagerScope } from "../../../src/dependencies/executable";
import { withDomains } from "../../../src/dependencies/queue";
import { executeDependency } from "../../../src/dependencies/service";
import { inspectProject } from "../../../src/inspect/scan";
import { closePackagingStructure } from "../../../src/packaging/get-structure";
import { fixture as registryFixture } from "./managers/npm-pnpm-fixture";
import {
  cleanups,
  fixture,
  isolatedEnvironment,
  originalModules,
  originalPath,
  roots,
  servicePath,
} from "./pnpm-config-fixture";

afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalModules === undefined) {
    delete process.env.npm_config_modules_dir;
  } else {
    process.env.npm_config_modules_dir = originalModules;
  }
  for (const [key, value] of Object.entries(isolatedEnvironment)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await closePackagingStructure();
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
test.each([".npmrc", "pnpm-workspace.yaml"])(
  "redirected pnpm lock lifecycle uses %s for metadata, inventory and frozen sync",
  async (config) => {
    const fixture = await registryFixture("pnpm");
    cleanups.push(() => fixture.close());
    const { root, project } = fixture;
    if (config === ".npmrc") {
      await writeFile(join(project, config), `${await readFile(join(project, config), "utf8")}\nlockfile-dir=locks\n`);
    } else {
      await writeFile(join(project, config), "packages: []\nlockfileDir: locks\n");
    }
    await servicePath(root);
    const project_id = "javascript:package.json";
    const added = await executeDependency(
      project,
      "add",
      {
        project_id,
        group: { kind: "runtime" },
        packages: [
          {
            name: "fixture-dep",
            version: "1.0.0",
            source: { kind: "registry" },
          },
        ],
      },
      { pnpm: pnpmAdapter },
    );
    expect(added.outcome, JSON.stringify(added)).toBe("success");
    expect(
      "metadata_changes" in added && added.metadata_changes?.some((item) => item.path === "locks/pnpm-lock.yaml"),
    ).toBe(true);
    const listed = await executeDependency(project, "list", { project_id }, { pnpm: pnpmAdapter });
    expect(
      "dependencies" in listed &&
        listed.dependencies.find((item) => item.name === "fixture-dep")?.resolutions?.[0]?.version,
      JSON.stringify(listed),
    ).toBe("1.0.0");
    fixture.publish();
    const updated = await executeDependency(
      project,
      "update",
      { project_id, packages: [{ name: "fixture-dep", version: "2.0.0" }] },
      { pnpm: pnpmAdapter },
    );
    expect(updated.outcome, JSON.stringify(updated)).toBe("success");
    expect(
      "metadata_changes" in updated && updated.metadata_changes?.some((item) => item.path === "locks/pnpm-lock.yaml"),
    ).toBe(true);
    const synced = await executeDependency(project, "sync", { project_id }, { pnpm: pnpmAdapter });
    expect(synced.outcome, JSON.stringify(synced)).toBe("success");
    const removed = await executeDependency(
      project,
      "remove",
      {
        project_id,
        group: { kind: "runtime" },
        packages: [{ name: "fixture-dep" }],
      },
      { pnpm: pnpmAdapter },
    );
    expect(removed.outcome, JSON.stringify(removed)).toBe("success");
    expect(
      "metadata_changes" in removed && removed.metadata_changes?.some((item) => item.path === "locks/pnpm-lock.yaml"),
    ).toBe(true);
  },
  60000,
);
test("native pnpm shared workspace destination waits for its canonical write lease", async () => {
  const { root, project } = await fixture();
  const other = join(root, "other");
  await mkdir(other);
  await writeFile(join(other, "package.json"), '{"name":"other","packageManager":"pnpm@10.20.0"}');
  for (const directory of [project, other]) {
    await writeFile(join(directory, "pnpm-workspace.yaml"), "packages: []\nvirtualStoreDir: ../shared\n");
  }
  const structure = await inspectProject({ root });
  const projects = structure.projects.filter((item) => item.path === "project" || item.path === "other");
  expect(projects).toHaveLength(2);
  for (const selected of projects) {
    const resolved = await resolveManagerScope(root, selected, structure.projects);
    expect(resolved.domains).toContain(`write:${join(root, "shared")}`);
  }
  await servicePath(root);
  let acquired!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const lease = withDomains([`write:${join(root, "shared")}`], undefined, async () => {
    acquired();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await ready;
  const pending = executeDependency(
    root,
    "add",
    {
      project_id: "javascript:project/package.json",
      group: { kind: "runtime" },
      packages: [{ name: "local", source: { kind: "path", path: "project/local" } }],
    },
    { pnpm: pnpmAdapter },
  );
  try {
    await Bun.sleep(150);
    await expect(readFile(join(project, "pnpm-lock.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    release();
    await lease;
  }
  expect((await pending).outcome).toBe("success");
  expect(await readdir(join(root, "shared"))).not.toHaveLength(0);
});
test.each([
  ["system npmrc", "external"],
  ["pnpm global rc", "external"],
  ["system npmrc", "in-root"],
  ["pnpm global rc", "in-root"],
])("native %s %s redirects are rejected before mutation", async (kind, destinationKind) => {
  const { root, project } = await fixture();
  process.env.PREFIX = join(root, "system");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  delete process.env.NPM_CONFIG_GLOBALCONFIG;
  delete process.env.npm_config_globalconfig;
  delete process.env.npm_config_userconfig;
  process.env.NPM_CONFIG_USERCONFIG = join(root, "empty-user.npmrc");
  await writeFile(process.env.NPM_CONFIG_USERCONFIG, "");
  const path = kind === "system npmrc" ? join(root, "system/etc/npmrc") : join(root, "config/pnpm/rc");
  await mkdir(dirname(path), { recursive: true });
  const prefix = destinationKind === "external" ? "../" : "./";
  await writeFile(
    path,
    `modules-dir=${prefix}outside-modules\nvirtual-store-dir=${prefix}outside-store\nlockfile-dir=${prefix}outside-lock\n`,
  );
  // The service must discover these locations through its native config query.
  await servicePath(root);
  const added = await executeDependency(
    project,
    "add",
    {
      project_id: "javascript:package.json",
      group: { kind: "runtime" },
      packages: [{ name: "local", source: { kind: "path", path: "local" } }],
    },
    { pnpm: pnpmAdapter },
  );
  expect(added.outcome, JSON.stringify(added)).toBe("rejected");
  expect(added.diagnostics[0]?.code).toBe(destinationKind === "external" ? "outside-root" : "unsupported-config");
  expect("native_steps" in added).toBe(false);
  for (const destination of ["outside-modules", "outside-store", "outside-lock"]) {
    await expect(readdir(join(destinationKind === "external" ? root : project, destination))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
  await expect(readFile(join(project, "pnpm-lock.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(join(project, "package.json"), "utf8")).dependencies).toBeUndefined();
});
