import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Adapter,
  AdapterContext,
  DependencyRequest,
} from "../../../../src/dependencies/model";
import { runProcess } from "../../../../src/dependencies/runner";
import { inspectProject } from "../../../../src/inspect/scan";
import managerVersions from "../../../fixtures/dependencies/manager-versions.json";
import { measuredVersion } from "../../../fixtures/dependencies/measured-version";
import { registryArchives } from "./registry-archives";

export async function fixture(manager: "npm" | "pnpm") {
  const expectedVersion = managerVersions.managers[manager];
  const root = await realpath(
    await mkdtemp(join(tmpdir(), `justomp-${manager}-`)),
  );
  const project = join(root, "project");
  await mkdir(project);
  const archives = await registryArchives("npm");
  let available = ["1.0.0"];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      const path = decodeURIComponent(new URL(request.url).pathname).slice(1);
      if (path.endsWith(".tgz"))
        return new Response(new Uint8Array(archives.get(path) ?? []), {
          status: archives.has(path) ? 200 : 404,
        });
      if (!["fixture-dep", "fixture-child"].includes(path))
        return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({
        name: path,
        "dist-tags": { latest: available.at(-1) },
        versions: Object.fromEntries(
          available.map((version) => {
            const archive = `${path}-${version}.tgz`;
            return [
              version,
              {
                name: path,
                version,
                ...(path === "fixture-dep"
                  ? { dependencies: { "fixture-child": "1.0.0" } }
                  : {}),
                dist: {
                  tarball: `${server.url}${archive}`,
                  shasum: createHash("sha1")
                    .update(archives.get(archive) as Uint8Array)
                    .digest("hex"),
                },
              },
            ];
          }),
        ),
      });
    },
  });
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({
      name: "fixture-app",
      private: true,
      version: "1.0.0",
      packageManager: `${manager}@${expectedVersion}`,
    }),
  );
  const config = `registry=${server.url}\ncache=${join(root, "cache")}\nstore-dir=${join(root, "store")}\naudit=false\nfund=false\nmanage-package-manager-versions=false\n`;
  await writeFile(join(project, ".npmrc"), config);
  await writeFile(join(root, "user.npmrc"), "");
  await writeFile(join(root, "global.npmrc"), "");
  await writeFile(join(root, "gitconfig"), "");
  const env = {
    ...process.env,
    CI: "true",
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_CONFIG_HOME: join(root, "config"),
    NPM_CONFIG_USERCONFIG: join(root, "user.npmrc"),
    NPM_CONFIG_GLOBALCONFIG: join(root, "global.npmrc"),
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    COREPACK_ENABLE_NETWORK: "0",
    npm_config_manage_package_manager_versions: "false",
  };
  const native = async (args: string[], cwd = project) =>
    runProcess(
      manager === "npm" ? "npm" : (process.env.JUSTOMP_PNPM_BINARY ?? "pnpm"),
      args,
      { cwd, env },
    );
  const detected = await native(["--version"]);
  let version: string;
  try {
    version = measuredVersion(manager, expectedVersion, detected);
  } catch (error) {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const context = async (path = "."): Promise<AdapterContext> => {
    const structure = await inspectProject({ root: project });
    const selected = structure.projects.find((p) => p.path === path);
    if (!selected) throw new Error(`Missing fixture project ${path}`);
    return {
      root: project,
      project: selected,
      structure,
      cwd: join(project, selected.path),
      owner: join(project, selected.managerRoot),
      manager,
      version,
      run: (step) =>
        native(step.args, step.cwd ?? join(project, selected.path)),
    };
  };
  return {
    root,
    project,
    native,
    context,
    publish: () => {
      available = ["1.0.0", "1.1.0", "2.0.0"];
    },
    manifest: async (path = ".") =>
      JSON.parse(await readFile(join(project, path, "package.json"), "utf8")),
    async operate(
      adapter: Adapter,
      request: DependencyRequest extends infer R
        ? R extends { operation: "list" }
          ? never
          : R extends DependencyRequest
            ? Omit<R, "project_id">
            : never
        : never,
      path = ".",
    ) {
      const ctx = await context(path);
      const before = await adapter.inventory(ctx, false);
      const full = {
        ...request,
        project_id: ctx.project.project_id,
      } as Exclude<DependencyRequest, { operation: "list" }>;
      const plan = await adapter.plan(ctx, full, before);
      const results = [];
      for (const step of plan.steps) {
        const result = await ctx.run(step);
        results.push(result);
        if (result.exit_code !== 0)
          throw new Error(`${step.label}: ${result.stderr}\n${result.stdout}`);
      }
      const after = await adapter.inventory(ctx, false);
      await adapter.verify?.(ctx, full, before, after);
      return { plan, before, after, results };
    },
    async close() {
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}
