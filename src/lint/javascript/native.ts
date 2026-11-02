import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { bunAdapter } from "../../dependencies/adapters/bun";
import { npmAdapter } from "../../dependencies/adapters/npm";
import { pnpmAdapter } from "../../dependencies/adapters/pnpm";
import { yarnClassicAdapter } from "../../dependencies/adapters/yarn-classic";
import { yarnModernAdapter } from "../../dependencies/adapters/yarn-modern";
import { type AdapterContext, type ProcessResult, redact } from "../../dependencies/model";
import { runProcess } from "../../dependencies/runner";
import { LintError } from "../model";
import { type LintTarget } from "../targets";

export function nativeAdapter(context: AdapterContext) {
  switch (context.manager) {
    case "npm":
      return npmAdapter;
    case "pnpm":
      return pnpmAdapter;
    case "bun":
      return bunAdapter;
    case "yarn":
      return context.version.startsWith("1.") ? yarnClassicAdapter : yarnModernAdapter;
    default:
      throw new LintError("unsupported-manager", `Unsupported JavaScript manager: ${context.manager}`);
  }
}
export function succeeded(result: ProcessResult) {
  return result.exit_code === 0 && !result.truncated && !result.cancelled;
}
export function assertNative(result: ProcessResult, label: string): void {
  if (!succeeded(result)) {
    throw new LintError(
      result.cancelled ? "cancelled" : "native-preparation-failed",
      redact(
        `${label}: ${result.stderr || `exit ${result.exit_code}`}${result.truncated ? " (output truncated)" : ""}`,
      ),
    );
  }
}
/** Resolve only package metadata, never execute package exports during preflight. */
const RESOLVE_PACKAGE = `
const fs = require('node:fs'), path = require('node:path');
const req = require('node:module').createRequire(path.join(process.cwd(), 'package.json'));
function pkg(name) {
 let file;
 try { file = req.resolve(name + '/package.json'); }
 catch {
   let dir = path.dirname(req.resolve(name));
   for (;;) {
     const candidate = path.join(dir, 'package.json');
     if (fs.existsSync(candidate) && JSON.parse(fs.readFileSync(candidate, 'utf8')).name === name) { file = candidate; break; }
     const parent = path.dirname(dir); if (parent === dir) throw new Error('Missing package metadata for ' + name); dir = parent;
   }
 }
 const local = JSON.parse(process.argv[1]).some(base => { const rel = path.relative(base, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); });
 if (process.argv[2] !== 'pnp' && !local) throw new Error('Package is not installed in the selected local environment: ' + name);
 const data = JSON.parse(fs.readFileSync(file, 'utf8')); return { file, data };
}
`;
function packageRoots(target: LintTarget, native: AdapterContext): string {
  return JSON.stringify([
    native.owner,
    ...(target.scope.pnpm?.virtualStoreDirectories ?? []),
    ...(target.scope.pnpm?.memberDirectories ?? []).map((directory) =>
      join(directory, target.scope.pnpm?.modulesDirectory ?? "node_modules"),
    ),
  ]);
}
async function hasYarnEnvironment(owner: string): Promise<boolean> {
  const found = await Promise.all(
    [".pnp.cjs", "node_modules"].map(async (name) => {
      try {
        await access(join(owner, name));
        return true;
      } catch {
        return false;
      }
    }),
  );
  return found.some(Boolean);
}
export async function nodeRun(
  target: LintTarget,
  native: AdapterContext,
  args: string[],
  signal: AbortSignal,
): Promise<ProcessResult> {
  if (
    native.manager === "yarn" &&
    !native.version.startsWith("1.") &&
    (args[0] !== "-p" || (await hasYarnEnvironment(native.owner)))
  ) {
    return native.run({
      args: ["node", ...args],
      label: "Run local Node tool",
      cwd: target.scope.cwd,
    });
  }
  const node = Bun.which("node", { PATH: target.scope.env.PATH });
  if (!node) {
    throw new LintError("runtime-unavailable", "Node is not installed; install a compatible runtime explicitly");
  }
  return runProcess(node, args, {
    cwd: target.scope.cwd,
    env: {
      ...target.scope.env,
      NODE_PATH:
        native.manager === "pnpm" && target.scope.pnpm
          ? [...new Set([native.cwd, native.owner])]
              .map((directory) => join(directory, target.scope.pnpm?.modulesDirectory ?? "node_modules"))
              .join(delimiter)
          : undefined,
    },
    signal,
  });
}
export async function installedPackages(
  target: LintTarget,
  native: AdapterContext,
  names: string[],
  signal: AbortSignal,
): Promise<Record<string, Record<string, unknown>>> {
  if (native.manager === "yarn" && !native.version.startsWith("1.")) {
    if (!(await hasYarnEnvironment(native.owner))) {
      return {};
    }
  }
  const result = await nodeRun(
    target,
    native,
    [
      "-e",
      `${RESOLVE_PACKAGE}\nconst result = {}; for (const name of process.argv.slice(3)) { try { result[name] = pkg(name).data; } catch {} } console.log(JSON.stringify(result));`,
      packageRoots(target, native),
      native.manager === "yarn" && !native.version.startsWith("1.") ? "pnp" : "local",
      ...names,
    ],
    signal,
  );
  assertNative(result, "Read installed package metadata");
  const line = result.stdout.split("\n").find((value) => value.startsWith("{"));
  return JSON.parse(line ?? "{}");
}
export async function localTool(
  target: LintTarget,
  native: AdapterContext,
  tool: { package: string; binary: string },
  args: string[],
  signal: AbortSignal,
) {
  return nodeRun(
    target,
    native,
    [
      "-e",
      `${RESOLVE_PACKAGE}\nconst name = process.argv[3], binary = process.argv[4]; if (name === '@biomejs/biome') { delete process.env.BIOME_BINARY; delete process.env.BIOME_CONFIG_PATH; delete process.env.BIOME_LOG_FILE; delete process.env.BIOME_LOG_LEVEL; } const {file, data} = pkg(name); const bin = typeof data.bin === 'string' ? data.bin : data.bin?.[binary]; if (!bin) throw new Error('Missing local binary for ' + name); const entry = path.resolve(path.dirname(file), bin); if (!fs.existsSync(entry)) throw new Error('Missing local binary for ' + name); process.argv = [process.execPath, entry, ...process.argv.slice(5)]; if (entry.endsWith('.cjs') || (data.type !== 'module' && !entry.endsWith('.mjs'))) require(entry); else import(require('node:url').pathToFileURL(entry).href);`,
      packageRoots(target, native),
      native.manager === "yarn" && !native.version.startsWith("1.") ? "pnp" : "local",
      tool.package,
      tool.binary,
      ...args,
    ],
    signal,
  );
}
