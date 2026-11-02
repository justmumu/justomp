import { constants, type Stats } from "node:fs";
import { access, lstat, mkdir, open, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import { runProcess } from "../dependencies/runner";

export interface SandboxRequest {
  command: string;
  cwd: string;
  protectedPaths: readonly string[];
  shell?: string;
  signal?: AbortSignal;
}
export interface SandboxCommand {
  argv: string[];
  env: NodeJS.ProcessEnv;
  /** Call only after the sandbox and its descendants have stopped. */
  cleanup(): Promise<void>;
}

function absolutePath(path: string): void {
  if (path.includes("\0")) {
    throw new Error("Sandbox paths cannot contain NUL");
  }
  if (!isAbsolute(path)) {
    throw new Error(`Sandbox path must be absolute: ${path}`);
  }
  if (normalize(path) !== path) {
    throw new Error(`Sandbox path must be normalized: ${path}`);
  }
}
export function sandboxPaths(paths: readonly string[]): string[] {
  for (const path of paths) {
    absolutePath(path);
  }
  return [...new Set(paths)].sort();
}
function parents(paths: readonly string[]): string[] {
  const entries = new Set<string>();
  for (const path of paths) {
    let parent = dirname(path);
    while (parent !== dirname(parent)) {
      entries.add(parent);
      parent = dirname(parent);
    }
  }
  return [...entries].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}
/** Only fixed flags and literal argv values are assembled; the workload stays one shell argument. */
export function buildSandboxArgv(platform: string, executable: string, request: SandboxRequest): string[] {
  absolutePath(request.cwd);
  const paths = sandboxPaths(request.protectedPaths);
  const shell = request.shell ?? "/bin/bash";
  absolutePath(shell);
  if (platform === "darwin") {
    const profile = [
      "(version 1)",
      "(allow default)",
      ...paths.map((path) => `(deny file-write* (subpath ${JSON.stringify(path)}))`),
      ...parents(paths).map((path) => `(deny file-write-unlink (literal ${JSON.stringify(path)}))`),
    ].join("\n");
    return [executable, "-p", profile, shell, "-c", request.command];
  }
  if (platform === "linux") {
    return [
      executable,
      "--unshare-user",
      "--unshare-pid",
      "--cap-drop",
      "ALL",
      "--new-session",
      "--die-with-parent",
      "--disable-userns",
      "--bind",
      "/",
      "/",
      ...parents(paths).flatMap((path) => ["--bind", path, path]),
      ...paths.flatMap((path) => ["--ro-bind", path, path]),
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--chdir",
      request.cwd,
      "--",
      shell,
      "-c",
      request.command,
    ];
  }
  throw new Error("File protection supports macOS and Linux only");
}

interface Placeholder {
  path: string;
  stat: Stats;
  owners: number;
}
interface Registry {
  placeholders: Map<string, Placeholder>;
  pending: Promise<void>;
}
const registryKey = Symbol.for("justomp.protection.placeholders.v1");
const host = globalThis as typeof globalThis & { [registryKey]?: Registry };
host[registryKey] ??= { placeholders: new Map(), pending: Promise.resolve() };
const registry = host[registryKey];
function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const pending = registry.pending.then(operation);
  registry.pending = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}
