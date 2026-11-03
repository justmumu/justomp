import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitText } from "../../../src/precommit/git";
import { inspectReleaseRepository } from "../../../src/release/repository";

test("release inspection uses the Git root and excludes nested repositories and unsafe release paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-release-scope-"));
  try {
    await gitText(root, ["init", "--quiet"]);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "root", version: "1.0.0", packageManager: "npm@11.0.0" }),
    );
    await mkdir(join(root, "src"));
    await mkdir(join(root, "vendor"));
    await gitText(join(root, "vendor"), ["init", "--quiet"]);
    await writeFile(join(root, "vendor/package.json"), "invalid nested metadata");
    await mkdir(join(root, "submodule"));
    await writeFile(join(root, "submodule/package.json"), "invalid submodule metadata");
    await gitText(root, ["update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},submodule`]);
    const repository = await inspectReleaseRepository(join(root, "src"));
    expect(repository.git.root).toBe(root.replace(/^\/var\//, "/private/var/"));
    expect(repository.participants.map((participant) => participant.manifest)).toEqual(["package.json"]);
    expect(repository.excluded).toContain("vendor");
    expect(repository.excluded).toContain("submodule");
    expect(await Bun.file(join(root, ".justomp/config.json")).exists()).toBe(false);
    expect(await Bun.file(join(root, ".justomp/packaging_structure.json")).exists()).toBe(false);
    await mkdir(join(root, ".private/nested"), { recursive: true });
    await gitText(join(root, ".private/nested"), ["init", "--quiet"]);
    await mkdir(join(root, ".justomp"));
    await writeFile(
      join(root, ".justomp/config.json"),
      JSON.stringify({
        release: { changelog_file: ".private/nested/CHANGELOG.md" },
      }),
    );
    await expect(inspectReleaseRepository(root)).rejects.toMatchObject({ code: "unsafe-release-path" });
    await writeFile(
      join(root, ".justomp/config.json"),
      JSON.stringify({
        release: { changelog_file: "VENDOR/CHANGELOG.md" },
      }),
    );
    await expect(inspectReleaseRepository(root)).rejects.toMatchObject({ code: "unsafe-release-path" });
    await rm(join(root, ".justomp/config.json"));
    await symlink("package.json", join(root, "VERSION"));
    await expect(inspectReleaseRepository(root)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
