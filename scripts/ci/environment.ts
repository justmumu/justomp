import { join } from "node:path";
import { type ProcessResult } from "../../src/dependencies/model";
import fixtureVersions from "../../tests/fixtures/dependencies/manager-versions.json";

export interface VersionProbe {
  name: string;
  executable: string;
  args: string[];
  expected: string;
}

export function typecheckYarnVersion(source: string): string {
  const version = /manifest\.packageManager = "yarn@(\d+\.\d+\.\d+)"/.exec(source)?.[1];
  if (!version) {
    throw new Error("Cannot read the typecheck Yarn version from its fixture");
  }
  return version;
}

export function planEnvironment(runnerTemp: string, typecheckYarn: string) {
  const versions = fixtureVersions.managers;
  const tools = join(runnerTemp, "justomp-tools");
  const downloads = join(runnerTemp, "justomp-downloads");
  const prefixes = {
    npm: join(tools, "npm"),
    managers: join(tools, "managers"),
    modern: join(tools, "yarn-modern"),
    typecheck: join(tools, "yarn-typecheck"),
  };
  const npm = join(prefixes.npm, "node_modules/npm/bin/npm-cli.js");
  const env = {
    JUSTOMP_PNPM_BINARY: join(prefixes.managers, "node_modules/pnpm/bin/pnpm.cjs"),
    JUSTOMP_YARN_CLASSIC_BINARY: join(prefixes.managers, "node_modules/yarn/bin/yarn.js"),
    JUSTOMP_YARN_MODERN_BINARY: join(prefixes.modern, "node_modules/@yarnpkg/cli-dist/bin/yarn.js"),
    JUSTOMP_TYPECHECK_YARN_MODERN_BINARY: join(prefixes.typecheck, "node_modules/@yarnpkg/cli-dist/bin/yarn.js"),
    // User config supplies defaults below fixture-local .npmrc settings. Environment
    // cache/store-dir overrides would defeat the fake registries' isolated stores.
    NPM_CONFIG_USERCONFIG: join(tools, "npmrc"),
    YARN_CACHE_FOLDER: join(downloads, "yarn"),
    BUN_INSTALL_CACHE_DIR: join(downloads, "bun"),
    UV_CACHE_DIR: join(downloads, "uv"),
    UV_PYTHON_DOWNLOADS: "never",
    GOTOOLCHAIN: "local",
    GOPATH: join(tools, "go"),
    GOMODCACHE: join(tools, "go-mod"),
    GOCACHE: join(tools, "go-build"),
  };
  const probes: VersionProbe[] = [
    { name: "bun", executable: "bun", args: ["--version"], expected: versions.bun },
    { name: "node", executable: "node", args: ["--version"], expected: "26.0.0" },
    { name: "python", executable: "python3", args: ["--version"], expected: "3.13.13" },
    { name: "uv", executable: "uv", args: ["--version"], expected: versions.uv },
    { name: "go", executable: "go", args: ["version"], expected: versions.go },
    { name: "npm", executable: "node", args: [npm, "--version"], expected: versions.npm },
    { name: "pnpm", executable: "node", args: [env.JUSTOMP_PNPM_BINARY, "--version"], expected: versions.pnpm },
    {
      name: "yarn-classic",
      executable: "node",
      args: [env.JUSTOMP_YARN_CLASSIC_BINARY, "--version"],
      expected: versions["yarn-classic"],
    },
    {
      name: "yarn-modern",
      executable: "node",
      args: [env.JUSTOMP_YARN_MODERN_BINARY, "--version"],
      expected: versions["yarn-modern"],
    },
    {
      name: "yarn-typecheck",
      executable: "node",
      args: [env.JUSTOMP_TYPECHECK_YARN_MODERN_BINARY, "--version"],
      expected: typecheckYarn,
    },
  ];
  return {
    tools,
    downloads,
    env,
    probes,
    npm,
    diagnostics: join(runnerTemp, "justomp-ci"),
    path: [join(prefixes.npm, "node_modules/.bin"), join(prefixes.managers, "node_modules/.bin")],
    npmrc: `cache=${join(downloads, "npm")}\nstore-dir=${join(downloads, "pnpm")}\n`,
    installs: [
      { prefix: prefixes.npm, packages: [`npm@${versions.npm}`] },
      { prefix: prefixes.managers, packages: [`pnpm@${versions.pnpm}`, `yarn@${versions["yarn-classic"]}`] },
      { prefix: prefixes.modern, packages: [`@yarnpkg/cli-dist@${versions["yarn-modern"]}`] },
      { prefix: prefixes.typecheck, packages: [`@yarnpkg/cli-dist@${typecheckYarn}`] },
    ],
  };
}

export function verifyVersion(probe: Pick<VersionProbe, "name" | "expected">, result: ProcessResult): string {
  let version = result.stdout.trim();
  switch (probe.name) {
    case "node":
      version = version.replace(/^v/, "");
      break;
    case "python":
      version = version.replace(/^Python /, "");
      break;
    case "uv":
      version = /^uv (\S+)/.exec(version)?.[1] ?? "";
      break;
    case "go":
      version = /^go version go(\S+) /.exec(version)?.[1] ?? "";
      break;
  }
  if (result.exit_code !== 0 || result.cancelled || result.truncated || version !== probe.expected) {
    throw new Error(`${probe.name} requires ${probe.expected}; measured ${version || "no version"}. ${result.stderr}`);
  }
  return version;
}
