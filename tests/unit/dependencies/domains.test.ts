import { expect, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import { resolveManagerScope } from "../../../src/dependencies/executable";
import * as paths from "../../../src/dependencies/paths";
import { memoryContext } from "./memory";

for (const [manager, config, contents] of [
  ["pnpm", ".npmrc", "modules-dir=../shared"],
  ["pnpm", ".npmrc", "virtual-store-dir=../shared"],
  ["pnpm", ".npmrc", "lockfile-dir=../shared"],
  ["pnpm", "pnpm-workspace.yaml", "modulesDir: ../shared"],
  ["pnpm", "pnpm-workspace.yaml", "virtualStoreDir: ../shared"],
  ["pnpm", "pnpm-workspace.yaml", "lockfileDir: ../shared"],
  ["yarn", ".yarnrc.yml", "installStatePath: ../shared"],
  ["yarn", ".yarnrc.yml", "pnpUnpluggedFolder: ../shared"],
] as const)
  test(`${manager} maps ${config} redirect into its write domain: ${contents}`, async () => {
    const f = memoryContext({
      manager,
      managerCandidates: [manager],
      path: "app",
      managerRoot: "app",
      manifest: "app/package.json",
    });
    const safe = spyOn(paths, "safePath").mockImplementation(
      async (root, path) => resolve(root, path),
    );
    const canonical = spyOn(paths, "canonicalWritePath").mockImplementation(
      async (root, path) => resolve(root, path),
    );
    try {
      f.write(`app/${config}`, contents);
      const result = await resolveManagerScope(f.root, f.context.project);
      expect(result.domains).toContain(`write:${f.root}/shared`);
      expect(canonical).toHaveBeenCalledWith(f.root, `${f.root}/shared`);
    } finally {
      canonical.mockRestore();
      safe.mockRestore();
      f.close();
    }
  });