function sameNode(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode;
}
function unchanged(before: Stats, after: Stats): boolean {
  return (
    sameNode(before, after) &&
    (before.isDirectory() || (before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs))
  );
}
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
async function statOrMissing(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}
function checkTarget(path: string, stat: Stats): void {
  if (stat.isSymbolicLink()) {
    throw new Error(`Sandbox target must be canonical, not a symlink: ${path}`);
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error(`Unsupported sandbox target: ${path}`);
  }
  if (stat.isFile() && stat.nlink > 1) {
    throw new Error(`Cannot protect a hardlinked file: ${path}`);
  }
}
async function acquirePlaceholders(paths: string[], owned: Placeholder[]): Promise<void> {
  const directoryPaths = new Set(parents(paths));
  const entries = [...directoryPaths, ...paths];
  for (const path of [...new Set(entries)]) {
    let stat = await statOrMissing(path);
    if (stat) {
      checkTarget(path, stat);
      const prior = registry.placeholders.get(path);
      if (prior && unchanged(prior.stat, stat)) {
        prior.owners++;
        owned.push(prior);
      }
      continue;
    }
    try {
      if (!directoryPaths.has(path)) {
        const file = await open(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          stat = await file.stat();
        } finally {
          await file.close();
        }
      } else {
        await mkdir(path, { mode: 0o700 });
        stat = await lstat(path);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      checkTarget(path, await lstat(path));
      continue;
    }
    const entry = { path, stat, owners: 1 };
    registry.placeholders.set(path, entry);
    owned.push(entry);
  }
}
async function releasePlaceholders(owned: Placeholder[]): Promise<void> {
  const failures: unknown[] = [];
  for (const entry of [...owned].reverse()) {
    entry.owners--;
    if (entry.owners > 0) {
      continue;
    }
    if (registry.placeholders.get(entry.path) === entry) {
      registry.placeholders.delete(entry.path);
    }
    try {
      const current = await statOrMissing(entry.path);
      // Never remove a replacement, a touched file, or a file with real content.
      if (!current || !unchanged(entry.stat, current)) {
        continue;
      }
      if (current.isFile() && current.size === 0) {
        await unlink(entry.path);
      } else if (current.isDirectory()) {
        await rmdir(entry.path);
      }
    } catch (error) {
      if (!isMissing(error) && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") {
        failures.push(error);
      }
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, "Sandbox placeholder cleanup failed");
  }
}
const linuxChecks = new Map<string, Promise<void>>();
async function sandboxExecutable(signal?: AbortSignal): Promise<string> {
  if (process.platform === "darwin") {
    await access("/usr/bin/sandbox-exec", constants.X_OK);
    return "/usr/bin/sandbox-exec";
  }
  if (process.platform !== "linux") {
    throw new Error("File protection supports macOS and Linux only");
  }
  const executable = Bun.which("bwrap");
  if (!executable) {
    throw new Error("File protection requires bubblewrap (bwrap) on Linux");
  }
  let check = linuxChecks.get(executable);
  if (!check) {
    check = runProcess(executable, ["--help"], {
      cwd: "/",
      signal: AbortSignal.timeout(5000),
    }).then((result) => {
      if (result.exit_code !== 0 || !result.stdout.includes("--disable-userns")) {
        throw new Error("File protection requires bubblewrap with --disable-userns support (0.8 or later)");
      }
    });
    linuxChecks.set(executable, check);
    void check.catch(() => {
      if (linuxChecks.get(executable) === check) {
        linuxChecks.delete(executable);
      }
    });
  }
  await check;
  signal?.throwIfAborted();
  return executable;
}
/** Fresh per-call policy; no global unlock, network filter, restore, or fallback. */
export async function createSandboxCommand(request: SandboxRequest): Promise<SandboxCommand> {
  request.signal?.throwIfAborted();
  const paths = sandboxPaths(request.protectedPaths);
  absolutePath(request.cwd);
  const executable = await sandboxExecutable(request.signal);
  request.signal?.throwIfAborted();
  const owned: Placeholder[] = [];
  let released = false;
  const cleanup = () =>
    exclusive(async () => {
      if (released) {
        return;
      }
      released = true;
      await releasePlaceholders(owned);
    });
  try {
    if (process.platform === "linux") {
      await exclusive(() => acquirePlaceholders(paths, owned));
    } else {
      for (const path of paths) {
        const stat = await statOrMissing(path);
        if (stat) {
          checkTarget(path, stat);
        }
      }
    }
    request.signal?.throwIfAborted();
    return {
      argv: buildSandboxArgv(process.platform, executable, {
        ...request,
        protectedPaths: paths,
      }),
      env: { ...process.env },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
