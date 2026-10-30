import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safePath } from "../dependencies/paths";
import { LintError } from "./model";

export interface FileSnapshot {
  text: string | null;
  identity: string | null;
  mode: number;
}
export async function readProjectionFile(
  root: string,
  path: string,
): Promise<FileSnapshot> {
  await safePath(root, path);
  try {
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile())
        throw new LintError(
          "projection-conflict",
          `Not a regular config file: ${path}`,
        );
      return {
        text: await file.readFile("utf8"),
        identity: `${stat.dev}:${stat.ino}`,
        mode: stat.mode,
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { text: null, identity: null, mode: 0o644 };
    throw error;
  }
}
/** Caller owns the manager lease. External writers are detected, not locked out. */
export async function publishProjectionFile(
  root: string,
  path: string,
  before: FileSnapshot,
  content: string,
): Promise<void> {
  const verify = async () => {
    const now = await readProjectionFile(root, path);
    if (now.identity !== before.identity || now.text !== before.text)
      throw new LintError(
        "projection-conflict",
        `Native config changed during preparation: ${path}`,
      );
  };
  await verify();
  const temporary = join(
    dirname(path),
    `.justomp-projection-${randomUUID()}.tmp`,
  );
  try {
    const file = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      before.mode & 0o777,
    );
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await verify();
    if (before.identity === null) {
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new LintError(
            "projection-conflict",
            `Native config changed during preparation: ${path}`,
          );
        throw error;
      }
    } else {
      const stat = await lstat(path);
      if (stat.isSymbolicLink())
        throw new LintError(
          "projection-conflict",
          `Native config changed during preparation: ${path}`,
        );
      await rename(temporary, path);
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}
