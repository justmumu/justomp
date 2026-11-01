import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { within } from "../dependencies/paths";
import { withDomains } from "../dependencies/queue";
import { gitContext } from "../precommit/git";

export interface HookInstallation {
  status: "installed" | "ready" | "not-applicable" | "conflict";
  message: string;
}
interface HookRecord {
  version: 1;
  wrapper: string;
  original: string | null;
  originalMode: number;
  previousWrapper?: string;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
async function existing(
  path: string,
): Promise<{ text: string; mode: number } | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Hook path is not a regular file: ${path}`);
    return { text: await readFile(path, "utf8"), mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export async function installRepositoryHook(
  cwd: string,
  name: "pre-commit" | "pre-push",
  signal: AbortSignal | undefined,
  runtime: { bun: string; cli: string },
): Promise<HookInstallation> {
  const label = name === "pre-commit" ? "Pre-commit" : "Pre-push";
  const command =
    name === "pre-commit" ? "justomp-precommit" : "justomp-prepush";
  const context = await gitContext(cwd, signal);
  if (!context)
    return { status: "not-applicable", message: "No Git working tree" };
  return withDomains(
    [`justomp:hook-install:${context.commonDirectory}`],
    signal,
    async () => {
      try {
        signal?.throwIfAborted();
        const directory = context.hooks;
        if (
          resolve(directory) !== resolve(context.commonDirectory, "hooks") &&
          !within(context.root, resolve(directory))
        )
          throw new Error(
            `Externally managed core.hooksPath; integrate ${command} manually`,
          );
        await mkdir(directory, { recursive: true });
        if ((await realpath(directory)) !== resolve(directory))
          throw new Error(
            "Symlinked hook directory requires manual integration",
          );
        const hook = join(directory, name),
          backup = `${hook}.justomp-original`,
          recordPath = `${hook}.justomp.json`;
        const current = await existing(hook),
          stored = await existing(recordPath);
        let record: HookRecord;
        if (stored) {
          const parsed = JSON.parse(stored.text) as HookRecord;
          if (
            parsed.version !== 1 ||
            typeof parsed.wrapper !== "string" ||
            !(
              parsed.original === null || typeof parsed.original === "string"
            ) ||
            !Number.isInteger(parsed.originalMode)
          )
            throw new Error("Invalid Justomp hook ownership record");
          record = parsed;
          const original = await existing(backup);
          if (
            (original ? hash(original.text) : null) !== record.original ||
            (original && original.mode !== record.originalMode)
          )
            throw new Error(
              "Saved original hook changed; refusing to overwrite",
            );
          if (
            (current ? hash(current.text) : null) !== hash(record.wrapper) &&
            (current ? hash(current.text) : null) !== record.original &&
            current?.text !== record.previousWrapper
          )
            throw new Error(
              `${label} was edited outside Justomp; integrate changes manually`,
            );
        } else {
          const interruptedBackup = await existing(backup);
          if (
            interruptedBackup &&
            (interruptedBackup.text !== current?.text ||
              interruptedBackup.mode !== current?.mode)
          )
            throw new Error(
              "Unowned original-hook backup differs from current hook; inspect it before installation",
            );
          // Moving a self-locating/managed hook can change behavior. Only compose
          // plain shell hooks that do not inspect their own invocation path.
          if (
            current &&
            (!/^#!\s*\/(?:usr\/bin\/env\s+|bin\/)(?:sh|bash|zsh)(?:\s|$)/.test(
              current.text,
            ) ||
              /\$0|\$\{0\}|BASH_SOURCE|husky|lefthook|pre-commit hook|justomp-pre(?:commit|push)/.test(
                current.text,
              ))
          )
            throw new Error(
              "Existing managed or path-sensitive hook requires manual integration",
            );
          record = {
            version: 1,
            wrapper: "",
            original: current ? hash(current.text) : null,
            originalMode: current?.mode ?? 0,
          };
          if (current && !interruptedBackup) {
            await writeFile(backup, current.text, {
              flag: "wx",
              mode: current.mode,
            });
            await chmod(backup, current.mode);
          }
        }
        const wrapper = `#!/bin/sh\n# ${command}: owned launcher v1\n${record.original !== null && (record.originalMode & 0o111) ? `${quote(backup)} "$@" || exit $?\n` : ""}${name === "pre-push" ? "cat > /dev/null || exit $?\n" : ""}exec ${quote(await realpath(runtime.bun))} --no-install ${quote(await realpath(runtime.cli))}\n`;
        if (
          current?.text === wrapper &&
          (current.mode & 0o111) !== 0 &&
          stored &&
          record.wrapper === wrapper
        )
          return { status: "ready", message: `${label} already installed` };
        const temporary = `${hook}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, wrapper, { flag: "wx", mode: 0o755 });
          await chmod(temporary, 0o755);
          signal?.throwIfAborted();
          const latest = await existing(hook);
          if (latest?.text !== current?.text || latest?.mode !== current?.mode)
            throw new Error(`${label} changed during installation`);
          // Publish recovery metadata before the launcher. A retry recognizes the
          // preserved original as an unfinished install; no original is deleted.
          const recordTemp = `${recordPath}.${randomUUID()}.tmp`;
          try {
            await writeFile(
              recordTemp,
              `${JSON.stringify({ ...record, previousWrapper: record.wrapper || undefined, wrapper })}\n`,
              { flag: "wx", mode: 0o600 },
            );
            await rename(recordTemp, recordPath);
          } finally {
            await rm(recordTemp, { force: true });
          }
          await rename(temporary, hook);
        } finally {
          await rm(temporary, { force: true });
        }
        return {
          status: "installed",
          message: `Repository ${name} installed`,
        };
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        return {
          status: "conflict",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}
