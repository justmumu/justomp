import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import type { Project } from "../inspect/model";
import { object } from "./inventory";
import { DependencyError } from "./model";
import { safePath } from "./paths";
import { runProcess } from "./runner";
export function managerEnvironment(
  manager: string,
  owner: string,
): Record<string, string | undefined> {
  return {
    ...process.env,
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_DEFAULT_TO_LATEST: "0",
    COREPACK_ENABLE_AUTO_PIN: "0",
    COREPACK_ENABLE_PROJECT_SPEC: "1",
    npm_config_manage_package_manager_versions: "false",
    npm_config_global: "false",
    UV_PYTHON_DOWNLOADS: "never",
    UV_WORKING_DIR: owner,
    GOTOOLCHAIN: "local",
    GOWORK: manager === "go" ? "off" : process.env.GOWORK,
  };
}
export async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
export async function resolveExecutable(
  root: string,
  project: Project,
  signal?: AbortSignal,
) {
  const manager = project.manager;
  if (
    !manager ||
    !["uv", "npm", "pnpm", "yarn", "bun", "go"].includes(manager) ||
    project.status === "ambiguous"
  )
    throw new DependencyError(
      "unsupported-manager",
      "Inspection must identify one supported package manager",
    );
  const cwd = await safePath(root, project.path),
    owner = await safePath(root, project.managerRoot);
  const env = managerEnvironment(manager, owner);
  if (manager === "uv") env.UV_PROJECT = cwd;
  if (manager === "go")
    env.GOWORK =
      (await readOptional(join(owner, "go.work"))) !== undefined
        ? join(owner, "go.work")
        : "off";
  // Check scope-affecting project configuration on every request, including hidden files.
  for (const directory of new Set([cwd, owner])) {
    const npmrc = await readOptional(join(directory, ".npmrc"));
    for (const line of npmrc?.split("\n") ?? []) {
      const match =
        /^\s*(prefix|lockfile-dir|modules-dir|virtual-store-dir)\s*=\s*(.+?)\s*$/.exec(
          line,
        );
      if (match?.[2]) await safePath(root, resolve(directory, match[2]));
    }
    const yarnrc = await readOptional(join(directory, ".yarnrc.yml"));
    if (yarnrc) {
      const doc = parseDocument(yarnrc);
      if (doc.errors.length)
        throw new DependencyError("invalid-config", "Invalid .yarnrc.yml");
      const values = object(doc.toJS());
      for (const field of [
        "yarnPath",
        "pnpUnpluggedFolder",
        "installStatePath",
        "lockfileFilename",
      ])
        if (typeof values[field] === "string")
          await safePath(root, resolve(directory, values[field]));
    }
  }
  if (manager === "uv" && env.UV_PROJECT_ENVIRONMENT)
    await safePath(root, resolve(owner, env.UV_PROJECT_ENVIRONMENT));
  if (
    manager === "go" &&
    /(?:^|\s)-(?:modfile|overlay)(?:=|\s)/.test(env.GOFLAGS ?? "")
  )
    throw new DependencyError(
      "unsupported-config",
      "Go metadata redirection cannot be used by scoped dependency tools",
    );
  // Native workspace discovery must not silently select an ancestor outside this root.
  for (
    let parent = dirname(root);
    parent !== dirname(parent);
    parent = dirname(parent)
  ) {
    const marker =
      manager === "uv"
        ? "pyproject.toml"
        : manager === "pnpm"
          ? "pnpm-workspace.yaml"
          : manager === "go"
            ? "go.work"
            : "package.json";
    const text = await readOptional(join(parent, marker));
    if (
      manager !== "go" &&
      text &&
      (marker === "pnpm-workspace.yaml" ||
        /workspaces|\[tool\.uv\.workspace\]/.test(text))
    )
      throw new DependencyError(
        "outside-root",
        "A native workspace ancestor exists outside the inspection root; select the workspace root",
      );
  }
  const command = Bun.which(manager);
  if (!command)
    throw new DependencyError(
      "manager-unavailable",
      `${manager} is not installed; install it explicitly`,
    );
  const probe = await runProcess(
    command,
    manager === "go" ? ["version"] : ["--version"],
    { cwd, env, signal, limit: 4096 },
  );
  const version = /(?:^|\s)(?:go)?(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)/.exec(
    probe.stdout,
  )?.[1];
  if (probe.exit_code !== 0 || !version)
    throw new DependencyError(
      "manager-unavailable",
      `${manager} could not report an installed version; automatic bootstrap is disabled`,
    );
  const requirement = project.managerVersion?.split("+sha")[0];
  if (requirement && !Bun.semver.satisfies(version, requirement))
    throw new DependencyError(
      "manager-version-mismatch",
      `${manager} ${version} does not satisfy ${requirement}`,
    );
  const supported: Record<string, string> = {
    uv: ">=0.11.0 <0.12.0",
    npm: ">=11.0.0 <12.0.0",
    pnpm: ">=10.0.0 <11.0.0",
    yarn: ">=1.22.0 <2.0.0 || >=4.12.0 <5.0.0",
    bun: ">=1.4.0 <1.5.0",
    go: ">=1.25.0 <1.26.0",
  };
  if (!Bun.semver.satisfies(version, supported[manager] ?? ""))
    throw new DependencyError(
      "unsupported-manager-version",
      `${manager} ${version} is outside the tested adapter family`,
    );
  return { command, manager, version, cwd, owner, env };
}
