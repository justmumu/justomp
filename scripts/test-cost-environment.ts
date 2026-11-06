import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runProcess } from "../src/dependencies/runner";
import { BIOME_VERSION, RUFF_VERSION } from "../src/lint/toolchain";
export async function costEnvironment(root: string) {
  return {
    platform: `${process.platform}-${process.arch}`,
    bun: Bun.version,
    tool_versions: await nativeToolchain(),
    concurrency: concurrencyIdentity(process.env, availableParallelism()),
    native_test_config: await nativeTestConfig(root),
    executables: Object.fromEntries(["node", "npm", "pnpm", "yarn", "uv", "go"].map((name) => [name, Bun.which(name)])),
    yarn_launchers: {
      classic: process.env.JUSTOMP_YARN_CLASSIC_BINARY ?? null,
      modern: process.env.JUSTOMP_YARN_MODERN_BINARY ?? null,
      typecheck: process.env.JUSTOMP_TYPECHECK_YARN_MODERN_BINARY ?? null,
    },
    fixture_tool_pins: Object.fromEntries(
      await Promise.all(
        [
          "tests/fixtures/lint/javascript/fixture.ts",
          "tests/fixtures/lint/python/fixture.ts",
          "tests/fixtures/typecheck/javascript/fixture.ts",
          "tests/fixtures/typecheck/python/fixture.ts",
          "tests/fixtures/typecheck/generated/fixture.ts",
        ].map(async (path) => [
          path,
          [
            ...new Set(
              (
                (await readFile(resolve(root, path), "utf8")) +
                (path === "tests/fixtures/lint/javascript/fixture.ts"
                  ? `${await readFile(resolve(root, "tests/fixtures/lint/javascript/versions.ts"), "utf8")}\n${BIOME_VERSION}`
                  : path === "tests/fixtures/lint/python/fixture.ts"
                    ? RUFF_VERSION
                    : "")
              ).match(/\b\d+\.\d+\.\d+\b/g) ?? [],
            ),
          ].sort(),
        ]),
      ),
    ),
    fixtures: await Bun.file(resolve(root, "tests/fixtures/dependencies/manager-versions.json")).json(),
  };
}

export function concurrencyIdentity(env: NodeJS.ProcessEnv, cpus: number) {
  const controls = [
    "GOMAXPROCS",
    "UV_CONCURRENT_INSTALLS",
    "UV_CONCURRENT_DOWNLOADS",
    "UV_THREADPOOL_SIZE",
    "npm_config_jobs",
    "npm_config_child_concurrency",
    "npm_config_network_concurrency",
    "npm_config_maxsockets",
    "YARN_NETWORK_CONCURRENCY",
    "BUN_CONFIG_MAX_HTTP_REQUESTS",
  ];
  return {
    gate_lanes: 1,
    logical_cpus: cpus,
    environment: Object.fromEntries(controls.map((name) => [name, env[name] ?? null])),
    go_package_parallelism: env.GOFLAGS?.match(/(?:^|\s)-p(?:=|\s+)(\d+)/)?.[1] ?? null,
  };
}
async function nativeTestConfig(root: string): Promise<string | null> {
  try {
    return createHash("sha256")
      .update(await readFile(resolve(root, "bunfig.toml")))
      .digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
export async function nativeToolchain(env: NodeJS.ProcessEnv = process.env) {
  // Manager version commands can reject a foreign packageManager field in cwd.
  const root = await mkdtemp(join(tmpdir(), "justomp-cost-versions-"));
  try {
    return await collectNativeVersions(root, env);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function collectNativeVersions(root: string, env: NodeJS.ProcessEnv) {
  const tools = [
    ["node", Bun.which("node"), ["--version"]],
    ["npm", Bun.which("npm"), ["--version"]],
    ["pnpm", env.JUSTOMP_PNPM_BINARY ?? Bun.which("pnpm"), ["--version"]],
    ["yarn-classic", env.JUSTOMP_YARN_CLASSIC_BINARY ?? Bun.which("yarn"), ["--version"]],
    ["yarn-modern", env.JUSTOMP_YARN_MODERN_BINARY ?? null, ["--version"]],
    ["yarn-typecheck", env.JUSTOMP_TYPECHECK_YARN_MODERN_BINARY ?? null, ["--version"]],
    ["uv", Bun.which("uv"), ["--version"]],
    ["go", Bun.which("go"), ["version"]],
  ] as const;
  const versions = await Promise.all(
    tools.map(
      async ([name, executable, args]) =>
        [
          name,
          {
            executable,
            version: executable ? await toolVersion(name, executable, args, root, env) : null,
          },
        ] as const,
    ),
  );
  return Object.fromEntries(versions);
}
async function toolVersion(
  name: string,
  executable: string,
  args: readonly string[],
  root: string,
  env: NodeJS.ProcessEnv,
) {
  const useNode = name.startsWith("yarn") && /\.[cm]?js$/.test(executable);
  const result = await runProcess(
    useNode ? (Bun.which("node") ?? "node") : executable,
    useNode ? [executable, ...args] : [...args],
    { cwd: root, env },
  );
  if (result.exit_code !== 0 || result.cancelled || result.truncated || !result.stdout.trim()) {
    throw new Error(`Cannot measure ${name} version: ${result.stderr}`);
  }
  return result.stdout.trim();
}
