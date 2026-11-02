import { expect } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveManagerScope } from "../../../src/dependencies/executable";
import { runProcess } from "../../../src/dependencies/runner";
import { inspectProject } from "../../../src/inspect/scan";
export const roots: string[] = [];
export const cleanups: (() => Promise<void>)[] = [];
export const originalPath = process.env.PATH;
export const originalModules = process.env.npm_config_modules_dir;
export const isolatedEnvironment = Object.fromEntries(
  [
    "PREFIX",
    "XDG_CONFIG_HOME",
    "NPM_CONFIG_GLOBALCONFIG",
    "npm_config_globalconfig",
    "NPM_CONFIG_USERCONFIG",
    "npm_config_userconfig",
  ].map((key) => [key, process.env[key]]),
);
export async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "justomp-pnpm-config-")));
  roots.push(root);
  const project = join(root, "project");
  await mkdir(join(project, "local"), { recursive: true });
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({
      name: "app",
      private: true,
      packageManager: "pnpm@10.20.0",
    }),
  );
  await writeFile(join(project, "local/package.json"), JSON.stringify({ name: "local", version: "1.0.0" }));
  await writeFile(
    join(project, ".npmrc"),
    `offline=true\nignore-scripts=true\nmanage-package-manager-versions=false\nstore-dir=${join(root, "store")}\n`,
  );
  return { root, project };
}
export async function native(project: string, args: string[]) {
  const command = process.env.JUSTOMP_PNPM_BINARY ?? "pnpm";
  const result = await runProcess(command, args, {
    cwd: project,
    env: {
      ...process.env,
      CI: "true",
      COREPACK_ENABLE_NETWORK: "0",
      npm_config_manage_package_manager_versions: "false",
    },
  });
  expect(result.exit_code, `${result.stderr}\n${result.stdout}`).toBe(0);
  return result;
}
export async function servicePath(root: string) {
  const command = process.env.JUSTOMP_PNPM_BINARY ?? Bun.which("pnpm");
  if (!command) {
    throw new Error("Native pnpm fixture requires an installed binary");
  }
  await mkdir(join(root, "bin"));
  await symlink(command, join(root, "bin/pnpm"));
  process.env.PATH = `${join(root, "bin")}:${originalPath}`;
}
export async function scope(project: string, path = ".") {
  const structure = await inspectProject({ root: project });
  const selected = structure.projects.find((p) => p.path === path);
  if (!selected) {
    throw new Error(`Missing project ${path}`);
  }
  return resolveManagerScope(project, selected, structure.projects);
}
