import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { runProcess } from "../../src/dependencies/runner";
import { createSandboxCommand } from "../../src/protection/sandbox";
import { planEnvironment, typecheckYarnVersion, verifyVersion } from "./environment";

type Plan = ReturnType<typeof planEnvironment>;

async function configure(plan: Plan): Promise<void> {
  const githubEnv = process.env.GITHUB_ENV;
  const githubPath = process.env.GITHUB_PATH;
  if (!githubEnv || !githubPath) {
    throw new Error("CI setup requires GITHUB_ENV and GITHUB_PATH");
  }
  await Promise.all([plan.tools, plan.downloads, plan.diagnostics].map((path) => mkdir(path, { recursive: true })));
  await writeFile(plan.env.NPM_CONFIG_USERCONFIG, plan.npmrc);
  await appendFile(
    githubEnv,
    `${Object.entries(plan.env)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n")}\n`,
  );
  await appendFile(githubPath, `${plan.path.join("\n")}\n`);
  Object.assign(process.env, plan.env);
  process.env.PATH = [...plan.path, process.env.PATH ?? ""].join(delimiter);
}

async function installManagers(plan: Plan, cwd: string, signal: AbortSignal): Promise<void> {
  for (const [index, install] of plan.installs.entries()) {
    const args = [
      "install",
      "--prefix",
      install.prefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...install.packages,
    ];
    const result = await runProcess(index === 0 ? "npm" : "node", index === 0 ? args : [plan.npm, ...args], {
      cwd,
      signal,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.exit_code !== 0 || result.cancelled) {
      throw new Error(`CI manager installation failed: ${install.packages.join(", ")}`);
    }
  }
}

async function sandboxPreflight(cwd: string, signal: AbortSignal): Promise<void> {
  const target = join(cwd, "protected");
  await writeFile(target, "original");
  const sandbox = await createSandboxCommand({
    command:
      'printf source > writable; if (printf changed > protected) 2>/dev/null; then exit 1; fi; test "$(cat protected)" = original',
    cwd,
    protectedPaths: [target],
    signal,
  });
  try {
    const [executable, ...args] = sandbox.argv;
    if (!executable) {
      throw new Error("Sandbox preflight has no executable");
    }
    const result = await runProcess(executable, args, { cwd, env: sandbox.env, signal });
    if (
      result.exit_code !== 0 ||
      result.cancelled ||
      result.truncated ||
      (await readFile(target, "utf8")) !== "original" ||
      (await readFile(join(cwd, "writable"), "utf8")) !== "source"
    ) {
      throw new Error(`Native sandbox capability preflight failed: ${result.stderr}`);
    }
  } finally {
    await sandbox.cleanup();
  }
}

async function verifyUtilities(cwd: string, signal: AbortSignal): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};
  for (const [command, args] of [
    ["git", ["--version"]],
    ["bash", ["--version"]],
    ["tar", ["--version"]],
    ["python3", ["-c", "import zipfile; print('zipfile available')"]],
  ] as const) {
    const result = await runProcess(command, [...args], { cwd, signal });
    if (result.exit_code !== 0 || result.cancelled || result.truncated) {
      throw new Error(`Required utility ${command} failed: ${result.stderr}`);
    }
    versions[command] = result.stdout.trim().split("\n")[0] ?? "";
  }
  return versions;
}

async function provision(plan: Plan, signal: AbortSignal): Promise<void> {
  // Probe outside the checkout: pnpm and Yarn reject a foreign packageManager.
  const neutral = await realpath(await mkdtemp(join(plan.tools, "preflight-")));
  const started = performance.now();
  const report = {
    platform: process.platform,
    architecture: process.arch,
    runner_image: process.env.ImageOS ?? null,
    runner_image_version: process.env.ImageVersion ?? null,
    versions: {} as Record<string, string>,
    utilities: {} as Record<string, string>,
    launchers: {
      pnpm: plan.env.JUSTOMP_PNPM_BINARY,
      yarn_classic: plan.env.JUSTOMP_YARN_CLASSIC_BINARY,
      yarn_modern: plan.env.JUSTOMP_YARN_MODERN_BINARY,
      yarn_typecheck: plan.env.JUSTOMP_TYPECHECK_YARN_MODERN_BINARY,
    },
    sandbox: false,
    complete: false,
    error: null as string | null,
    duration_ms: 0,
  };
  try {
    await installManagers(plan, neutral, signal);
    for (const probe of plan.probes) {
      const result = await runProcess(probe.executable, probe.args, { cwd: neutral, signal });
      report.versions[probe.name] = verifyVersion(probe, result);
    }
    report.utilities = await verifyUtilities(neutral, signal);
    await sandboxPreflight(neutral, signal);
    report.sandbox = true;
    report.complete = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    report.duration_ms = performance.now() - started;
    // Deliberately enumerate evidence; never serialize process.env or a fixture tree.
    await writeFile(join(plan.diagnostics, "environment.json"), `${JSON.stringify(report, null, 2)}\n`);
    await rm(neutral, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp) {
    throw new Error("CI setup requires RUNNER_TEMP");
  }
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "configure")) {
    throw new Error("Usage: bun scripts/ci/setup.ts [configure]");
  }
  const fixture = await readFile(
    resolve(import.meta.dir, "../../tests/fixtures/typecheck/javascript/fixture.ts"),
    "utf8",
  );
  const plan = planEnvironment(runnerTemp, typecheckYarnVersion(fixture));
  await configure(plan);
  if (args[0] === "configure") {
    return;
  }
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("CI environment setup cancelled"));
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    await provision(plan, controller.signal);
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
