import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInventory } from "../../../../src/dependencies/inventory";
import { type Adapter, type AdapterContext, type DependencyRequest } from "../../../../src/dependencies/model";
import { runProcess } from "../../../../src/dependencies/runner";
import { inspectProject } from "../../../../src/inspect/scan";
import { registryArchives } from "./registry-archives";

export type Variant = "classic" | "modern" | "bun";
export async function fixture(variant: Variant, workspace = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `justomp-u6-${variant}-`)));
  const home = join(root, ".fixture-home");
  await mkdir(home);
  const packages = await registryArchives("yarn");
  let latest = "1.0.0";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      const filename = url.pathname.split("/").at(-1) ?? "";
      const archive = packages.get(filename);
      if (archive) {
        return new Response(Buffer.from(archive));
      }
      const name = decodeURIComponent(url.pathname.slice(1));
      if (!["u6-dep", "u6-child", "u6-other"].includes(name)) {
        return new Response("missing", { status: 404 });
      }
      const versions = Object.fromEntries(
        ["1.0.0", "1.1.0", "2.0.0"]
          .filter((v) => v <= latest)
          .map((version) => [
            version,
            {
              name,
              version,
              ...(name === "u6-dep" ? { dependencies: { "u6-child": "1.0.0" } } : {}),
              dist: {
                shasum: createHash("sha1")
                  .update(packages.get(`${name}-${version}.tgz`) ?? Buffer.alloc(0))
                  .digest("hex"),
                tarball: `${url.origin}/${name}/-/${name}-${version}.tgz`,
              },
            },
          ]),
      );
      return Response.json({ name, "dist-tags": { latest }, versions });
    },
  });
  const registry = `http://127.0.0.1:${server.port}`;
  const manager = variant === "bun" ? "bun" : "yarn";
  const version = variant === "classic" ? "1.22.22" : variant === "modern" ? "4.12.0" : "1.4.2";
  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "fixture-root",
        private: true,
        version: "1.0.0",
        packageManager: `${manager}@${version}`,
        ...(workspace ? { workspaces: ["packages/*"] } : {}),
      },
      null,
      2,
    ),
  );
  if (workspace) {
    for (const name of ["a", "b"]) {
      await mkdir(join(root, "packages", name), { recursive: true });
      await writeFile(
        join(root, "packages", name, "package.json"),
        JSON.stringify({ name: `u6-${name}`, version: "1.0.0" }, null, 2),
      );
    }
  }
  await writeFile(join(root, ".npmrc"), `registry=${registry}\ncache=${home}/npm-cache\n`);
  await writeFile(join(root, ".yarnrc"), `registry "${registry}"\ncache-folder "${home}/yarn-cache"\n`);
  await writeFile(
    join(root, ".yarnrc.yml"),
    `npmRegistryServer: "${registry}"\nunsafeHttpWhitelist: [127.0.0.1]\nenableGlobalCache: false\nglobalFolder: "${home}/modern-global"\ncacheFolder: "${home}/modern-cache"\nenableTelemetry: false\n`,
  );
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    XDG_CONFIG_HOME: join(home, "config"),
    npm_config_userconfig: join(root, ".npmrc"),
    npm_config_cache: join(home, "npm-cache"),
    XDG_CACHE_HOME: join(home, "cache"),
    BUN_INSTALL_CACHE_DIR: join(home, "bun-cache"),
    YARN_IGNORE_PATH: "1",
    COREPACK_ENABLE_NETWORK: "0",
  };
  const binarySetting = variant === "classic" ? "JUSTOMP_YARN_CLASSIC_BINARY" : "JUSTOMP_YARN_MODERN_BINARY";
  const yarnBinary = process.env[binarySetting] ?? Bun.which("yarn");
  if (variant !== "bun" && !yarnBinary) {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
    throw new Error(`Set ${binarySetting} to the installed native Yarn ${version} launcher`);
  }
  const command =
    variant === "bun"
      ? process.execPath
      : yarnBinary?.endsWith(".js")
        ? (Bun.which("node") ?? "node")
        : (yarnBinary as string);
  const prefix = variant !== "bun" && yarnBinary?.endsWith(".js") ? [yarnBinary] : [];
  const detected = await runProcess(command, [...prefix, "--version"], {
    cwd: root,
    env,
  });
  if (detected.exit_code !== 0 || detected.stdout.trim() !== version) {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
    throw new Error(
      `Native ${variant} test requires ${version}; set ${binarySetting} to an installed launcher. ${detected.stdout} ${detected.stderr}`,
    );
  }
  async function context(member = workspace ? "packages/a" : "."): Promise<AdapterContext> {
    const structure = await inspectProject({ root });
    const project = structure.projects.find((p) => p.path === member);
    if (!project) {
      throw new Error(`fixture project ${member} missing`);
    }
    return {
      root,
      project,
      structure,
      cwd: join(root, member),
      owner: root,
      manager,
      version,
      run: (step) =>
        runProcess(command, [...prefix, ...step.args], {
          cwd: step.cwd ?? join(root, member),
          env: { ...env, ...step.env },
        }),
    };
  }
  async function operate(
    adapter: Adapter,
    request: Omit<Exclude<DependencyRequest, { operation: "list" }>, "project_id"> | Record<string, unknown>,
    member?: string,
  ) {
    const ctx = await context(member);
    const full = { ...request, project_id: ctx.project.project_id } as Exclude<
      DependencyRequest,
      { operation: "list" }
    >;
    const before = await readInventory(root, ctx.project);
    const plan = await adapter.plan(ctx, full, before);
    for (const step of plan.steps) {
      const result = await ctx.run(step);
      if (result.exit_code !== 0) {
        throw new Error(`${step.args.join(" ")}: ${result.stdout}\n${result.stderr}`);
      }
    }
    const after = await adapter.inventory(ctx, false);
    await adapter.verify?.(ctx, full, before, after);
    return { ctx, plan, after };
  }
  async function installed(name: string, member = workspace ? "packages/a" : ".") {
    const args = [
      Bun.which("node") ?? "node",
      ...(variant === "modern" ? ["--require", join(root, ".pnp.cjs")] : []),
      "-p",
      `require('module').createRequire(process.cwd() + '/package.json')(${JSON.stringify(`${name}/package.json`)}).version`,
    ];
    const result = await runProcess(args[0] as string, args.slice(1), {
      cwd: join(root, member),
      env,
    });
    if (result.exit_code !== 0) {
      throw new Error(result.stderr);
    }
    return result.stdout.trim();
  }
  return {
    root,
    home,
    registry,
    context,
    operate,
    installed,
    publish(version: string) {
      latest = version;
    },
    manifest: async (member = workspace ? "packages/a" : ".") =>
      JSON.parse(await readFile(join(root, member, "package.json"), "utf8")),
    close: async () => {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function gitSource(root: string) {
  const dir = join(root, ".fixture-home", "git-source");
  await mkdir(dir);
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "u6-git", version: "1.0.0", main: "index.js" }));
  await writeFile(join(dir, "index.js"), "module.exports=17;");
  for (const args of [
    ["init", "--initial-branch=main"],
    ["add", "."],
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"],
  ]) {
    const result = spawnSync("git", args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
    if (result.status !== 0) {
      throw new Error(result.stderr.toString());
    }
  }
  const info = spawnSync("git", ["update-server-info"], { cwd: dir });
  if (info.status !== 0) {
    throw new Error(info.stderr.toString());
  }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\/git-source.git\//, "");
      if (path.includes("..")) {
        return new Response("missing", { status: 404 });
      }
      const file = Bun.file(join(dir, ".git", path));
      return (await file.exists()) ? new Response(file) : new Response("missing", { status: 404 });
    },
  });
  return {
    url: `git+http://127.0.0.1:${server.port}/git-source.git`,
    close: async () => {
      server.stop(true);
    },
  };
}
