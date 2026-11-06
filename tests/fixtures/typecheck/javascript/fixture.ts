import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveTypecheckConfig } from "../../../../src/config/typecheck/resolve";
import { javascriptAdapter } from "../../../../src/typecheck/adapters/javascript";
import { type TypecheckOperationContext } from "../../../../src/typecheck/adapters/types";
import { applyProjection } from "../../../../src/typecheck/projection";
import { type Manager, javascriptFixture as nativeFixture } from "../../lint/javascript/fixture";

export type { Manager } from "../../lint/javascript/fixture";
export const TYPESCRIPT = "7.0.2";
export async function javascriptFixture(manager: Manager = "npm", workspace = false) {
  const modernLauncher = process.env.JUSTOMP_TYPECHECK_YARN_MODERN_BINARY;
  if (manager === "yarn-modern" && !modernLauncher) {
    throw new Error("Provide JUSTOMP_TYPECHECK_YARN_MODERN_BINARY for the native Yarn4.18.1 typecheck fixture");
  }
  const native = await nativeFixture(manager, "js", workspace, true);
  if (manager === "yarn-modern") {
    const manifestPath = join(native.root, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.packageManager = "yarn@4.18.1";
    await writeFile(manifestPath, JSON.stringify(manifest));
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    if (!modernLauncher) {
      throw new Error("Missing modern Yarn launcher");
    }
    await writeFile(
      join(native.root, ".justomp/fixture-bin/yarn"),
      `#!/bin/sh\nexec ${quote(Bun.which("node") ?? "node")} ${quote(modernLauncher)} "$@"\n`,
      { mode: 0o755 },
    );
  }
  const policy = resolveTypecheckConfig().policy;
  const context: TypecheckOperationContext = {
    targets: native.targets,
    policy,
    signal: native.context.signal,
    changes: [],
    versions: Object.fromEntries(
      native.targets.map((target) => [target.project.project_id, { typescript: TYPESCRIPT }]),
    ),
  };
  const checkContext = async (index = 0) => {
    const target = native.targets[index];
    if (!target) {
      throw new Error("Missing fixture target");
    }
    return {
      target,
      policy,
      signal: context.signal,
      versions: context.versions[target.project.project_id] ?? {},
      projection: await javascriptAdapter.plan(target, policy, context.signal),
    };
  };
  const project = async () => {
    for (const target of context.targets) {
      await applyProjection(await javascriptAdapter.plan(target, policy, context.signal), context.changes);
    }
  };
  return {
    ...native,
    context,
    checkContext,
    project,
    async prepare() {
      await javascriptAdapter.preflight(context);
      await javascriptAdapter.prepareBatch(context);
      await project();
    },
  };
}
