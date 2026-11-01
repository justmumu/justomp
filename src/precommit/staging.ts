import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { safePath } from "../dependencies/paths";
import { type GitContext, git, gitText } from "./git";

export function durableEffect(path: string): boolean {
  if (
    !path ||
    isAbsolute(path) ||
    path.split("/").some((p) => !p || p === ".." || p === ".")
  )
    throw new Error(`Invalid effect path: ${path}`);
  if (path === ".justomp/config.json") return true;
  return (
    !/(?:^|\/)(?:\.git|\.justomp|node_modules|bower_components|venv|\.venv|__pycache__|\.next|\.yarn|\.cache)(?:\/|$)/.test(
      path,
    ) && !/(?:^|\/)\.pnp\.(?:cjs|loader\.mjs)$/.test(path)
  );
}
async function identity(root: string, path: string): Promise<string | null> {
  const absolute = await safePath(root, path);
  try {
    const file = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await file.stat();
      if (!before.isFile())
        throw new Error(`Not a regular effect file: ${path}`);
      const hash = createHash("sha256")
        .update(await file.readFile())
        .digest("hex");
      const after = await file.stat(),
        current = await lstat(absolute);
      if (
        before.ino !== current.ino ||
        before.dev !== current.dev ||
        before.mtimeMs !== after.mtimeMs ||
        before.size !== after.size
      )
        throw new Error(`Effect changed while observing: ${path}`);
      return `${after.dev}:${after.ino}:${after.mode}:${hash}`;
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
/** Only service-reported effects enter this ledger, never every dirty repository file. */
export class EffectLedger {
  private readonly observed = new Map<string, string | null>();
  staged: string[] = [];
  constructor(private readonly context: GitContext) {}
  get paths(): string[] {
    return [...this.observed.keys()].sort();
  }
  async observe(paths: string[]): Promise<void> {
    for (const path of paths)
      if (durableEffect(path))
        this.observed.set(path, await identity(this.context.root, path));
  }
  async verify(): Promise<void> {
    for (const [path, expected] of this.observed)
      if ((await identity(this.context.root, path)) !== expected)
        throw new Error(`Concurrent file change: ${path}; retry commit`);
  }
  async stage(): Promise<string[]> {
    await this.verify();
    const tracked = new Set(
      (
        await gitText(
          this.context.root,
          ["ls-files", "--cached", "-z"],
          this.context.signal,
        )
      ).split("\0"),
    );
    const paths: string[] = [];
    for (const path of this.paths) {
      if (!tracked.has(path)) {
        if (this.observed.get(path) === null) continue;
        const ignored = await git(
          this.context.root,
          ["check-ignore", "--", path],
          this.context.signal,
        );
        if (
          ignored.cancelled ||
          ignored.truncated ||
          ![0, 1].includes(ignored.exit_code ?? -1)
        )
          throw new Error(`Could not check ignored effect: ${path}`);
        if (ignored.exit_code === 0) continue;
      }
      paths.push(path);
    }
    if (!paths.length) return [];
    const temporary = await mkdtemp(join(tmpdir(), "justomp-stage-"));
    try {
      const list = join(temporary, "paths");
      await writeFile(list, `${paths.join("\0")}\0`, { mode: 0o600 });
      // No force-add: ignored setup outputs must never silently become tracked files.
      await gitText(
        this.context.root,
        [
          "--literal-pathspecs",
          "add",
          `--pathspec-from-file=${list}`,
          "--pathspec-file-nul",
        ],
        this.context.signal,
      );
      this.staged = paths;
      await this.verify();
      return paths;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
