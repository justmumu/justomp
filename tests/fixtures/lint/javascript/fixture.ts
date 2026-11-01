import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLintConfig } from "../../../../src/config/lint/resolve";
import type {
  PackagingStructure,
  Project,
} from "../../../../src/inspect/model";
import { javascriptAdapter } from "../../../../src/lint/adapters/javascript";
import type {
  LintOperationContext,
  ToolVersions,
} from "../../../../src/lint/adapters/types";
import {
  applyProjection,
  planProjection,
} from "../../../../src/lint/projection";
import { resolveLintTarget } from "../../../../src/lint/targets";
import { measureFixture } from "../../cost-timing";
import versions from "../../dependencies/manager-versions.json";

import { TOOLS } from "./versions";

export { TOOLS } from "./versions";
export type Manager = "npm" | "pnpm" | "yarn-classic" | "yarn-modern" | "bun";
export async function javascriptFixture(
  manager: Manager = "npm",
  flavor: "js" | "ts" | "react" | "next" = "js",
  workspace = false,
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "lint-javascript-")),
  );
  const nativeManager = manager.startsWith("yarn") ? "yarn" : manager;
  const pin = `${nativeManager}@${versions.managers[manager]}`;
  const paths = workspace ? [".", "packages/a", "packages/b"] : ["."];
  if (manager === "pnpm")
    await writeFile(
      join(root, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
  if (manager === "yarn-modern")
    await writeFile(
      join(root, ".yarnrc.yml"),
      "nodeLinker: pnp\npnpEnableEsmLoader: true\nenableGlobalCache: false\nenableTelemetry: false\n",
    );
  await writeFile(
    join(root, ".npmrc"),
    "audit=false\nfund=false\nmanage-package-manager-versions=false\n",
  );
  if (manager === "yarn-classic")
    await writeFile(
      join(root, ".yarnrc"),
      'registry "https://registry.npmjs.org"\n',
    );
  const projects: Project[] = [];
  for (const [index, path] of paths.entries()) {
    await mkdir(join(root, path), { recursive: true });
    await writeFile(
      join(root, path, "package.json"),
      JSON.stringify(
        {
          name: `lint-example-${index}`,
          version: "1.0.0",
          private: true,
          type: "module",
          ...(path === "."
            ? {
                packageManager: pin,
                ...(workspace ? { workspaces: ["packages/*"] } : {}),
              }
            : {}),
          ...(flavor !== "js"
            ? { devDependencies: { typescript: "7.0.2" } }
            : {}),
        },
        null,
        2,
      ),
    );
    if (flavor !== "js")
      await writeFile(
        join(root, path, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            module: "NodeNext",
            moduleResolution: "NodeNext",
            target: "ES2022",
            jsx: "react-jsx",
          },
          include: ["*.ts", "*.tsx"],
        }),
      );
    await writeFile(
      join(root, path, flavor === "js" ? "index.js" : "index.ts"),
      'console.warn("ready");\n',
    );
    projects.push({
      project_id: `javascript:${path}`,
      path,
      manifest: join(path, "package.json"),
      ecosystem: "javascript",
      name: `lint-example-${index}`,
      manager: nativeManager,
      managerRoot: ".",
      managerCandidates: [nativeManager],
      frameworks:
        flavor === "next"
          ? ["next", "react"]
          : flavor === "react"
            ? ["react"]
            : [],
      status: "detected",
      evidence: [],
      ...(workspace ? { workspace: `${nativeManager}:.` } : {}),
    });
  }
  const structure = { root, complete: true, projects } as PackagingStructure;
  const targets = await Promise.all(
    projects.map((project) => resolveLintTarget(structure, project.project_id)),
  );
  if (manager.startsWith("yarn")) {
    const launcher =
      process.env[
        manager === "yarn-modern"
          ? "JUSTOMP_YARN_MODERN_BINARY"
          : "JUSTOMP_YARN_CLASSIC_BINARY"
      ] ?? Bun.which("yarn");
    if (!launcher)
      throw new Error(`Provide an installed native ${manager} launcher`);
    const bin = join(root, ".justomp", "fixture-bin");
    await mkdir(bin, { recursive: true });
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(
      join(bin, "yarn"),
      `#!/bin/sh\nexec ${launcher.endsWith(".js") ? `${quote(Bun.which("node") ?? "node")} ` : ""}${quote(launcher)} "$@"\n`,
      { mode: 0o755 },
    );
    for (const target of targets)
      target.scope.env.PATH = `${bin}:${target.scope.env.PATH}`;
  }
  const tools: ToolVersions = { ...TOOLS };
  const policy = resolveLintConfig().policy,
    signal = new AbortController().signal;
  const context: LintOperationContext = {
    targets,
    policy,
    signal,
    versions: Object.fromEntries(
      projects.map((project) => [project.project_id, { ...tools }]),
    ),
    changes: [],
  };
  const checkContext = async (index = 0) => {
    const target = targets[index];
    if (!target) throw new Error("Missing fixture target");
    return {
      target,
      policy,
      signal,
      versions: context.versions[target.project.project_id] ?? {},
      projection: await planProjection(
        target,
        policy,
        context.versions[target.project.project_id],
      ),
    };
  };
  return {
    root,
    targets,
    context,
    checkContext,
    async project() {
      for (const target of targets)
        await applyProjection(
          await planProjection(
            target,
            policy,
            context.versions[target.project.project_id],
          ),
          context.changes,
        );
    },
    async prepare() {
      return measureFixture("lint.prepare", async () => {
        await javascriptAdapter.preflight(context);
        await javascriptAdapter.prepareBatch(context);
        for (const target of targets)
          await applyProjection(
            await planProjection(
              target,
              policy,
              context.versions[target.project.project_id],
            ),
            context.changes,
          );
      });
    },
    async bytes() {
      const result: Record<string, string> = {};
      async function walk(directory: string) {
        for (const item of await readdir(join(root, directory), {
          withFileTypes: true,
        })) {
          if (["node_modules", ".yarn", ".justomp", ".git"].includes(item.name))
            continue;
          const path = join(directory, item.name);
          if (item.isDirectory()) await walk(path);
          else if (item.isFile())
            result[path] = createHash("sha256")
              .update(await readFile(join(root, path)))
              .digest("hex");
        }
      }
      await walk("");
      return result;
    },
    dispose: () =>
      measureFixture("lint.cleanup", () =>
        rm(root, { recursive: true, force: true }),
      ),
  };
}
