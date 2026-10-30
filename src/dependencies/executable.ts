import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import type { Project } from "../inspect/model";
import { object } from "./inventory";
import { DependencyError } from "./model";
import { canonicalWritePath, safePath } from "./paths";
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
// uv's required-version uses PEP 440, notably != and compatible-release ~=.
// Unknown forms fail explicitly instead of being misread as npm semver.
export function uvRequirement(version: string, requirement: string): boolean {
  const actual = version.split(".").map(Number);
  const compare = (wanted: number[]) => {
    for (let i = 0; i < Math.max(actual.length, wanted.length); i++) {
      const difference = (actual[i] ?? 0) - (wanted[i] ?? 0);
      if (difference) return Math.sign(difference);
    }
    return 0;
  };
  return requirement.split(",").every((clause) => {
    const match = /^(===|==|!=|~=|<=|>=|<|>)\s*(\d+(?:\.\d+)*)(\.\*)?$/.exec(
      clause.trim(),
    );
    if (!match?.[2])
      throw new DependencyError(
        "unsupported-manager-requirement",
        "uv manager requirements currently support numeric release specifiers and equality wildcards",
      );
    const wanted = match[2].split(".").map(Number),
      comparison = compare(wanted);
    if (match[3]) {
      if (match[1] !== "==" && match[1] !== "!=")
        throw new DependencyError(
          "unsupported-manager-requirement",
          "Wildcard manager versions require == or !=",
        );
      const equal = wanted.every((value, index) => actual[index] === value);
      return match[1] === "==" ? equal : !equal;
    }
    switch (match[1]) {
      case "===":
        return version === match[2];
      case "==":
        return comparison === 0;
      case "!=":
        return comparison !== 0;
      case "<=":
        return comparison <= 0;
      case ">=":
        return comparison >= 0;
      case "<":
        return comparison < 0;
      case ">":
        return comparison > 0;
      case "~=": {
        if (wanted.length < 2)
          throw new DependencyError(
            "unsupported-manager-requirement",
            "Compatible-release manager versions need at least two components",
          );
        const upper = wanted.slice(0, -1);
        upper[upper.length - 1] = (upper.at(-1) ?? 0) + 1;
        return comparison >= 0 && compare(upper) < 0;
      }
      default:
        return false;
    }
  });
}
const pnpmScopeKeys = [
  "modules-dir",
  "virtual-store-dir",
  "lockfile-dir",
  "shared-workspace-lockfile",
  "git-branch-lockfile",
] as const;

// pnpm 10 reads project .npmrc above workspace .npmrc, then applies workspace
// YAML above both (and above environment settings). Do not treat INI strings
// containing quotes or interpolation as literal filesystem paths.
export async function pnpmDirectories(cwd: string, owner: string) {
  const environment = Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => /^npm_config_/i.test(key))
      .map(([key, value]) => [
        key.slice(11).toLowerCase().replaceAll("_", "-"),
        value,
      ]),
  );
  const files = new Set([
    ...(typeof environment.globalconfig === "string"
      ? [environment.globalconfig]
      : []),
    typeof environment.userconfig === "string"
      ? environment.userconfig
      : join(homedir(), ".npmrc"),
    join(owner, ".npmrc"),
    join(cwd, ".npmrc"),
  ]);
  const settings: Record<string, unknown> = {};
  for (const file of files) mergePnpmRc(settings, await readOptional(file));
  const workspace = await readOptional(join(owner, "pnpm-workspace.yaml"));
  return resolvePnpmDirectories(cwd, owner, settings, environment, workspace);
}
export function parsePnpmDirectories(
  cwd: string,
  owner: string,
  texts: readonly (string | undefined)[],
  environment: Record<string, unknown>,
  workspace?: string,
) {
  const settings: Record<string, unknown> = {};
  for (const text of texts) mergePnpmRc(settings, text);
  return resolvePnpmDirectories(cwd, owner, settings, environment, workspace);
}
function mergePnpmRc(
  settings: Record<string, unknown>,
  text: string | undefined,
): void {
  let section = false;
  for (const line of text?.split("\n") ?? []) {
    if (/^\s*[#;]/.test(line)) continue;
    if (/^\s*\[/.test(line)) section = true;
    const match = /^\s*([^=]+?)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match?.[1]) continue;
    const key = match[1];
    const normalized = key.replace(/["'[\]]/g, "");
    if (!pnpmScopeKeys.some((field) => field === normalized)) continue;
    if (section || key !== normalized)
      throw new DependencyError(
        "unsupported-config",
        "Scoped pnpm destination settings require plain INI keys outside sections",
      );
    settings[key] = match[2];
  }
}
function resolvePnpmDirectories(
  cwd: string,
  owner: string,
  settings: Record<string, unknown>,
  environment: Record<string, unknown>,
  workspace?: string,
) {
  for (const key of pnpmScopeKeys)
    if (environment[key] !== undefined) settings[key] = environment[key];
  if (workspace !== undefined) {
    const doc = parseDocument(workspace);
    if (doc.errors.length)
      throw new DependencyError(
        "invalid-config",
        "Invalid pnpm-workspace.yaml",
      );
    const values = object(doc.toJS());
    if (Object.keys(values).some((key) => key.includes("${")))
      throw new DependencyError(
        "unsupported-config",
        "Interpolated pnpm workspace configuration keys are unsupported",
      );
    for (const key of pnpmScopeKeys) {
      const camel = key.replace(/-([a-z])/g, (_, letter: string) =>
        letter.toUpperCase(),
      );
      if (values[camel] !== undefined) settings[key] = values[camel];
    }
  }
  return pnpmDirectoryValues(cwd, owner, settings);
}
function pnpmDirectoryValues(
  cwd: string,
  owner: string,
  settings: Record<string, unknown>,
) {
  for (const key of ["shared-workspace-lockfile", "git-branch-lockfile"]) {
    const value = settings[key];
    if (
      value !== undefined &&
      value !== true &&
      value !== false &&
      value !== "true" &&
      value !== "false"
    )
      throw new DependencyError(
        "unsupported-config",
        `pnpm ${key} requires a plain boolean`,
      );
  }
  if (
    settings["shared-workspace-lockfile"] === false ||
    settings["shared-workspace-lockfile"] === "false" ||
    settings["git-branch-lockfile"] === true ||
    settings["git-branch-lockfile"] === "true"
  )
    throw new DependencyError(
      "unsupported-config",
      "Scoped pnpm operations require a shared, non-branch lockfile",
    );
  const directory = (key: string, fallback: string) => {
    const value = settings[key];
    if (value === undefined) return fallback;
    if (
      typeof value !== "string" ||
      !value ||
      /[\s"'$`;#\\]/.test(value) ||
      value.startsWith("~")
    )
      throw new DependencyError(
        "unsupported-config",
        `pnpm ${key} requires a plain literal directory without quotes, interpolation or escapes`,
      );
    return value;
  };
  const lockDirectory = resolve(cwd, directory("lockfile-dir", owner));
  const modulesDirectory = directory("modules-dir", "node_modules");
  const virtualStoreDirectory = resolve(
    lockDirectory,
    directory("virtual-store-dir", join(modulesDirectory, ".pnpm")),
  );
  // pnpm's single-importer path defaults to node_modules/.pnpm even with a
  // custom modulesDir; its multi-importer path defaults below modulesDir.
  const virtualStoreDirectories =
    settings["virtual-store-dir"] === undefined
      ? [
          ...new Set([
            virtualStoreDirectory,
            join(lockDirectory, "node_modules", ".pnpm"),
          ]),
        ]
      : [virtualStoreDirectory];
  return {
    lockDirectory,
    modulesDirectory,
    virtualStoreDirectory,
    virtualStoreDirectories,
  };
}
export async function resolveManagerScope(
  root: string,
  project: Project,
  projects: readonly Project[] = [project],
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
  const domains = new Set<string>();
  let pnpm:
    | (Awaited<ReturnType<typeof pnpmDirectories>> & {
        memberDirectories: string[];
      })
    | undefined;
  const writePath = async (path: string) => {
    domains.add(`write:${await canonicalWritePath(root, path)}`);
  };
  await writePath(owner);
  if (manager === "uv")
    await writePath(resolve(owner, env.UV_PROJECT_ENVIRONMENT || ".venv"));
  if (["npm", "yarn", "bun"].includes(manager))
    await writePath(join(owner, "node_modules"));
  if (manager === "pnpm") {
    const paths = await pnpmDirectories(cwd, owner);
    await writePath(paths.lockDirectory);
    await writePath(join(paths.lockDirectory, "pnpm-lock.yaml"));
    for (const directory of paths.virtualStoreDirectories)
      await writePath(directory);
    const memberDirectories = [
      ...new Set([
        cwd,
        owner,
        ...projects
          .filter(
            (member) =>
              member.ecosystem === "javascript" &&
              member.managerRoot === project.managerRoot,
          )
          .map((member) => resolve(root, member.path)),
      ]),
    ];
    pnpm = { ...paths, memberDirectories };
    // pnpm writes a modules area beside its lock and relative to every member.
    for (const directory of new Set([
      paths.lockDirectory,
      ...memberDirectories,
    ])) {
      // Native pnpm uses join. Resolve additionally rejects absolute external
      // settings conservatively instead of interpreting them as nested paths.
      await writePath(resolve(directory, paths.modulesDirectory));
      await writePath(join(directory, paths.modulesDirectory));
    }
  }
  if (manager === "yarn") {
    await writePath(join(owner, ".yarn", "unplugged"));
    await writePath(join(owner, ".yarn", "install-state.gz"));
  }
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
      if (match?.[2] && (manager !== "pnpm" || match[1] === "prefix"))
        await writePath(resolve(directory, match[2]));
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
        if (typeof values[field] === "string") {
          const path = resolve(directory, values[field]);
          if (field === "yarnPath") await safePath(root, path);
          else await writePath(path);
        }
    }
  }
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
  return { manager, cwd, owner, env, domains: [...domains].sort(), pnpm };
}
// Call only under the scope's acquired lease, after the installed-version probe.
// Native config contains credentials: never return or interpolate its output.
export async function validatePnpmNativeScope(
  root: string,
  scope: Awaited<ReturnType<typeof resolveManagerScope>>,
  command: string,
  signal?: AbortSignal,
): Promise<void> {
  const modeled = scope.pnpm;
  if (!modeled) return;
  const result = await runProcess(
    command,
    [
      "config",
      "list",
      "--json",
      "--config.manage-package-manager-versions=false",
    ],
    { cwd: scope.cwd, env: scope.env, signal },
  );
  signal?.throwIfAborted();
  if (result.exit_code !== 0 || result.truncated)
    throw new DependencyError(
      "unsupported-config",
      "Could not safely read effective pnpm configuration",
    );
  let values: Record<string, unknown>;
  try {
    values = object(JSON.parse(result.stdout));
  } catch {
    throw new DependencyError(
      "unsupported-config",
      "Could not safely read effective pnpm configuration",
    );
  }
  if (values.global === true || values.global === "true")
    throw new DependencyError(
      "unsupported-config",
      "Global pnpm operations cannot use a project-scoped dependency tool",
    );
  if (
    typeof values.dir === "string" &&
    resolve(scope.cwd, values.dir) !== scope.cwd
  ) {
    await canonicalWritePath(root, resolve(scope.cwd, values.dir));
    throw new DependencyError(
      "unsupported-config",
      "Effective pnpm working directory differs from the selected project",
    );
  }
  const native = pnpmDirectoryValues(scope.cwd, scope.owner, values);
  const canonical = async (paths: ReturnType<typeof pnpmDirectoryValues>) => {
    const modules = [];
    for (const directory of new Set([
      paths.lockDirectory,
      ...modeled.memberDirectories,
    ])) {
      modules.push(
        await canonicalWritePath(
          root,
          resolve(directory, paths.modulesDirectory),
        ),
      );
      modules.push(
        await canonicalWritePath(root, join(directory, paths.modulesDirectory)),
      );
    }
    return {
      lock: await canonicalWritePath(root, paths.lockDirectory),
      lockfile: await canonicalWritePath(
        root,
        join(paths.lockDirectory, "pnpm-lock.yaml"),
      ),
      virtual: [
        ...new Set(
          await Promise.all(
            paths.virtualStoreDirectories.map((path) =>
              canonicalWritePath(root, path),
            ),
          ),
        ),
      ].sort(),
      modules: [...new Set(modules)].sort(),
    };
  };
  // Validate native destinations first, even when they are absent from the
  // static model, so outside-root reports identify the actual boundary failure.
  const actual = await canonical(native);
  if (JSON.stringify(actual) !== JSON.stringify(await canonical(modeled)))
    throw new DependencyError(
      "unsupported-config",
      "Effective pnpm configuration differs from the validated project scope; declare destination settings in project configuration",
    );
}

export async function resolveExecutable(
  root: string,
  project: Project,
  signal?: AbortSignal,
  scope?: Awaited<ReturnType<typeof resolveManagerScope>>,
) {
  const { manager, cwd, owner, env } =
    scope ?? (await resolveManagerScope(root, project));
  const command = Bun.which(manager, { PATH: env.PATH });
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
  if (
    requirement &&
    !(manager === "uv"
      ? uvRequirement(version, requirement)
      : Bun.semver.satisfies(version, requirement))
  )
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
